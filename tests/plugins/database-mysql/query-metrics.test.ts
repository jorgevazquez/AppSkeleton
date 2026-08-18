import { Writable } from "node:stream";
import type { LogEvent } from "kysely";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../../src/core/logger.js";
import {
  createQueryMetricsRecorder,
  createSlowQueryLogger,
  DEFAULT_SLOW_QUERY_THRESHOLD_MS,
  REDACTED_PARAMETER_PLACEHOLDER,
} from "../../../src/plugins/database-mysql/src/query-metrics.js";

/**
 * A fake Kysely `LogEvent` for pure unit tests — see
 * `query-capability.test.ts`'s identical helper for why this casts rather
 * than fully implementing `CompiledQuery`'s internal shape.
 */
function fakeLogEvent(options: {
  durationMs: number;
  parameters?: readonly unknown[];
  error?: unknown;
}): LogEvent {
  const { durationMs, parameters = ["Ada Lovelace", "secret-note"], error } = options;
  return {
    level: error !== undefined ? "error" : "query",
    error,
    query: { sql: "select * from users where name = ? and note = ?", parameters },
    queryDurationMillis: durationMs,
  } as unknown as LogEvent;
}

/** In-memory sink for a pino logger's raw ndjson output — mirrors logger.test.ts's own helper. */
function createCapturingStream() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: (): Record<string, unknown>[] =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("createQueryMetricsRecorder — basic query performance counters (feature #26)", () => {
  it("starts at an all-zero snapshot", () => {
    const recorder = createQueryMetricsRecorder();
    expect(recorder.snapshot()).toEqual({ queryCount: 0, errorCount: 0, averageDurationMs: 0 });
  });

  it("counts every recorded event toward queryCount, regardless of level", () => {
    const recorder = createQueryMetricsRecorder();
    recorder.record(fakeLogEvent({ durationMs: 5 }));
    recorder.record(fakeLogEvent({ durationMs: 5, error: new Error("boom") }));
    recorder.record(fakeLogEvent({ durationMs: 5 }));

    expect(recorder.snapshot().queryCount).toBe(3);
  });

  it("counts only 'error'-level events toward errorCount", () => {
    const recorder = createQueryMetricsRecorder();
    recorder.record(fakeLogEvent({ durationMs: 5 }));
    recorder.record(fakeLogEvent({ durationMs: 5, error: new Error("boom") }));

    expect(recorder.snapshot().errorCount).toBe(1);
  });

  it("computes the mean queryDurationMillis across all recorded events", () => {
    const recorder = createQueryMetricsRecorder();
    recorder.record(fakeLogEvent({ durationMs: 10 }));
    recorder.record(fakeLogEvent({ durationMs: 20 }));
    recorder.record(fakeLogEvent({ durationMs: 30 }));

    expect(recorder.snapshot().averageDurationMs).toBe(20);
  });
});

describe("createSlowQueryLogger — slow query logging with parameters redacted (feature #26)", () => {
  it("does not log a query whose duration is below the threshold", () => {
    const { stream, lines } = createCapturingStream();
    const logger = createLogger({ stream, level: "trace" });
    const log = createSlowQueryLogger({ logger, thresholdMs: 100 });

    log(fakeLogEvent({ durationMs: 50 }));

    expect(lines()).toEqual([]);
  });

  it("logs a query whose duration meets or exceeds the threshold", () => {
    const { stream, lines } = createCapturingStream();
    const logger = createLogger({ stream, level: "trace" });
    const log = createSlowQueryLogger({ logger, thresholdMs: 100 });

    log(fakeLogEvent({ durationMs: 100 }));

    expect(lines()).toHaveLength(1);
    expect(lines()[0]?.msg).toBe("slow query detected");
  });

  it("includes the compiled SQL text but redacts every bound parameter value", () => {
    const { stream, lines } = createCapturingStream();
    const logger = createLogger({ stream, level: "trace" });
    const log = createSlowQueryLogger({ logger, thresholdMs: 10 });

    log(fakeLogEvent({ durationMs: 250, parameters: ["Ada Lovelace", "s3cr3t-note"] }));

    const [line] = lines();
    expect(line?.sql).toBe("select * from users where name = ? and note = ?");
    expect(line?.parameters).toEqual([
      REDACTED_PARAMETER_PLACEHOLDER,
      REDACTED_PARAMETER_PLACEHOLDER,
    ]);
    // The raw bound values must never reach the emitted line, in any field.
    const raw = JSON.stringify(line);
    expect(raw).not.toContain("Ada Lovelace");
    expect(raw).not.toContain("s3cr3t-note");
  });

  it("logs a slow *failed* query at 'slow query failed' with the error message included", () => {
    const { stream, lines } = createCapturingStream();
    const logger = createLogger({ stream, level: "trace" });
    const log = createSlowQueryLogger({ logger, thresholdMs: 10 });

    log(fakeLogEvent({ durationMs: 500, error: new Error("ER_LOCK_WAIT_TIMEOUT") }));

    const [line] = lines();
    expect(line?.msg).toBe("slow query failed");
    expect(line?.error).toBe("ER_LOCK_WAIT_TIMEOUT");
  });

  it("uses DEFAULT_SLOW_QUERY_THRESHOLD_MS when thresholdMs is omitted", () => {
    const { stream, lines } = createCapturingStream();
    const logger = createLogger({ stream, level: "trace" });
    const log = createSlowQueryLogger({ logger });

    log(fakeLogEvent({ durationMs: DEFAULT_SLOW_QUERY_THRESHOLD_MS - 1 }));
    log(fakeLogEvent({ durationMs: DEFAULT_SLOW_QUERY_THRESHOLD_MS }));

    expect(lines()).toHaveLength(1);
  });

  it("feeds every event (slow or not) into the supplied metrics recorder", () => {
    const { stream } = createCapturingStream();
    const logger = createLogger({ stream, level: "trace" });
    const metrics = createQueryMetricsRecorder();
    const log = createSlowQueryLogger({ logger, thresholdMs: 1000, metrics });

    log(fakeLogEvent({ durationMs: 5 }));
    log(fakeLogEvent({ durationMs: 5, error: new Error("boom") }));

    expect(metrics.snapshot()).toEqual({ queryCount: 2, errorCount: 1, averageDurationMs: 5 });
  });

  it("never throws even if the logger call itself throws — a broken sink must never fail the real query it observed", () => {
    const throwingLogger = {
      warn: () => {
        throw new Error("sink is down");
      },
    } as unknown as ReturnType<typeof createLogger>;
    const log = createSlowQueryLogger({ logger: throwingLogger, thresholdMs: 10 });

    expect(() => log(fakeLogEvent({ durationMs: 999 }))).not.toThrow();
  });
});

import { Kysely, type LogEvent } from "kysely";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "mysql2/promise";
import { DatabaseError, ValidationError } from "../../../src/core/errors.js";
import type { Database } from "../../../src/plugins/database-mysql/src/db.js";
import { createDbQueryCapability } from "../../../src/plugins/database-mysql/src/query-capability.js";
import { createQueryMetricsRecorder } from "../../../src/plugins/database-mysql/src/query-metrics.js";

/**
 * A fake Kysely `LogEvent` for pure unit tests — real events are built by
 * Kysely internals from a full `CompiledQuery` (see
 * `kysely/dist/query-compiler/compiled-query.d.ts`), which is far more than
 * `QueryMetricsRecorder.record()`/`createSlowQueryLogger()` actually read
 * (`sql`, `parameters`, `queryDurationMillis`, `level`, and `error` for the
 * error case). Cast rather than fully implementing `CompiledQuery`'s
 * internal `RootOperationNode`/`QueryId` shape, which nothing under test
 * touches.
 */
function fakeLogEvent(options: { durationMs: number; error?: unknown }): LogEvent {
  const { durationMs, error } = options;
  return {
    level: error !== undefined ? "error" : "query",
    error,
    query: { sql: "select 1", parameters: [] },
    queryDurationMillis: durationMs,
  } as unknown as LogEvent;
}

/**
 * A fake `Kysely<Database>` for pure unit tests: `createDbQueryCapability()`
 * never calls anything on the instance itself — it only ever hands the
 * instance, opaque, to the caller's `fn` — so a typed empty object stands in
 * fine here. Real query execution against a real `Kysely<Database>` is
 * covered by db.test.ts (construction) and
 * query-capability.integration.test.ts (execution against real MySQL).
 */
const FAKE_DB = {} as Kysely<Database>;

describe("createDbQueryCapability — db:query capability object", () => {
  it("invokes fn with the underlying Kysely<Database> instance and returns its result", async () => {
    const capability = createDbQueryCapability(FAKE_DB);
    const fn = vi.fn(async (db: Kysely<Database>) => {
      expect(db).toBe(FAKE_DB);
      return "rows" as const;
    });

    await expect(capability.query(fn)).resolves.toBe("rows");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(FAKE_DB);
  });

  it("exposes only `query`, `healthCheck`, `getMetrics`, and `getPoolMetrics` — no `query(sql, params)` string-accepting overload", () => {
    const capability = createDbQueryCapability(FAKE_DB);
    // healthCheck (feature #24), getMetrics (feature #26), and
    // getPoolMetrics (feature #30) are the only other public members — see
    // this file's "healthCheck (feature #24)", "getMetrics (feature #26)",
    // and "getPoolMetrics (feature #30)" describe blocks below. None of
    // them accept a raw SQL string either (all three take no arguments at
    // all), so none reopens the "no raw interpolated SQL" gap this test
    // guards.
    expect(Object.keys(capability).sort()).toEqual([
      "getMetrics",
      "getPoolMetrics",
      "healthCheck",
      "query",
    ]);
    expect(typeof capability.query).toBe("function");
    // The one and only public method takes exactly one argument (`fn`) —
    // there is no second `params`/`sql` parameter slot to smuggle a raw
    // string through.
    expect(capability.query.length).toBe(1);
  });

  it("normalizes a plain error thrown by fn into a DatabaseError", async () => {
    const capability = createDbQueryCapability(FAKE_DB);
    const driverError = new Error("ER_PARSE_ERROR: You have an error in your SQL syntax");

    const promise = capability.query(async () => {
      throw driverError;
    });

    await expect(promise).rejects.toBeInstanceOf(DatabaseError);
    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining("ER_PARSE_ERROR") as unknown as string,
      cause: driverError,
    });
  });

  it("does not leak driver-level detail through the normalized error's public message", async () => {
    const capability = createDbQueryCapability(FAKE_DB);

    try {
      await capability.query(async () => {
        throw new Error("ER_ACCESS_DENIED_ERROR for user 'appskeleton'@'%'");
      });
      expect.fail("expected capability.query to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseError);
      const dbError = error as DatabaseError;
      expect(dbError.publicMessage).not.toContain("ER_ACCESS_DENIED_ERROR");
      expect(dbError.publicMessage).not.toContain("appskeleton");
    }
  });

  it("passes an already-AppError thrown by fn through unchanged (no double-wrapping)", async () => {
    const capability = createDbQueryCapability(FAKE_DB);
    const original = new ValidationError("row failed a business-rule check inside fn");

    const promise = capability.query(async () => {
      throw original;
    });

    await expect(promise).rejects.toBe(original);
  });

  it("propagates fn's resolved value type-faithfully for non-string results", async () => {
    const capability = createDbQueryCapability(FAKE_DB);
    const rows = [{ id: 1 }, { id: 2 }];

    await expect(capability.query(async () => rows)).resolves.toEqual(rows);
  });
});

describe("createDbQueryCapability — connection resilience (feature #23)", () => {
  function connectionRefusedError(): Error & { code: string } {
    const error = new Error("connect ECONNREFUSED 127.0.0.1:3306") as Error & { code: string };
    error.code = "ECONNREFUSED";
    return error;
  }

  it("retries fn with backoff after a transient connection error, then resolves once it recovers", async () => {
    const sleep = vi.fn(async () => undefined);
    const capability = createDbQueryCapability(FAKE_DB, { retry: { sleep, jitter: false } });
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      // Simulates the database being temporarily unreachable mid-session
      // (e.g. a brief network blip) before it recovers.
      if (attempts <= 2) {
        throw connectionRefusedError();
      }
      return "rows";
    });

    await expect(capability.query(fn)).resolves.toBe("rows");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-connection driver error (e.g. a query syntax error)", async () => {
    const sleep = vi.fn(async () => undefined);
    const capability = createDbQueryCapability(FAKE_DB, { retry: { sleep } });
    const fn = vi.fn(async () => {
      throw new Error("ER_PARSE_ERROR: You have an error in your SQL syntax");
    });

    await expect(capability.query(fn)).rejects.toBeInstanceOf(DatabaseError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up and returns a DatabaseError (not the raw driver exception) once retries are exhausted", async () => {
    const sleep = vi.fn(async () => undefined);
    const capability = createDbQueryCapability(FAKE_DB, { retry: { retries: 2, sleep } });
    const refused = connectionRefusedError();
    const fn = vi.fn(async () => {
      throw refused;
    });

    const promise = capability.query(fn);
    await expect(promise).rejects.toBeInstanceOf(DatabaseError);
    await expect(promise).rejects.not.toBe(refused);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('normalizes mysql2\'s "Queue limit reached." pool-exhaustion error into a distinct, safe DatabaseError', async () => {
    const capability = createDbQueryCapability(FAKE_DB);
    const fn = vi.fn(async () => {
      throw new Error("Queue limit reached.");
    });

    const promise = capability.query(fn);
    await expect(promise).rejects.toBeInstanceOf(DatabaseError);
    await expect(promise).rejects.toMatchObject({
      details: { reason: "pool_exhausted" },
    });
    const error = (await promise.catch((caught: unknown) => caught)) as DatabaseError;
    expect(error.publicMessage).not.toContain("Queue limit reached");
    // Pool exhaustion is a capacity problem, not a transient network blip —
    // it must never be silently retried.
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("createDbQueryCapability — healthCheck (feature #24)", () => {
  it("takes no arguments", () => {
    const capability = createDbQueryCapability(FAKE_DB);
    expect(typeof capability.healthCheck).toBe("function");
    expect(capability.healthCheck.length).toBe(0);
  });

  it("reports unhealthy (never rejects) when running SELECT 1 against the database fails", async () => {
    // FAKE_DB is a bare `{}` standing in for `Kysely<Database>` — it has none
    // of Kysely's real internals, so `sql\`SELECT 1\`.execute(db)` fails
    // immediately, the same shape of failure a genuinely unreachable MySQL
    // server would produce. healthCheck() must catch this itself and resolve
    // `{ healthy: false, error }` rather than letting the rejection escape.
    const capability = createDbQueryCapability(FAKE_DB);

    await expect(capability.healthCheck()).resolves.toEqual({
      healthy: false,
      error: expect.any(String) as unknown as string,
    });
  });

  it("does not go through retryWithBackoff — a failing check resolves immediately with no sleep", async () => {
    const sleep = vi.fn(async () => undefined);
    const capability = createDbQueryCapability(FAKE_DB, { retry: { sleep, retries: 4 } });

    await capability.healthCheck();

    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("createDbQueryCapability — getMetrics (feature #26)", () => {
  it("takes no arguments and returns an all-zero snapshot when no recorder is wired in", () => {
    const capability = createDbQueryCapability(FAKE_DB);
    expect(typeof capability.getMetrics).toBe("function");
    expect(capability.getMetrics.length).toBe(0);
    expect(capability.getMetrics()).toEqual({
      queryCount: 0,
      errorCount: 0,
      averageDurationMs: 0,
    });
  });

  it("proxies to the shared recorder passed in via options.metrics, reflecting events recorded elsewhere", () => {
    const metrics = createQueryMetricsRecorder();
    const capability = createDbQueryCapability(FAKE_DB, { metrics });

    // Simulates db.ts's Kysely `log` hook (see query-metrics.ts) feeding
    // real query events into the same recorder instance — getMetrics()
    // must reflect that shared state, not a private copy of its own.
    metrics.record(fakeLogEvent({ durationMs: 12 }));
    metrics.record(fakeLogEvent({ durationMs: 8, error: new Error("boom") }));

    expect(capability.getMetrics()).toEqual({
      queryCount: 2,
      errorCount: 1,
      averageDurationMs: 10,
    });
  });
});

describe("createDbQueryCapability — getPoolMetrics (feature #30)", () => {
  /** A fake mysql2 `Pool` — same shape pool-metrics.test.ts's own `fakePool()` builds. */
  function fakePool(counts: { all?: number; free?: number; queued?: number }): Pool {
    const { all = 0, free = 0, queued = 0 } = counts;
    return {
      pool: {
        _allConnections: { length: all },
        _freeConnections: { length: free },
        _connectionQueue: { length: queued },
      },
    } as unknown as Pool;
  }

  it("takes no arguments and returns an all-zero snapshot when no pool is wired in", () => {
    const capability = createDbQueryCapability(FAKE_DB);
    expect(typeof capability.getPoolMetrics).toBe("function");
    expect(capability.getPoolMetrics.length).toBe(0);
    expect(capability.getPoolMetrics()).toEqual({ active: 0, idle: 0, queued: 0 });
  });

  it("reads live active/idle/queued counts off the pool instance passed in via options.pool", () => {
    const pool = fakePool({ all: 5, free: 2, queued: 3 });
    const capability = createDbQueryCapability(FAKE_DB, { pool });

    expect(capability.getPoolMetrics()).toEqual({ active: 3, idle: 2, queued: 3 });
  });

  it("reflects the pool's *current* state on every call, not a snapshot frozen at construction time", async () => {
    // Simulates a concurrent burst of queries checking connections out and
    // back in over time — getPoolMetrics() has no internal cache of its
    // own, so successive calls against the same pool must track it live.
    const pool = fakePool({ all: 3, free: 3, queued: 0 });
    const capability = createDbQueryCapability(FAKE_DB, { pool });
    expect(capability.getPoolMetrics()).toEqual({ active: 0, idle: 3, queued: 0 });

    // Mid-burst: every connection checked out, two more callers queued.
    (
      pool as unknown as { pool: { _freeConnections: { length: number } } }
    ).pool._freeConnections.length = 0;
    (
      pool as unknown as { pool: { _connectionQueue: { length: number } } }
    ).pool._connectionQueue.length = 2;
    expect(capability.getPoolMetrics()).toEqual({ active: 3, idle: 0, queued: 2 });

    // Burst drained: connections released back to idle, queue empty again.
    (
      pool as unknown as { pool: { _freeConnections: { length: number } } }
    ).pool._freeConnections.length = 3;
    (
      pool as unknown as { pool: { _connectionQueue: { length: number } } }
    ).pool._connectionQueue.length = 0;
    expect(capability.getPoolMetrics()).toEqual({ active: 0, idle: 3, queued: 0 });
  });
});

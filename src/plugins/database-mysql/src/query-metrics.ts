/**
 * Slow query logging and basic query performance metrics for the `db:query`
 * capability (feature #26 — "Slow query logging and basic query
 * performance metrics").
 *
 * Instrumentation lives at the Kysely level (see `db.ts`'s
 * `createKyselyDb()`), not inside `query-capability.ts`'s `query()`
 * wrapper, because Kysely's own `log` hook (see
 * `kysely/dist/util/log.d.ts`) is the only place that sees each individual
 * compiled statement's SQL text, bound parameters, and wall-clock duration
 * — `query()`'s `fn` callback is an opaque function that may run any
 * number of Kysely queries against the shared `Kysely<Database>` instance,
 * so it has none of that detail to work with. {@link createSlowQueryLogger}
 * builds the function `createKyselyDb()`'s caller passes as `log`; every
 * plugin using that same shared instance (db:query, db:transaction,
 * migrate.ts, seed.ts, ...) is instrumented identically, for free.
 *
 * ## Threshold and redaction (step 1)
 *
 * A query is logged only once its `queryDurationMillis` reaches the
 * caller-supplied `thresholdMs` (see `config.ts`'s
 * `DB_SLOW_QUERY_THRESHOLD_MS`, defaulted but operator-configurable — "a
 * configurable duration threshold"). The logged line always includes the
 * compiled SQL text (parameterized, never containing a literal bound
 * value — see query-capability.ts's own docs on that guarantee) but never
 * the actual bound parameter *values*: {@link redactQueryParameters}
 * replaces every element of `query.parameters` with a fixed placeholder
 * before it ever reaches `logger.warn()`, so a slow-query line can never
 * leak a password, PII, or any other sensitive value a caller happened to
 * bind into the query — only how many parameters there were. This is a
 * second, independent layer of protection on top of `logger.ts`'s own
 * key-name-based redaction, which cannot help here: query parameters are a
 * plain positional array, not named object fields.
 *
 * ## Counters (step 2)
 *
 * {@link createQueryMetricsRecorder} tracks the three basic counters this
 * feature asks for — query count, error count, average duration — across
 * *every* query, not just the slow ones, so `db:query`'s
 * `getMetrics()` (see query-capability.ts) and `core/introspect.ts`'s
 * kernel introspection report a true average rather than one skewed toward
 * only-ever-logged outliers. Kysely fires exactly one event per statement
 * (`level: "query"` on success, `level: "error"` on failure — never
 * both, see `kysely/dist/driver/runtime-driver.js`'s `#addLogging()`), so
 * {@link QueryMetricsRecorder.record} increments `errorCount` only for the
 * `"error"` level while `queryCount` and the running duration total count
 * every event regardless of level.
 */
import type { LogEvent } from "kysely";
import type { Logger } from "../../../core/logger.js";

/** A `db:query` capability's basic performance counters — see this module's "Counters" docs. */
export interface QueryMetricsSnapshot {
  /** Every query Kysely reported (success or failure) since this recorder was created. */
  readonly queryCount: number;
  /** The subset of `queryCount` that failed (a Kysely `"error"` log event). */
  readonly errorCount: number;
  /** Mean `queryDurationMillis` across every recorded query. `0` when `queryCount` is `0`. */
  readonly averageDurationMs: number;
}

/** Accumulates {@link QueryMetricsSnapshot} counters from a stream of Kysely `LogEvent`s. */
export interface QueryMetricsRecorder {
  /** Fold one Kysely `LogEvent` (success or error) into the running counters. */
  record(event: LogEvent): void;
  /** The counters accumulated so far. Never throws; `queryCount: 0` until the first query runs. */
  snapshot(): QueryMetricsSnapshot;
}

/** Build a fresh, zeroed {@link QueryMetricsRecorder}. Purely in-memory — nothing here talks to the database or disk. */
export function createQueryMetricsRecorder(): QueryMetricsRecorder {
  let queryCount = 0;
  let errorCount = 0;
  let totalDurationMs = 0;

  return {
    record(event: LogEvent): void {
      queryCount += 1;
      totalDurationMs += event.queryDurationMillis;
      if (event.level === "error") {
        errorCount += 1;
      }
    },
    snapshot(): QueryMetricsSnapshot {
      return {
        queryCount,
        errorCount,
        averageDurationMs: queryCount === 0 ? 0 : totalDurationMs / queryCount,
      };
    },
  };
}

/** Placeholder substituted for every bound query parameter value in a slow-query log line — see this module's "Threshold and redaction" docs. */
export const REDACTED_PARAMETER_PLACEHOLDER = "[REDACTED]";

/** Replace every bound parameter value with {@link REDACTED_PARAMETER_PLACEHOLDER}, preserving only the count. */
function redactQueryParameters(parameters: readonly unknown[]): readonly string[] {
  return parameters.map(() => REDACTED_PARAMETER_PLACEHOLDER);
}

/** Human-readable detail from an unknown thrown value — mirrors query-capability.ts's own `describeError`. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Applied whenever `options.thresholdMs` is omitted — mirrors
 * `config.ts`'s `DB_SLOW_QUERY_THRESHOLD_MS` being optional-and-unset by
 * default (see that field's docs for why the config schema itself doesn't
 * carry the default). Generous enough that a normal, well-indexed query
 * never trips it, low enough to surface a genuinely slow one without any
 * operator configuration at all.
 */
export const DEFAULT_SLOW_QUERY_THRESHOLD_MS = 200;

export interface CreateSlowQueryLoggerOptions {
  /** Where slow-query lines are written. Typically a plugin-scoped logger (see `core/logger.ts`'s `createLogger()`/`withContext()`). */
  logger: Logger;
  /** Minimum `queryDurationMillis` (inclusive) that triggers a logged line — see `config.ts`'s `DB_SLOW_QUERY_THRESHOLD_MS`. Defaults to {@link DEFAULT_SLOW_QUERY_THRESHOLD_MS} when omitted. */
  thresholdMs?: number;
  /** Optional recorder to also feed every query (not just slow ones) into — see this module's "Counters" docs. */
  metrics?: QueryMetricsRecorder;
}

/**
 * Build the function to pass as `createKyselyDb()`'s `log` option: records
 * every query into `metrics` (if supplied) and, for any single query whose
 * `queryDurationMillis` is `>= thresholdMs`, emits one `logger.warn()` line
 * with the compiled SQL text and redacted parameters (see this module's
 * "Threshold and redaction" docs). Never throws — a logging/metrics side
 * effect must never be able to fail a real query.
 */
export function createSlowQueryLogger(
  options: CreateSlowQueryLoggerOptions,
): (event: LogEvent) => void {
  const { logger, metrics, thresholdMs = DEFAULT_SLOW_QUERY_THRESHOLD_MS } = options;

  return (event: LogEvent): void => {
    // Kysely awaits this function from inside the `finally` block of every
    // query it runs (see `kysely/dist/driver/runtime-driver.js`'s
    // `#addLogging()`) — a rejection/throw here would replace an otherwise
    // successful query's result with this side effect's own failure. Every
    // step is therefore wrapped, not just the logger call.
    try {
      metrics?.record(event);

      if (event.queryDurationMillis < thresholdMs) {
        return;
      }

      const fields = {
        sql: event.query.sql,
        parameters: redactQueryParameters(event.query.parameters),
        durationMs: event.queryDurationMillis,
        thresholdMs,
        ...(event.level === "error" ? { error: describeError(event.error) } : {}),
      };
      logger.warn(fields, event.level === "error" ? "slow query failed" : "slow query detected");
    } catch {
      // Never let an instrumentation failure (a full log sink, a broken
      // custom logger, ...) take down the real query it was observing.
    }
  };
}

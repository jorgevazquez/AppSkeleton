/**
 * Connection resilience helpers for the database-mysql plugin (feature #23
 * — "Connection resilience: retry with backoff and pool exhaustion
 * handling").
 *
 * Two independent concerns live here:
 *
 *   1. {@link retryWithBackoff} — a generic exponential-backoff retry loop,
 *      used both at startup (`pool.ts`'s `connectWithRetry()`, for the
 *      initial "can we even reach MySQL" probe) and mid-session
 *      (`query-capability.ts`/`transaction-capability.ts` wrap their `fn`
 *      call with it) to survive a *transient* connection failure — the
 *      MySQL server being restarted, a brief network blip, Docker still
 *      warming up — without the caller having to hand-roll a retry loop.
 *   2. {@link isPoolExhaustedError} — a classifier that recognizes when a
 *      failure came from the connection pool itself refusing to hand out a
 *      connection (its wait queue is full, or the MySQL server rejected the
 *      connection for having too many clients already) rather than from a
 *      query or the network. This is NOT retried automatically here — pool
 *      exhaustion is a capacity problem retrying immediately would only
 *      make worse — it is instead classified so callers can translate it
 *      into a distinct, safe `DatabaseError` (see query-capability.ts /
 *      transaction-capability.ts) instead of retrying blindly or leaking
 *      mysql2's raw "Queue limit reached." string to a capability consumer.
 *
 * ## Scope boundary: what "retry" means here
 *
 * `retryWithBackoff()` only retries when {@link isTransientConnectionError}
 * (or a caller-supplied `shouldRetry`) says the failure looks like the
 * operation never reached the server — a refused/reset/timed-out TCP
 * connection, DNS failure, or mysql2's own "the connection was lost"
 * signal. It deliberately does NOT retry on a generic driver/query error
 * (syntax error, constraint violation, deadlock, access denied, ...),
 * since those mean the server *did* respond and blindly re-running the
 * caller's `fn` could re-execute a write that already partially applied.
 * Callers wrapping an arbitrary `fn` (query-capability.ts,
 * transaction-capability.ts) inherit this same boundary — see their own
 * doc comments for how each capability applies it.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "../../../core/logger.js";

/**
 * Node/mysql2 error codes that indicate the failure happened while trying
 * to establish or maintain a connection — never while a query was being
 * evaluated by the server — and are therefore safe to retry.
 */
const TRANSIENT_CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "EAI_AGAIN",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_SEQUENCE_TIMEOUT",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
]);

/**
 * mysql2's connection pool (`node_modules/mysql2/lib/base/pool.js`) throws
 * plain, code-less `Error`s with these exact messages when it refuses to
 * hand out a connection because it is full: `"Queue limit reached."` when
 * `queueLimit` is configured and the wait queue is already at capacity, and
 * `"No connections available."` when `waitForConnections` is disabled and
 * every connection is already checked out. Matched by message text since
 * mysql2 does not attach a `.code` to either.
 */
const POOL_EXHAUSTED_MESSAGES = ["Queue limit reached.", "No connections available."];

/** MySQL server error indicating the server itself has hit `max_connections` — a capacity problem, not a driver bug. */
const POOL_EXHAUSTED_CODES = new Set(["ER_CON_COUNT_ERROR"]);

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when `error` looks like a transient connection failure safe to retry (see this module's doc comment). */
export function isTransientConnectionError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && TRANSIENT_CONNECTION_ERROR_CODES.has(code);
}

/** True when `error` came from the connection pool (or MySQL server) refusing a connection because it is at capacity. */
export function isPoolExhaustedError(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== undefined && POOL_EXHAUSTED_CODES.has(code)) {
    return true;
  }
  const message = errorMessage(error);
  return POOL_EXHAUSTED_MESSAGES.some((candidate) => message.includes(candidate));
}

export interface RetryOptions {
  /** Total attempts, including the first (non-retry) one. Default 4. */
  retries?: number;
  /** Delay before the first retry, in milliseconds. Default 100. */
  initialDelayMs?: number;
  /** Upper bound any computed delay is capped to, in milliseconds. Default 2000. */
  maxDelayMs?: number;
  /** Multiplier applied to the delay after each retry. Default 2 (doubling). */
  factor?: number;
  /** Randomize each delay within `[0, cappedDelay)` to avoid thundering-herd retries. Default true. */
  jitter?: boolean;
  /** Decide whether a given failure should be retried. Default {@link isTransientConnectionError}. */
  shouldRetry?: (error: unknown) => boolean;
  /** Called before each retry's delay. Useful for logging/tests observing retry behavior. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Structured logger to warn on each retry. Optional — silent by default. */
  logger?: Logger;
  /** Injectable delay function, overridable in tests to avoid real waiting. Defaults to a real timer-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_DEFAULTS = {
  retries: 4,
  initialDelayMs: 100,
  maxDelayMs: 2000,
  factor: 2,
  jitter: true,
  shouldRetry: isTransientConnectionError,
} satisfies Required<
  Pick<
    RetryOptions,
    "retries" | "initialDelayMs" | "maxDelayMs" | "factor" | "jitter" | "shouldRetry"
  >
>;

/** The exponential delay for a given retry attempt (1-indexed), before jitter/capping. */
export function computeBackoffDelayMs(
  attempt: number,
  options: Pick<RetryOptions, "initialDelayMs" | "maxDelayMs" | "factor"> = {},
): number {
  const initialDelayMs = options.initialDelayMs ?? RETRY_DEFAULTS.initialDelayMs;
  const maxDelayMs = options.maxDelayMs ?? RETRY_DEFAULTS.maxDelayMs;
  const factor = options.factor ?? RETRY_DEFAULTS.factor;
  const exponential = initialDelayMs * factor ** (attempt - 1);
  return Math.min(exponential, maxDelayMs);
}

/**
 * Run `fn`, retrying with exponential backoff when it rejects with a
 * retriable error (see {@link RetryOptions.shouldRetry}, default
 * {@link isTransientConnectionError}). Resolves with `fn`'s eventual result;
 * rejects with the *last* error once `retries` attempts are exhausted, or
 * immediately with any error `shouldRetry` says not to retry.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? RETRY_DEFAULTS.retries;
  const jitter = options.jitter ?? RETRY_DEFAULTS.jitter;
  const shouldRetry = options.shouldRetry ?? RETRY_DEFAULTS.shouldRetry;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt >= retries;
      if (isLastAttempt || !shouldRetry(error)) {
        throw error;
      }
      const capped = computeBackoffDelayMs(attempt, options);
      const delayMs = jitter ? Math.random() * capped : capped;
      options.onRetry?.({ attempt, delayMs, error });
      options.logger?.warn(
        { attempt, retries, delayMs: Math.round(delayMs), err: error },
        "Transient database connection error — retrying with backoff.",
      );
      await sleep(delayMs);
    }
  }
  // Unreachable: the loop above always either returns or throws (on the last
  // attempt) before falling through. Present only to satisfy TypeScript's
  // control-flow analysis, since it cannot prove the loop is exhaustive.
  throw new Error("retryWithBackoff: unreachable");
}

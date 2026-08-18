import { describe, expect, it, vi } from "vitest";
import {
  computeBackoffDelayMs,
  isPoolExhaustedError,
  isTransientConnectionError,
  retryWithBackoff,
} from "../../../src/plugins/database-mysql/src/resilience.js";

/** Build an Error carrying a Node/mysql2-style `.code`, matching how these errors really arrive. */
function codedError(code: string, message = code): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

describe("isTransientConnectionError — classifies retriable connection failures", () => {
  it.each(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "PROTOCOL_CONNECTION_LOST", "ENOTFOUND"])(
    "treats %s as transient",
    (code) => {
      expect(isTransientConnectionError(codedError(code))).toBe(true);
    },
  );

  it("does not treat a plain driver/query error (no .code) as transient", () => {
    expect(isTransientConnectionError(new Error("ER_PARSE_ERROR: syntax error"))).toBe(false);
  });

  it("does not treat an unrelated error code as transient", () => {
    expect(isTransientConnectionError(codedError("ER_DUP_ENTRY"))).toBe(false);
  });

  it("does not throw on non-Error thrown values", () => {
    expect(isTransientConnectionError("just a string")).toBe(false);
    expect(isTransientConnectionError(null)).toBe(false);
    expect(isTransientConnectionError(undefined)).toBe(false);
  });
});

describe("isPoolExhaustedError — classifies pool-capacity failures", () => {
  it('recognizes mysql2\'s "Queue limit reached." pool error', () => {
    expect(isPoolExhaustedError(new Error("Queue limit reached."))).toBe(true);
  });

  it('recognizes mysql2\'s "No connections available." pool error', () => {
    expect(isPoolExhaustedError(new Error("No connections available."))).toBe(true);
  });

  it("recognizes the server-side ER_CON_COUNT_ERROR (max_connections reached)", () => {
    expect(isPoolExhaustedError(codedError("ER_CON_COUNT_ERROR", "Too many connections"))).toBe(
      true,
    );
  });

  it("does not classify a transient connection error as pool exhaustion", () => {
    expect(isPoolExhaustedError(codedError("ECONNREFUSED"))).toBe(false);
  });

  it("does not classify an unrelated driver error as pool exhaustion", () => {
    expect(isPoolExhaustedError(new Error("ER_PARSE_ERROR: syntax error"))).toBe(false);
  });
});

describe("computeBackoffDelayMs — exponential growth, capped", () => {
  it("doubles (default factor) with each attempt before capping", () => {
    const opts = { initialDelayMs: 100, maxDelayMs: 10_000, factor: 2 };
    expect(computeBackoffDelayMs(1, opts)).toBe(100);
    expect(computeBackoffDelayMs(2, opts)).toBe(200);
    expect(computeBackoffDelayMs(3, opts)).toBe(400);
    expect(computeBackoffDelayMs(4, opts)).toBe(800);
  });

  it("caps the delay at maxDelayMs", () => {
    const opts = { initialDelayMs: 1000, maxDelayMs: 2500, factor: 2 };
    expect(computeBackoffDelayMs(1, opts)).toBe(1000);
    expect(computeBackoffDelayMs(2, opts)).toBe(2000);
    expect(computeBackoffDelayMs(3, opts)).toBe(2500); // would be 4000 uncapped
    expect(computeBackoffDelayMs(10, opts)).toBe(2500);
  });
});

describe("retryWithBackoff — simulating a temporarily unreachable database", () => {
  it("succeeds on the first attempt without ever sleeping or retrying", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const fn = vi.fn(async () => "ok");

    await expect(retryWithBackoff(fn, { sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a transient connection failure with exponential backoff and eventually succeeds", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      // Simulates a MySQL instance that is temporarily unreachable
      // (connection refused) for its first two attempts, then recovers —
      // e.g. still finishing startup — and answers normally.
      if (attempts <= 2) {
        throw codedError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:3306");
      }
      return "connected";
    });

    const result = await retryWithBackoff(fn, {
      retries: 5,
      initialDelayMs: 100,
      factor: 2,
      jitter: false,
      sleep,
    });

    expect(result).toBe("connected");
    expect(fn).toHaveBeenCalledTimes(3);
    // Two retries were needed: the delay before each one follows the
    // exponential backoff schedule (100ms, then 200ms).
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0]?.[0]).toBe(100);
    expect(sleep.mock.calls[1]?.[0]).toBe(200);
  });

  it("gives up and rejects with the last error once retries are exhausted", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const persistentFailure = codedError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:3306");
    const fn = vi.fn(async () => {
      throw persistentFailure;
    });

    await expect(retryWithBackoff(fn, { retries: 3, sleep })).rejects.toBe(persistentFailure);
    expect(fn).toHaveBeenCalledTimes(3);
    // Backoff happens before retries 2 and 3, but not after the final
    // (3rd) attempt fails — there is nothing left to wait for.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient error — fails immediately on the first attempt", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const queryError = new Error("ER_PARSE_ERROR: You have an error in your SQL syntax");
    const fn = vi.fn(async () => {
      throw queryError;
    });

    await expect(retryWithBackoff(fn, { sleep })).rejects.toBe(queryError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("honors a caller-supplied shouldRetry predicate instead of the transient-connection default", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("custom retriable condition");
      }
      return "done";
    });

    const result = await retryWithBackoff(fn, {
      sleep,
      shouldRetry: (error) =>
        error instanceof Error && error.message === "custom retriable condition",
    });

    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("calls onRetry with attempt number, computed delay, and the error before each retry", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const onRetry = vi.fn();
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw codedError("ETIMEDOUT");
      }
      return "ok";
    });

    await retryWithBackoff(fn, { sleep, jitter: false, initialDelayMs: 50, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, delayMs: 50 }) as unknown as Record<string, unknown>,
    );
  });

  it("logs a warning via a supplied logger on each retry", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const warn = vi.fn();
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw codedError("ECONNRESET");
      }
      return "ok";
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal logger stub, only `.warn` is used by retryWithBackoff.
    await retryWithBackoff(fn, { sleep, logger: { warn } as any });

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

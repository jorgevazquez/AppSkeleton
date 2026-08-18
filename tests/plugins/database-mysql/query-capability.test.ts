import { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { DatabaseError, ValidationError } from "../../../src/core/errors.js";
import type { Database } from "../../../src/plugins/database-mysql/src/db.js";
import { createDbQueryCapability } from "../../../src/plugins/database-mysql/src/query-capability.js";

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

  it("exposes only `query` — no `query(sql, params)` string-accepting overload or any other method", () => {
    const capability = createDbQueryCapability(FAKE_DB);
    expect(Object.keys(capability)).toEqual(["query"]);
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

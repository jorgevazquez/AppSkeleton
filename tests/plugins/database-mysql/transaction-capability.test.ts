import { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { DatabaseError, ValidationError } from "../../../src/core/errors.js";
import type { Database } from "../../../src/plugins/database-mysql/src/db.js";
import { createDbTransactionCapability } from "../../../src/plugins/database-mysql/src/transaction-capability.js";

/**
 * A fake `Kysely<Database>` whose `transaction()` mimics the real Kysely
 * contract closely enough for pure unit tests: `.execute(fn)` invokes `fn`
 * with a stand-in transaction handle and either resolves with `fn`'s
 * resolved value (commit) or rejects with whatever `fn` threw (rollback) —
 * `createDbTransactionCapability()` never inspects the handle itself, only
 * ever passes it through to the caller's `fn`, exactly like
 * `createDbQueryCapability()` does for `db:query` (see
 * query-capability.test.ts). Real commit/rollback behavior against a real
 * MySQL transaction is covered by transaction-capability.integration.test.ts.
 */
const FAKE_TRX = { __fake: "trx" } as unknown;

function fakeDb(): Kysely<Database> {
  return {
    transaction: () => ({
      execute: async (fn: (trx: unknown) => Promise<unknown>) => fn(FAKE_TRX),
    }),
  } as unknown as Kysely<Database>;
}

describe("createDbTransactionCapability — db:transaction capability object", () => {
  it("invokes fn with a transaction handle and commits (resolves) fn's result on success", async () => {
    const capability = createDbTransactionCapability(fakeDb());
    const fn = vi.fn(async (trx: unknown) => {
      expect(trx).toBe(FAKE_TRX);
      return "committed" as const;
    });

    await expect(capability.transaction(fn)).resolves.toBe("committed");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(FAKE_TRX);
  });

  it("exposes only `transaction` — no raw SQL-accepting overload or any other method", () => {
    const capability = createDbTransactionCapability(fakeDb());
    expect(Object.keys(capability)).toEqual(["transaction"]);
    expect(typeof capability.transaction).toBe("function");
    expect(capability.transaction.length).toBe(1);
  });

  it("rolls back (rejects) and normalizes a plain error thrown by fn into a DatabaseError", async () => {
    const capability = createDbTransactionCapability(fakeDb());
    const driverError = new Error("ER_LOCK_DEADLOCK: Deadlock found");

    const promise = capability.transaction(async () => {
      throw driverError;
    });

    await expect(promise).rejects.toBeInstanceOf(DatabaseError);
    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining("ER_LOCK_DEADLOCK") as unknown as string,
      cause: driverError,
    });
  });

  it("does not leak driver-level detail through the normalized error's public message", async () => {
    const capability = createDbTransactionCapability(fakeDb());

    try {
      await capability.transaction(async () => {
        throw new Error("ER_ACCESS_DENIED_ERROR for user 'appskeleton'@'%'");
      });
      expect.fail("expected capability.transaction to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseError);
      const dbError = error as DatabaseError;
      expect(dbError.publicMessage).not.toContain("ER_ACCESS_DENIED_ERROR");
      expect(dbError.publicMessage).not.toContain("appskeleton");
    }
  });

  it("passes an already-AppError thrown by fn through unchanged (no double-wrapping)", async () => {
    const capability = createDbTransactionCapability(fakeDb());
    const original = new ValidationError("row failed a business-rule check inside fn");

    const promise = capability.transaction(async () => {
      throw original;
    });

    await expect(promise).rejects.toBe(original);
  });

  it("propagates fn's resolved value type-faithfully for non-string results", async () => {
    const capability = createDbTransactionCapability(fakeDb());
    const rows = [{ id: 1 }, { id: 2 }];

    await expect(capability.transaction(async () => rows)).resolves.toEqual(rows);
  });
});

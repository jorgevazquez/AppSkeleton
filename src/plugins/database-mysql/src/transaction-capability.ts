/**
 * The `db:transaction` capability implementation (feature #21 —
 * "db:transaction capability with commit/rollback semantics").
 *
 * spec.md: "a `db:query`/`db:transaction` capability exposed to other
 * plugins — no plugin talks to MySQL directly." This module is the
 * `db:transaction` half of that contract: {@link createDbTransactionCapability}
 * builds the object the database-mysql plugin registers with the capability
 * broker (`broker.registerProvider(pluginId, "db:transaction", ...)`, see
 * broker.ts) — the only handle any other plugin can ever obtain for running
 * a multi-statement MySQL transaction.
 *
 * ## Commit/rollback semantics
 *
 * {@link DbTransactionCapability.transaction} delegates directly to Kysely's
 * own `db.transaction().execute(fn)` (see `kysely/dist/kysely.d.ts`'s
 * `transaction()` docs): Kysely opens the transaction, runs `fn` with a
 * `Transaction<Database>` handle, and
 *
 *  - commits automatically if `fn`'s returned promise resolves, or
 *  - rolls back automatically (via the underlying driver's `ROLLBACK`) if
 *    `fn`'s returned promise rejects — including a rejection thrown partway
 *    through a multi-statement sequence, after some statements already ran
 *    against the transaction's connection. Nothing those earlier statements
 *    wrote is visible afterward; see
 *    `transaction-capability.integration.test.ts` for a real-MySQL proof
 *    that a failing statement midway through a transaction leaves no
 *    partial writes.
 *
 * This mirrors {@link DbQueryCapability.query}'s narrow, parameterized-only
 * shape (see query-capability.ts): `fn` only ever receives Kysely's
 * type-safe transaction handle, never a raw SQL string, so the same
 * SQL-injection-shaped-value guarantees `db:query` gives apply here too —
 * Kysely compiles every statement issued through `trx` to bound `?`
 * placeholders exactly as it does for the top-level `db` handle.
 *
 * Any error `fn` throws (including a rejected promise it returns) is
 * normalized to a {@link DatabaseError} before it leaves `transaction()`, so
 * a consumer plugin never has to distinguish a raw mysql2/Kysely error shape
 * from any other kernel-surfaced failure — same normalization rule
 * `db:query` follows. An error that is already an `AppError` (e.g. a
 * consumer's own validation logic run inside `fn`) passes through unchanged
 * rather than being double-wrapped; the transaction still rolls back either
 * way, since Kysely triggers the rollback off of `fn` rejecting at all, not
 * off of what kind of error it rejected with.
 */
import type { Kysely, Transaction } from "kysely";
import { DatabaseError, isAppError } from "../../../core/errors.js";
import type { Database } from "./db.js";

/** The object registered with the capability broker as the `db:transaction` provider. */
export interface DbTransactionCapability {
  /**
   * Run `fn` inside a single MySQL transaction against the plugin's shared
   * `Kysely<Database>` instance. Commits and returns `fn`'s resolved value
   * if `fn` resolves; rolls back the entire transaction (discarding every
   * statement `fn` ran against the transaction handle, however far it got)
   * and rejects if `fn` throws or its returned promise rejects. `fn` builds
   * and executes its own queries via Kysely's type-safe builder against the
   * transaction handle it receives — this method does not accept, parse, or
   * otherwise touch a raw SQL string itself (see this module's docs).
   */
  transaction<T>(fn: (trx: Transaction<Database>) => Promise<T>): Promise<T>;
}

/** Human-readable detail from an unknown thrown value, safe to embed in a `DatabaseError`'s internal `message`. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the `db:transaction` capability implementation over an
 * already-constructed `Kysely<Database>` instance (see `createKyselyDb()`
 * in db.ts) — the same shared instance the `db:query` capability is built
 * over (see query-capability.ts).
 */
export function createDbTransactionCapability(db: Kysely<Database>): DbTransactionCapability {
  return {
    async transaction<T>(fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
      try {
        return await db.transaction().execute(fn);
      } catch (cause) {
        if (isAppError(cause)) {
          throw cause;
        }
        throw new DatabaseError(`db:transaction failed: ${describeError(cause)}`, { cause });
      }
    },
  };
}

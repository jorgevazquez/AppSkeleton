/**
 * The `db:query` capability implementation (feature #20 — "db:query
 * capability implemented via kysely, parameterized only").
 *
 * spec.md: "a `db:query`/`db:transaction` capability exposed to other
 * plugins — no plugin talks to MySQL directly." This module is the
 * `db:query` half of that contract: {@link createDbQueryCapability} builds
 * the object the database-mysql plugin registers with the capability
 * broker (`broker.registerProvider(pluginId, "db:query", ...)`, see
 * broker.ts) — the *only* handle any other plugin can ever obtain for
 * talking to MySQL.
 *
 * ## Parameterized only — no raw interpolated SQL from consumers
 *
 * {@link DbQueryCapability.query}'s signature is deliberately narrow: it
 * takes a callback that receives the plugin's shared, already-typed
 * `Kysely<Database>` instance and must return the promise of a Kysely query
 * execution (`db.selectFrom(...).execute()`,
 * `db.insertInto(...).values(...).execute()`, `db.updateTable(...)...`,
 * etc.) — there is no `query(sql: string, params: unknown[])` overload, and
 * no code path anywhere in this module parses, concatenates, or otherwise
 * touches a raw SQL string a caller supplied. A consumer can only reach the
 * database through Kysely's query builder (or its `sql` tagged-template
 * helper, whose interpolated JS values are *always* compiled to bound `?`
 * placeholders, never spliced into the SQL text — see
 * `kysely/dist/dialect/mysql/mysql-driver.js`'s `executeQuery()`, which
 * hands `compiledQuery.sql` and `compiledQuery.parameters` to mysql2 as two
 * separate arguments). This is what step 2 of this feature ("no code path
 * accepts raw interpolated SQL strings from capability consumers") is
 * enforced by structurally, not merely by convention — see
 * `query-capability.integration.test.ts` for a payload-level regression
 * test proving SQL-injection-shaped values land as literal stored data,
 * never as executed SQL.
 *
 * Any error `fn` throws — a Kysely/mysql2 driver error, most commonly — is
 * normalized to a {@link DatabaseError} (spec.md's AppError taxonomy: every
 * error crossing a plugin boundary must be an AppError) before it leaves
 * `query()`, so a consumer plugin never has to distinguish a raw mysql2
 * error shape from any other kernel-surfaced failure. An error that is
 * already an `AppError` (e.g. a consumer's own validation logic run inside
 * `fn`, or an already-normalized error rethrown by a nested capability
 * call) passes through unchanged rather than being double-wrapped.
 */
import type { Kysely } from "kysely";
import { DatabaseError, isAppError } from "../../../core/errors.js";
import type { Database } from "./db.js";

/** The object registered with the capability broker as the `db:query` provider. */
export interface DbQueryCapability {
  /**
   * Run `fn` against the plugin's shared `Kysely<Database>` instance and
   * return its result. `fn` builds and executes its own query via Kysely's
   * type-safe builder — this method does not accept, parse, or otherwise
   * touch a raw SQL string itself (see this module's docs).
   */
  query<T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T>;
}

/** Human-readable detail from an unknown thrown value, safe to embed in a `DatabaseError`'s internal `message`. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the `db:query` capability implementation over an already-constructed
 * `Kysely<Database>` instance (see `createKyselyDb()` in db.ts).
 */
export function createDbQueryCapability(db: Kysely<Database>): DbQueryCapability {
  return {
    async query<T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T> {
      try {
        return await fn(db);
      } catch (cause) {
        if (isAppError(cause)) {
          throw cause;
        }
        throw new DatabaseError(`db:query failed: ${describeError(cause)}`, { cause });
      }
    },
  };
}

/**
 * Kysely wiring over this plugin's mysql2 connection pool (feature #20 —
 * "db:query capability implemented via kysely, parameterized only",
 * step 1: "Wire a kysely Kysely<Database> instance over the mysql2 pool").
 *
 * `mysql2/promise`'s `Pool` (what `createDbPool()`/`createDbPoolFromEnv()`
 * in pool.ts return) is a thin promise-returning wrapper around a plain,
 * callback-based mysql2 `Pool` — the wrapper exposes that underlying pool
 * verbatim as its own public `.pool` property (see
 * `mysql2/promise.d.ts`: `interface Pool extends Connection { ...;
 * pool: CorePool }`, where `CorePool` is mysql2's callback-style
 * `getConnection(callback)`/`end(callback)` pool). That shape is exactly
 * what Kysely's `MysqlDialect` needs (see
 * `kysely/dist/dialect/mysql/mysql-dialect-config.d.ts`'s `MysqlPool`), so
 * {@link createKyselyDb} hands it `pool.pool` rather than constructing a
 * second, independent mysql2 pool from the same config. This means the pool
 * this plugin already builds from `DB_CONNECTION_LIMIT` (pool.ts) stays the
 * *only* pool of TCP connections ever opened — Kysely-issued queries and any
 * lower-level mysql2 use (health checks, the future migration runner) share
 * one connection budget, not two independent ones.
 */
import { Kysely, MysqlDialect, type KyselyConfig } from "kysely";
import type { Pool } from "mysql2/promise";

/**
 * The MySQL schema this plugin's `Kysely<Database>` instance is typed
 * against.
 *
 * No migrations have landed yet: the migration runner (feature #19) is a
 * sibling feature this one only `depends_on: [18]` (the connection pool),
 * not #19's actual tables. Rather than fall back to `Kysely<any>` — which
 * would throw away Kysely's compile-time query validation for every future
 * consumer of the db:query capability — this uses a generic index
 * signature so `Kysely<Database>` stays a real, distinct generic type
 * today: table names type-check as `string` and every column as `unknown`
 * until a concrete row shape is declared for it.
 *
 * As each plugin's tables land (#19+), replace/extend this with concrete
 * `<table_name>: <RowShape>` members (each plugin contributing its own via
 * TypeScript's interface declaration merging, per spec.md's per-plugin
 * table namespace convention landing in feature #22) for real column-level
 * type safety. Adding concrete members alongside the index signature is a
 * purely additive, non-breaking change.
 */
export interface Database {
  [table: string]: Record<string, unknown>;
}

export interface CreateKyselyDbOptions {
  /**
   * Kysely's own per-query `log` hook (feature #26 — "Slow query logging
   * and basic query performance metrics"): fired once per compiled
   * statement with its SQL text, bound parameters, and duration. Typically
   * built via `query-metrics.ts`'s `createSlowQueryLogger()` rather than
   * supplied by hand — see that module's docs for why instrumentation
   * lives here (at the shared Kysely instance) rather than inside
   * `query-capability.ts`'s `query()` wrapper. Omitted by default, in
   * which case Kysely logs nothing (matches Kysely's own `log`-unset
   * default).
   */
  log?: KyselyConfig["log"];
}

/**
 * Build a `Kysely<Database>` instance over an already-constructed mysql2
 * connection pool (see `createDbPool()`/`createDbPoolFromEnv()` in
 * pool.ts). Like the underlying mysql2 pool itself, this does not open a
 * connection eagerly — Kysely's `MysqlDriver` acquires connections lazily,
 * on first query.
 */
export function createKyselyDb(pool: Pool, options: CreateKyselyDbOptions = {}): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new MysqlDialect({ pool: pool.pool }),
    ...(options.log ? { log: options.log } : {}),
  });
}

/**
 * Integration tests against the real docker-compose MySQL instance (see
 * `docker-compose.yml` / `init.sh`) proving feature #21's steps:
 *
 *  1. "Expose a transaction(fn) capability that commits on success and
 *     rolls back on any thrown error"
 *  2. "Write an integration test: a transaction with a failing statement
 *     midway leaves no partial writes"
 *
 * Mirrors query-capability.integration.test.ts's shape (and pool.integration
 * .test.ts's before it): skips itself (rather than failing) when MySQL isn't
 * reachable, so `npm test` stays green without Docker; `init.sh` and CI
 * always have it up.
 *
 * As in query-capability.integration.test.ts, the migration runner
 * (feature #19) predates this plugin's own tables, so this suite creates
 * and drops its own scratch table directly via the raw pool (test fixture
 * setup, not a "capability consumer" code path).
 */
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createDbPool } from "../../../src/plugins/database-mysql/src/pool.js";
import { createKyselyDb, type Database } from "../../../src/plugins/database-mysql/src/db.js";
import {
  createDbTransactionCapability,
  type DbTransactionCapability,
} from "../../../src/plugins/database-mysql/src/transaction-capability.js";

/** Matches docker-compose.yml's `mysql` service credentials. */
const DOCKER_COMPOSE_CONFIG = {
  DB_HOST: "127.0.0.1",
  DB_PORT: 3306,
  DB_USER: "appskeleton",
  DB_PASSWORD: "change-me",
  DB_NAME: "appskeleton",
  DB_CONNECTION_LIMIT: 5,
  DB_SSL: "disabled" as const,
  DB_SSL_REJECT_UNAUTHORIZED: true,
};

const TABLE = "database_mysql_transaction_capability_test";

// Built as plain strings (not template literals inline at a `.query()`/
// `.transaction()` call site) so this DDL fixture setup doesn't trip the
// repo-wide `no-restricted-syntax` lint rule — see
// query-capability.integration.test.ts for the same rationale.
const DROP_TABLE_SQL = "DROP TABLE IF EXISTS `" + TABLE + "`";
const CREATE_TABLE_SQL =
  "CREATE TABLE `" +
  TABLE +
  "` (" +
  "id INT AUTO_INCREMENT PRIMARY KEY, " +
  "name VARCHAR(255) NOT NULL UNIQUE" +
  ")";

async function probeMysqlReachable(): Promise<boolean> {
  try {
    const probe = await mysql.createConnection({
      host: DOCKER_COMPOSE_CONFIG.DB_HOST,
      port: DOCKER_COMPOSE_CONFIG.DB_PORT,
      user: DOCKER_COMPOSE_CONFIG.DB_USER,
      password: DOCKER_COMPOSE_CONFIG.DB_PASSWORD,
      database: DOCKER_COMPOSE_CONFIG.DB_NAME,
      connectTimeout: 2000,
    });
    await probe.ping();
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

// Resolved via top-level await BEFORE describe.runIf()'s condition is
// evaluated at collection time — see pool.integration.test.ts for why this
// must not be a still-pending promise at that point.
const mysqlReachable = await probeMysqlReachable();

if (!mysqlReachable) {
  console.warn(
    "[transaction-capability.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping integration ` +
      "suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

describe.runIf(mysqlReachable)("db:transaction capability — commit/rollback integration", () => {
  let pool: mysql.Pool;
  let db: Kysely<Database>;
  let capability: DbTransactionCapability;

  beforeAll(async () => {
    pool = createDbPool(DOCKER_COMPOSE_CONFIG);
    db = createKyselyDb(pool);
    capability = createDbTransactionCapability(db);

    // Raw DDL fixture setup — not a db:transaction consumer path (see
    // module docs / query-capability.integration.test.ts).
    await pool.query(DROP_TABLE_SQL);
    await pool.query(CREATE_TABLE_SQL);
  });

  afterAll(async () => {
    await pool.query(DROP_TABLE_SQL);
    // Destroying Kysely ends the shared underlying mysql2 pool — see db.ts.
    await db.destroy();
  });

  it("commits every write when fn resolves", async () => {
    await capability.transaction(async (trx) => {
      await trx.insertInto(TABLE).values({ name: "Ada" }).execute();
      await trx.insertInto(TABLE).values({ name: "Grace" }).execute();
    });

    const rows = await db.selectFrom(TABLE).select(["name"]).orderBy("name").execute();
    expect(rows).toEqual([{ name: "Ada" }, { name: "Grace" }]);
  });

  it("a transaction with a failing statement midway leaves no partial writes", async () => {
    // `name` has a UNIQUE constraint — the second insert's duplicate value
    // fails at the database level partway through the sequence, after the
    // first insert already ran against the transaction's connection.
    await expect(
      capability.transaction(async (trx) => {
        await trx.insertInto(TABLE).values({ name: "Alan" }).execute();
        await trx.insertInto(TABLE).values({ name: "Alan" }).execute(); // duplicate -> throws
        await trx.insertInto(TABLE).values({ name: "Never Reached" }).execute();
      }),
    ).rejects.toMatchObject({ code: "DATABASE_ERROR" });

    // None of the three statements' writes survived — not even the first
    // insert that succeeded before the failure.
    const rows = await db.selectFrom(TABLE).select(["name"]).execute();
    expect(rows.map((r) => r.name)).not.toContain("Alan");
    expect(rows.map((r) => r.name)).not.toContain("Never Reached");
  });

  it("rolls back on a non-driver error thrown by fn after a successful write", async () => {
    await expect(
      capability.transaction(async (trx) => {
        await trx.insertInto(TABLE).values({ name: "Rolled Back" }).execute();
        throw new Error("business rule failed after the insert");
      }),
    ).rejects.toBeInstanceOf(Error);

    const rows = await db
      .selectFrom(TABLE)
      .select(["name"])
      .where("name", "=", "Rolled Back")
      .execute();
    expect(rows).toEqual([]);
  });
});

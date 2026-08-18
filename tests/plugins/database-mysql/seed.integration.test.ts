/**
 * Integration tests against the real docker-compose MySQL instance (see
 * migrator.integration.test.ts / pool.integration.test.ts, which this file
 * mirrors: skips itself when MySQL isn't reachable so `npm test` stays
 * green without Docker; `init.sh` and CI always have it up).
 *
 * Feature #25 step 3: "write a test asserting seeds are idempotent (running
 * twice does not duplicate rows)". The fixture seed below does a plain,
 * non-upserting `INSERT` — deliberately NOT itself idempotent — so what
 * this suite actually proves is that `runSeeds()`'s own tracking-table
 * bookkeeping (`schema_seeds`, mirroring migrator.ts's `schema_migrations`)
 * is what makes seeding idempotent, not any care taken by the seed author.
 */
import mysql from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { SeedError } from "../../../src/core/errors.js";
import {
  SEEDS_TABLE,
  clearSeedRegistryForTests,
  listRegisteredSeeds,
  registerSeed,
  runSeeds,
  type SeedableDatabase,
} from "../../../src/core/seed.js";
import { createDbPool } from "../../../src/plugins/database-mysql/src/pool.js";
import { createKyselyDb } from "../../../src/plugins/database-mysql/src/db.js";

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

const FIXTURE_TABLE = "database_mysql_seed_test_widgets";
const DROP_TABLE_SQL = "DROP TABLE IF EXISTS `" + FIXTURE_TABLE + "`";
const CREATE_TABLE_SQL =
  "CREATE TABLE `" +
  FIXTURE_TABLE +
  "` (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(255) NOT NULL)";
const COUNT_SQL = "SELECT COUNT(*) AS n FROM `" + FIXTURE_TABLE + "`";

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
    "[seed.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping integration ` +
      "suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

describe.runIf(mysqlReachable)("seed runner — idempotent fixtures integration", () => {
  let pool: mysql.Pool;
  let db: Kysely<SeedableDatabase>;

  const SEED_PLUGIN_ID = "database-mysql";
  const SEED_NAME = "seed_test_widgets";

  beforeAll(async () => {
    pool = createDbPool(DOCKER_COMPOSE_CONFIG);
    db = createKyselyDb(pool);
    await pool.query(DROP_TABLE_SQL);
    await pool.query(CREATE_TABLE_SQL);
  });

  afterAll(async () => {
    await pool.query(DROP_TABLE_SQL);
    await pool.query(
      "DELETE FROM `" + SEEDS_TABLE + "` WHERE `name` LIKE 'database-mysql:seed_test_%'",
    );
    await db.destroy();
  });

  afterEach(() => {
    clearSeedRegistryForTests();
  });

  async function rowCount(): Promise<number> {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(COUNT_SQL);
    return Number(rows[0]?.["n"] ?? 0);
  }

  it("applies a registered seed and records it in schema_seeds", async () => {
    // Deliberately a plain, non-upserting INSERT — not itself idempotent.
    registerSeed(SEED_PLUGIN_ID, SEED_NAME, async (seedDb) => {
      await seedDb.insertInto(FIXTURE_TABLE).values({ label: "first widget" }).execute();
    });

    const result = await runSeeds(db, { seeds: listRegisteredSeeds() });
    expect(result.applied).toEqual(["database-mysql:seed_test_widgets"]);
    expect(result.skipped).toEqual([]);

    expect(await rowCount()).toBe(1);

    const tracked = await db
      .selectFrom(SEEDS_TABLE)
      .selectAll()
      .where("name", "=", "database-mysql:seed_test_widgets")
      .executeTakeFirstOrThrow();
    expect(tracked["applied_at"]).toBeTruthy();
  });

  it("is idempotent — running the seed runner again does not duplicate rows", async () => {
    // Re-register the exact same (non-idempotent) seed, simulating a
    // second `npm run seed` invocation in a fresh process.
    registerSeed(SEED_PLUGIN_ID, SEED_NAME, async (seedDb) => {
      await seedDb.insertInto(FIXTURE_TABLE).values({ label: "first widget" }).execute();
    });

    const result = await runSeeds(db, { seeds: listRegisteredSeeds() });

    // Nothing new applied — the runner's own bookkeeping skipped it.
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(["database-mysql:seed_test_widgets"]);

    // Still exactly one row — not two — despite the seed's own INSERT
    // having no ON DUPLICATE KEY / existence check of its own.
    expect(await rowCount()).toBe(1);
  });

  it("running a third time is still a no-op, and row count stays at one", async () => {
    registerSeed(SEED_PLUGIN_ID, SEED_NAME, async (seedDb) => {
      await seedDb.insertInto(FIXTURE_TABLE).values({ label: "first widget" }).execute();
    });

    const result = await runSeeds(db, { seeds: listRegisteredSeeds() });

    expect(result.applied).toEqual([]);
    expect(await rowCount()).toBe(1);
  });

  it("refuses to run when NODE_ENV=production, and applies nothing", async () => {
    registerSeed(SEED_PLUGIN_ID, "should_not_run", async (seedDb) => {
      await seedDb
        .insertInto(FIXTURE_TABLE)
        .values({ label: "should never be inserted" })
        .execute();
    });

    await expect(
      runSeeds(db, { seeds: listRegisteredSeeds(), nodeEnv: "production" }),
    ).rejects.toBeInstanceOf(SeedError);

    // Nothing ran — row count is untouched from the prior tests' state.
    expect(await rowCount()).toBe(1);
    const tracked = await db
      .selectFrom(SEEDS_TABLE)
      .select("name")
      .where("name", "=", "database-mysql:should_not_run")
      .executeTakeFirst();
    expect(tracked).toBeUndefined();
  });
});

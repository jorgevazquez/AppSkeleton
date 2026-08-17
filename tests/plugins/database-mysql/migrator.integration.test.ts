/**
 * Integration tests against the real docker-compose MySQL instance (see
 * pool.integration.test.ts / query-capability.integration.test.ts, which
 * this file mirrors: skips itself when MySQL isn't reachable so `npm test`
 * stays green without Docker; `init.sh` and CI always have it up).
 *
 * Exercises migrator.ts's full up/down/checksum-verification behavior —
 * feature #19's step 3 ("write an integration test applying and rolling
 * back a sample migration") plus step 2 (checksum-mismatch rejection) —
 * against a real `schema_migrations` table and real migration files
 * dynamically imported from disk.
 *
 * Migration fixture files are written to ONE shared temp directory for the
 * whole suite (not one-per-test) — this matters: `verifyAppliedChecksums()`
 * treats an applied migration whose file is no longer present as a real
 * problem (a deleted history file), exactly like production usage where a
 * project's migrations directory holds its *entire* history, never just
 * the most recent one. The tests below run in file order (vitest runs
 * `it`s within a `describe` sequentially by default) and build on that
 * shared directory + shared `schema_migrations` state on purpose, the same
 * way a real project's migrations accumulate over time.
 *
 * Fixture migrations are plain ESM `.mjs` (no TypeScript) — mirrors
 * tests/server/index.test.ts's own fixture-plugin-module convention of
 * writing plain `.js` files to a temp dir and dynamically `import()`ing
 * them, which is exactly what migrator.ts's `importMigrationModule()` does
 * internally. All fixture-owned migration names start with `9` and all
 * fixture-owned tables are prefixed `migrator_test_` — outside the range
 * any real production migration would use — so `afterAll` can clean up
 * precisely without touching unrelated state in the shared dev database.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { MigrationError } from "../../../src/core/errors.js";
import { createDbPool } from "../../../src/plugins/database-mysql/src/pool.js";
import { createKyselyDb, type Database } from "../../../src/plugins/database-mysql/src/db.js";
import {
  MIGRATIONS_TABLE,
  computeChecksum,
  listMigrationFiles,
  runMigrationsDown,
  runMigrationsUp,
} from "../../../src/plugins/database-mysql/src/migrator.js";

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
    "[migrator.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping integration ` +
      "suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

async function tableExists(pool: mysql.Pool, tableName: string): Promise<boolean> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
    [tableName],
  );
  return Number(rows[0]?.["n"] ?? 0) > 0;
}

describe.runIf(mysqlReachable)("migration runner — checksum-verified up/down integration", () => {
  let pool: mysql.Pool;
  let db: Kysely<Database>;
  let migrationsDir: string;

  const WIDGETS_MIGRATION = "9001_migrator_test_create_widgets.mjs";
  const GIZMOS_MIGRATION = "9002_migrator_test_create_gizmos.mjs";
  const GADGETS_MIGRATION = "9003_migrator_test_create_gadgets.mjs";
  const SHOULD_NOT_RUN_MIGRATION = "9004_migrator_test_should_not_run.mjs";

  function writeFixtureMigration(name: string, table: string): void {
    writeFileSync(
      path.join(migrationsDir, name),
      `export async function up(db) {\n` +
        `  await db.schema\n` +
        `    .createTable("${table}")\n` +
        `    .addColumn("id", "integer", (col) => col.autoIncrement().primaryKey())\n` +
        `    .addColumn("label", "varchar(255)", (col) => col.notNull())\n` +
        `    .execute();\n` +
        `}\n\n` +
        `export async function down(db) {\n` +
        `  await db.schema.dropTable("${table}").execute();\n` +
        `}\n`,
    );
  }

  function files() {
    return listMigrationFiles(migrationsDir);
  }

  beforeAll(async () => {
    migrationsDir = mkdtempSync(path.join(tmpdir(), "appskeleton-migrator-integration-"));
    pool = createDbPool(DOCKER_COMPOSE_CONFIG);
    db = createKyselyDb(pool);
  });

  afterAll(async () => {
    // Raw cleanup (bypassing the runner, which may be deliberately left in
    // a rejecting state by the checksum-mismatch test below) — drop every
    // fixture-owned table and delete every fixture-owned tracking row.
    for (const table of [
      "migrator_test_widgets",
      "migrator_test_gizmos",
      "migrator_test_gadgets",
      "migrator_test_should_not_run",
    ]) {
      await pool.query("DROP TABLE IF EXISTS `" + table + "`");
    }
    await pool.query("DELETE FROM `" + MIGRATIONS_TABLE + "` WHERE `name` LIKE '9%'");
    rmSync(migrationsDir, { recursive: true, force: true });
    await db.destroy();
  });

  it("applies a pending migration and records it with its checksum in schema_migrations", async () => {
    writeFixtureMigration(WIDGETS_MIGRATION, "migrator_test_widgets");

    const result = await runMigrationsUp(db, files());
    expect(result.applied).toEqual([WIDGETS_MIGRATION]);

    expect(await tableExists(pool, "migrator_test_widgets")).toBe(true);

    const row = await db
      .selectFrom(MIGRATIONS_TABLE)
      .selectAll()
      .where("name", "=", WIDGETS_MIGRATION)
      .executeTakeFirstOrThrow();
    expect(row["checksum"]).toBe(
      computeChecksum(readFileSync(path.join(migrationsDir, WIDGETS_MIGRATION), "utf8")),
    );
    expect(row["applied_at"]).toBeTruthy();

    // The migrated table is real and usable through Kysely.
    const inserted = await db
      .insertInto("migrator_test_widgets")
      .values({ label: "first widget" })
      .executeTakeFirstOrThrow();
    expect(inserted.insertId).toBeGreaterThan(0n);
  });

  it("is idempotent — running up again applies nothing new", async () => {
    const result = await runMigrationsUp(db, files());
    expect(result.applied).toEqual([]);
  });

  it("applies multiple pending migrations in filename order, not write order", async () => {
    // Written out of numeric order on purpose to prove the runner sorts by
    // filename rather than trusting fixture write order.
    writeFixtureMigration(GADGETS_MIGRATION, "migrator_test_gadgets");
    writeFixtureMigration(GIZMOS_MIGRATION, "migrator_test_gizmos");

    const result = await runMigrationsUp(db, files());
    expect(result.applied).toEqual([GIZMOS_MIGRATION, GADGETS_MIGRATION]);

    expect(await tableExists(pool, "migrator_test_gizmos")).toBe(true);
    expect(await tableExists(pool, "migrator_test_gadgets")).toBe(true);
  });

  it("rolls back only the most-recently-applied migration on down()", async () => {
    const result = await runMigrationsDown(db, files());
    expect(result.rolledBack).toEqual([GADGETS_MIGRATION]);

    expect(await tableExists(pool, "migrator_test_gadgets")).toBe(false);
    // Everything applied before it is untouched.
    expect(await tableExists(pool, "migrator_test_gizmos")).toBe(true);
    expect(await tableExists(pool, "migrator_test_widgets")).toBe(true);

    const stillTracked = await db
      .selectFrom(MIGRATIONS_TABLE)
      .select("name")
      .where("name", "=", GADGETS_MIGRATION)
      .executeTakeFirst();
    expect(stillTracked).toBeUndefined();
  });

  describe("checksum verification", () => {
    const originalWidgetsSource = () =>
      readFileSync(path.join(migrationsDir, WIDGETS_MIGRATION), "utf8");
    let savedSource: string;

    beforeAll(() => {
      savedSource = originalWidgetsSource();
    });

    afterAll(() => {
      // Restore the tampered fixture so the runner is left in a clean,
      // non-rejecting state for anything running after this suite.
      writeFileSync(path.join(migrationsDir, WIDGETS_MIGRATION), savedSource);
    });

    it("rejects up() when an already-applied migration file was modified, and runs nothing pending", async () => {
      const recordedBefore = await db
        .selectFrom(MIGRATIONS_TABLE)
        .select("checksum")
        .where("name", "=", WIDGETS_MIGRATION)
        .executeTakeFirstOrThrow();

      // Tamper with the already-applied 0001 migration's file.
      writeFileSync(
        path.join(migrationsDir, WIDGETS_MIGRATION),
        savedSource + "\n// tampered after being applied\n",
      );
      // Add a brand-new pending migration — this must NOT run once the
      // checksum guard trips on the older, tampered file.
      writeFixtureMigration(SHOULD_NOT_RUN_MIGRATION, "migrator_test_should_not_run");

      let caught: unknown;
      try {
        await runMigrationsUp(db, files());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MigrationError);
      expect((caught as MigrationError).code).toBe("MIGRATION_ERROR");

      // The new migration never ran.
      expect(await tableExists(pool, "migrator_test_should_not_run")).toBe(false);
      const stillPending = await db
        .selectFrom(MIGRATIONS_TABLE)
        .select("name")
        .where("name", "=", SHOULD_NOT_RUN_MIGRATION)
        .executeTakeFirst();
      expect(stillPending).toBeUndefined();

      // The recorded checksum for the tampered migration is untouched —
      // the runner never silently "heals" a mismatch.
      const recordedAfter = await db
        .selectFrom(MIGRATIONS_TABLE)
        .select("checksum")
        .where("name", "=", WIDGETS_MIGRATION)
        .executeTakeFirstOrThrow();
      expect(recordedAfter.checksum).toBe(recordedBefore.checksum);
    });

    it("rejects down() too while a checksum mismatch is unresolved", async () => {
      await expect(runMigrationsDown(db, files())).rejects.toMatchObject({
        code: "MIGRATION_ERROR",
      });
    });

    it("accepts up()/down() again once the tampered file is restored", async () => {
      writeFileSync(path.join(migrationsDir, WIDGETS_MIGRATION), savedSource);

      const result = await runMigrationsUp(db, files());
      // GADGETS was rolled back (and never reapplied) earlier in this suite,
      // so once the checksum guard clears, it's pending again alongside the
      // newer SHOULD_NOT_RUN migration — both apply now, in filename order.
      expect(result.applied).toEqual([GADGETS_MIGRATION, SHOULD_NOT_RUN_MIGRATION]);
      expect(await tableExists(pool, "migrator_test_gadgets")).toBe(true);
      expect(await tableExists(pool, "migrator_test_should_not_run")).toBe(true);
    });
  });
});

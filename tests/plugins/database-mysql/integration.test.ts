/**
 * The database-mysql integration suite (feature #27 — "Integration test
 * suite for database-mysql against dockerized MySQL").
 *
 * Step 1 asks for ONE suite, run against the real docker-compose MySQL
 * instance, covering four things together: migration up/down, db:query
 * CRUD, db:transaction rollback, and namespace enforcement. The plugin's
 * pieces already each have their own focused integration suite —
 * pool.integration.test.ts (raw connectivity/TLS/pool sizing),
 * query-capability.integration.test.ts (parameterized-only /
 * SQL-injection-payload proofs), transaction-capability.integration.test.ts
 * (commit/rollback semantics), migrator.integration.test.ts (full
 * checksum-verified up/down lifecycle) — this file does not duplicate that
 * depth. It is the single end-to-end suite feature #27 asks for: one file,
 * one shared connection, walking through the plugin's whole surface area
 * (migrate up -> query CRUD -> transaction rollback -> namespace
 * enforcement) the way a real consumer plugin would exercise it in
 * sequence, plus the one live-MySQL case no other suite covers yet —
 * feature #22's namespace guard rejecting a real migration against a real
 * database (previously only unit-tested against a fake `{ schema:
 * { createTable } }` stand-in in migrator.test.ts; see that feature's
 * claude-progress.txt notes: "worth adding a live cross-plugin integration
 * case then").
 *
 * Mirrors every sibling integration suite's shape: skips itself (rather
 * than failing) when MySQL isn't reachable, so `npm test` stays green
 * without Docker; `init.sh` and CI (see .github/workflows/ci.yml's `mysql`
 * service container) always have it up.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { MigrationError } from "../../../src/core/errors.js";
import { createDbPool } from "../../../src/plugins/database-mysql/src/pool.js";
import { createKyselyDb, type Database } from "../../../src/plugins/database-mysql/src/db.js";
import {
  createDbQueryCapability,
  type DbQueryCapability,
} from "../../../src/plugins/database-mysql/src/query-capability.js";
import {
  createDbTransactionCapability,
  type DbTransactionCapability,
} from "../../../src/plugins/database-mysql/src/transaction-capability.js";
import {
  MIGRATIONS_TABLE,
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

/** This suite's own plugin id — matches the real database-mysql plugin.json's `id`, per feature #22's convention. */
const PLUGIN_ID = "database-mysql";

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
    "[integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping the ` +
      "feature #27 end-to-end integration suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

async function tableExists(pool: mysql.Pool, tableName: string): Promise<boolean> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
    [tableName],
  );
  return Number(rows[0]?.["n"] ?? 0) > 0;
}

describe.runIf(mysqlReachable)("database-mysql — end-to-end integration (feature #27)", () => {
  let pool: mysql.Pool;
  let db: Kysely<Database>;
  let queryCapability: DbQueryCapability;
  let transactionCapability: DbTransactionCapability;
  let migrationsDir: string;

  beforeAll(async () => {
    pool = createDbPool(DOCKER_COMPOSE_CONFIG);
    db = createKyselyDb(pool);
    queryCapability = createDbQueryCapability(db);
    transactionCapability = createDbTransactionCapability(db);
    migrationsDir = mkdtempSync(path.join(tmpdir(), "appskeleton-feature27-integration-"));
  });

  afterAll(async () => {
    // Raw cleanup of every table/tracking row this suite could have
    // touched, regardless of which describe block last ran or failed.
    for (const table of [
      "database_mysql_integration_test_widgets",
      "database_mysql_integration_test_crud",
      "database_mysql_integration_test_txn",
      "rbac_integration_test_forbidden",
    ]) {
      await pool.query("DROP TABLE IF EXISTS `" + table + "`");
    }
    await pool.query(
      "DELETE FROM `" + MIGRATIONS_TABLE + "` WHERE `name` LIKE '9900_%' OR `name` LIKE '9901_%'",
    );
    rmSync(migrationsDir, { recursive: true, force: true });
    await db.destroy();
  });

  describe("1. migrations up/down", () => {
    const MIGRATION_NAME = "9900_database_mysql_integration_test_widgets.mjs";
    const TABLE = "database_mysql_integration_test_widgets";

    beforeAll(() => {
      writeFileSync(
        path.join(migrationsDir, MIGRATION_NAME),
        `export async function up(db) {\n` +
          `  await db.schema\n` +
          `    .createTable("${TABLE}")\n` +
          `    .addColumn("id", "integer", (col) => col.autoIncrement().primaryKey())\n` +
          `    .addColumn("label", "varchar(255)", (col) => col.notNull())\n` +
          `    .execute();\n` +
          `}\n\n` +
          `export async function down(db) {\n` +
          `  await db.schema.dropTable("${TABLE}").execute();\n` +
          `}\n`,
      );
    });

    it("applies a pending migration, records it in schema_migrations, and creates a usable table", async () => {
      const files = listMigrationFiles(migrationsDir).filter((f) => f.name === MIGRATION_NAME);

      const result = await runMigrationsUp(db, files, { pluginId: PLUGIN_ID });
      expect(result.applied).toEqual([MIGRATION_NAME]);
      expect(await tableExists(pool, TABLE)).toBe(true);

      const tracked = await db
        .selectFrom(MIGRATIONS_TABLE)
        .select(["name", "checksum", "applied_at"])
        .where("name", "=", MIGRATION_NAME)
        .executeTakeFirstOrThrow();
      expect(tracked.name).toBe(MIGRATION_NAME);
      expect(tracked.applied_at).toBeTruthy();
    });

    it("up() again is idempotent — nothing new applies", async () => {
      const files = listMigrationFiles(migrationsDir).filter((f) => f.name === MIGRATION_NAME);
      const result = await runMigrationsUp(db, files, { pluginId: PLUGIN_ID });
      expect(result.applied).toEqual([]);
    });

    it("down() rolls back the migration, dropping the table and its tracking row", async () => {
      const files = listMigrationFiles(migrationsDir).filter((f) => f.name === MIGRATION_NAME);

      const result = await runMigrationsDown(db, files, { pluginId: PLUGIN_ID });
      expect(result.rolledBack).toEqual([MIGRATION_NAME]);
      expect(await tableExists(pool, TABLE)).toBe(false);

      const stillTracked = await db
        .selectFrom(MIGRATIONS_TABLE)
        .select("name")
        .where("name", "=", MIGRATION_NAME)
        .executeTakeFirst();
      expect(stillTracked).toBeUndefined();
    });
  });

  describe("2. db:query capability — CRUD", () => {
    const TABLE = "database_mysql_integration_test_crud";
    // Plain string concatenation (not a template literal at the `.query()`
    // call site) — DDL fixture setup, not a capability-consumer code path;
    // see query-capability.integration.test.ts for the same rationale and
    // why this avoids the repo-wide no-restricted-syntax lint rule.
    const DROP_TABLE_SQL = "DROP TABLE IF EXISTS `" + TABLE + "`";
    const CREATE_TABLE_SQL =
      "CREATE TABLE `" +
      TABLE +
      "` (" +
      "id INT AUTO_INCREMENT PRIMARY KEY, " +
      "name VARCHAR(255) NOT NULL, " +
      "note VARCHAR(255) NULL" +
      ")";

    beforeAll(async () => {
      await pool.query(DROP_TABLE_SQL);
      await pool.query(CREATE_TABLE_SQL);
    });

    afterAll(async () => {
      await pool.query(DROP_TABLE_SQL);
    });

    it("creates a row through db:query", async () => {
      const inserted = await queryCapability.query((kdb) =>
        kdb
          .insertInto(TABLE)
          .values({ name: "Ada Lovelace", note: "first programmer" })
          .executeTakeFirstOrThrow(),
      );
      expect(inserted.insertId).toBeGreaterThan(0n);
    });

    it("reads the row back through db:query", async () => {
      const row = await queryCapability.query((kdb) =>
        kdb
          .selectFrom(TABLE)
          .select(["name", "note"])
          .where("name", "=", "Ada Lovelace")
          .executeTakeFirstOrThrow(),
      );
      expect(row).toEqual({ name: "Ada Lovelace", note: "first programmer" });
    });

    it("updates the row through db:query", async () => {
      await queryCapability.query((kdb) =>
        kdb
          .updateTable(TABLE)
          .set({ note: "first programmer, updated" })
          .where("name", "=", "Ada Lovelace")
          .execute(),
      );

      const row = await queryCapability.query((kdb) =>
        kdb
          .selectFrom(TABLE)
          .select("note")
          .where("name", "=", "Ada Lovelace")
          .executeTakeFirstOrThrow(),
      );
      expect(row.note).toBe("first programmer, updated");
    });

    it("deletes the row through db:query", async () => {
      await queryCapability.query((kdb) =>
        kdb.deleteFrom(TABLE).where("name", "=", "Ada Lovelace").execute(),
      );

      const row = await queryCapability.query((kdb) =>
        kdb.selectFrom(TABLE).select("name").where("name", "=", "Ada Lovelace").executeTakeFirst(),
      );
      expect(row).toBeUndefined();
    });
  });

  describe("3. db:transaction capability — commit/rollback", () => {
    const TABLE = "database_mysql_integration_test_txn";
    const DROP_TABLE_SQL = "DROP TABLE IF EXISTS `" + TABLE + "`";
    const CREATE_TABLE_SQL =
      "CREATE TABLE `" +
      TABLE +
      "` (" +
      "id INT AUTO_INCREMENT PRIMARY KEY, " +
      "name VARCHAR(255) NOT NULL UNIQUE" +
      ")";

    beforeAll(async () => {
      await pool.query(DROP_TABLE_SQL);
      await pool.query(CREATE_TABLE_SQL);
    });

    afterAll(async () => {
      await pool.query(DROP_TABLE_SQL);
    });

    it("commits every write when fn resolves", async () => {
      await transactionCapability.transaction(async (trx) => {
        await trx.insertInto(TABLE).values({ name: "Ada" }).execute();
        await trx.insertInto(TABLE).values({ name: "Grace" }).execute();
      });

      const rows = await db.selectFrom(TABLE).select("name").orderBy("name").execute();
      expect(rows).toEqual([{ name: "Ada" }, { name: "Grace" }]);
    });

    it("rolls back and leaves no partial writes when a statement fails midway", async () => {
      // `name` is UNIQUE — the second insert's duplicate fails at the
      // database level after the first insert already ran on this
      // transaction's connection.
      await expect(
        transactionCapability.transaction(async (trx) => {
          await trx.insertInto(TABLE).values({ name: "Alan" }).execute();
          await trx.insertInto(TABLE).values({ name: "Alan" }).execute(); // duplicate -> throws
          await trx.insertInto(TABLE).values({ name: "Never Reached" }).execute();
        }),
      ).rejects.toMatchObject({ code: "DATABASE_ERROR" });

      const rows = await db.selectFrom(TABLE).select("name").execute();
      const names = rows.map((r) => r.name);
      expect(names).not.toContain("Alan");
      expect(names).not.toContain("Never Reached");
      // The pre-existing committed rows from the prior test are untouched.
      expect(names).toEqual(["Ada", "Grace"]);
    });
  });

  describe("4. namespace enforcement — real migration against real MySQL", () => {
    const VIOLATING_MIGRATION = "9901_database_mysql_integration_test_violation.mjs";
    const FORBIDDEN_TABLE = "rbac_integration_test_forbidden";

    beforeAll(() => {
      // A migration filed under this plugin's own migrations (pluginId
      // "database-mysql") that tries to create a table under a *different*
      // plugin's namespace prefix ("rbac_") — feature #22's guard must
      // reject this before anything reaches MySQL, exactly the live,
      // real-database case flagged as future work in feature #22's own
      // progress notes (previously only proven against a fake `db.schema`
      // stand-in in migrator.test.ts).
      writeFileSync(
        path.join(migrationsDir, VIOLATING_MIGRATION),
        `export async function up(db) {\n` +
          `  await db.schema\n` +
          `    .createTable("${FORBIDDEN_TABLE}")\n` +
          `    .addColumn("id", "integer", (col) => col.autoIncrement().primaryKey())\n` +
          `    .execute();\n` +
          `}\n\n` +
          `export async function down(db) {\n` +
          `  await db.schema.dropTable("${FORBIDDEN_TABLE}").execute();\n` +
          `}\n`,
      );
    });

    it("rejects up() with a MigrationError naming the plugin, table, and required prefix — nothing is created", async () => {
      const files = listMigrationFiles(migrationsDir).filter((f) => f.name === VIOLATING_MIGRATION);

      let caught: unknown;
      try {
        await runMigrationsUp(db, files, { pluginId: PLUGIN_ID });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(MigrationError);
      const migrationError = caught as MigrationError;
      expect(migrationError.code).toBe("MIGRATION_ERROR");
      expect(migrationError.details).toMatchObject({
        pluginId: PLUGIN_ID,
        tableName: FORBIDDEN_TABLE,
        requiredPrefix: "database_mysql_",
        reason: "table_namespace_violation",
      });

      // The table was never created against the real database, and the
      // migration was never recorded as applied — the guard trips before
      // the migration's own transaction commits anything.
      expect(await tableExists(pool, FORBIDDEN_TABLE)).toBe(false);
      const tracked = await db
        .selectFrom(MIGRATIONS_TABLE)
        .select("name")
        .where("name", "=", VIOLATING_MIGRATION)
        .executeTakeFirst();
      expect(tracked).toBeUndefined();
    });
  });
});

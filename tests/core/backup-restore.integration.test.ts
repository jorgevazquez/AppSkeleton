/**
 * Integration test for feature #28 ("Backup and restore helper scripts"),
 * step 3: "back up and restore a small dataset and assert row-for-row
 * equality". Exercises `scripts/backup.sh` and `scripts/restore.sh`
 * end-to-end, as real child processes, against the real docker-compose
 * MySQL instance — see docs/backup-restore.md.
 *
 * Mirrors every sibling `*.integration.test.ts` suite's shape (e.g.
 * tests/plugins/database-mysql/migrator.integration.test.ts,
 * transaction-capability.integration.test.ts): skips itself (rather than
 * failing) when MySQL isn't reachable, so `npm test` stays green without
 * Docker; `init.sh` and CI (see .github/workflows/ci.yml's `mysql` service
 * container) always have it up.
 *
 * Unlike those suites, this one deliberately does NOT go through
 * pool.ts/db.ts — the scripts under test are plain shell, invoked exactly
 * as an operator or cron job would (`bash scripts/backup.sh ...`), so the
 * test drives them the same way rather than reimplementing them via the
 * app's own driver wiring.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

/** Matches docker-compose.yml's `mysql` service credentials. */
const DOCKER_COMPOSE_CONFIG = {
  DB_HOST: "127.0.0.1",
  DB_PORT: "3306",
  DB_USER: "appskeleton",
  DB_PASSWORD: "change-me",
  DB_NAME: "appskeleton",
};

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BACKUP_SCRIPT = path.join(REPO_ROOT, "scripts", "backup.sh");
const RESTORE_SCRIPT = path.join(REPO_ROOT, "scripts", "restore.sh");

const TABLE = "backup_restore_test_widgets";

// Built as plain strings (not template literals with interpolated
// expressions) so this DDL fixture setup doesn't trip the repo-wide
// `no-restricted-syntax` lint rule — see transaction-capability.integration
// .test.ts / query-capability.integration.test.ts for the same rationale.
const DROP_TABLE_SQL = "DROP TABLE IF EXISTS `" + TABLE + "`";
const CREATE_TABLE_SQL =
  "CREATE TABLE `" + TABLE + "` (" + "id INT PRIMARY KEY, " + "name VARCHAR(255) NOT NULL" + ")";

/** The small seeded dataset the backup/restore round trip must reproduce exactly. */
const SEED_ROWS = [
  { id: 1, name: "Widget A" },
  { id: 2, name: "Widget B" },
  { id: 3, name: "Widget C" },
];

async function probeMysqlReachable(): Promise<boolean> {
  try {
    const probe = await mysql.createConnection({
      host: DOCKER_COMPOSE_CONFIG.DB_HOST,
      port: Number(DOCKER_COMPOSE_CONFIG.DB_PORT),
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
    "[backup-restore.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping integration ` +
      "suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

describe.runIf(mysqlReachable)("backup.sh / restore.sh — round-trip integration", () => {
  let pool: mysql.Pool;
  let tmpDir: string;

  async function readWidgetRows(): Promise<Array<{ id: number; name: string }>> {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT id, name FROM `" + TABLE + "` ORDER BY id",
    );
    return rows.map((row) => ({ id: Number(row["id"]), name: String(row["name"]) }));
  }

  beforeAll(async () => {
    pool = mysql.createPool({
      host: DOCKER_COMPOSE_CONFIG.DB_HOST,
      port: Number(DOCKER_COMPOSE_CONFIG.DB_PORT),
      user: DOCKER_COMPOSE_CONFIG.DB_USER,
      password: DOCKER_COMPOSE_CONFIG.DB_PASSWORD,
      database: DOCKER_COMPOSE_CONFIG.DB_NAME,
    });

    // Raw DDL/DML fixture setup — not a script-under-test consumer path.
    await pool.query(DROP_TABLE_SQL);
    await pool.query(CREATE_TABLE_SQL);
    for (const row of SEED_ROWS) {
      await pool.query("INSERT INTO `" + TABLE + "` (id, name) VALUES (?, ?)", [row.id, row.name]);
    }

    tmpDir = mkdtempSync(path.join(tmpdir(), "appskeleton-backup-restore-"));
  });

  afterAll(async () => {
    await pool.query(DROP_TABLE_SQL);
    await pool.end();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("backs up, mutates, restores, and reproduces the seeded dataset row-for-row", async () => {
    // Sanity check: the seed actually landed before we touch it.
    await expect(readWidgetRows()).resolves.toEqual(SEED_ROWS);

    const backupFile = path.join(tmpDir, "dataset.sql.gz");
    const env = { ...process.env, ...DOCKER_COMPOSE_CONFIG };

    // 1. Back up the seeded dataset.
    await execFileAsync("bash", [BACKUP_SCRIPT, backupFile], { env, cwd: REPO_ROOT });

    // 2. Mutate the table so it no longer matches what was backed up —
    //    proves the restore below actually restores state rather than the
    //    assertion trivially passing because nothing changed.
    await pool.query("DELETE FROM `" + TABLE + "`");
    await pool.query("INSERT INTO `" + TABLE + "` (id, name) VALUES (?, ?)", [
      999,
      "Mutated After Backup",
    ]);
    await expect(readWidgetRows()).resolves.toEqual([{ id: 999, name: "Mutated After Backup" }]);

    // 3. Restore from the backup taken in step 1. --force skips the
    //    interactive confirmation prompt (see docs/backup-restore.md §4).
    await execFileAsync("bash", [RESTORE_SCRIPT, backupFile, "--force"], {
      env,
      cwd: REPO_ROOT,
    });

    // 4. Row-for-row equality with the originally seeded dataset.
    await expect(readWidgetRows()).resolves.toEqual(SEED_ROWS);
  });
});

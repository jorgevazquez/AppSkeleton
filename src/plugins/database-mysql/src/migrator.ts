/**
 * The migration runner (feature #19 — "Migration runner: versioned,
 * checksum-verified, up/down, tracked in a migrations table").
 *
 * spec.md: "a migration runner (versioned, forward-only, checksum-verified)"
 * — this module is that runner. Migrations are plain `.ts`/`.js`/`.mjs`/
 * `.cjs` files living in a directory (by default this plugin's own
 * `src/migrations/`), each exporting an `up(db)` and a `down(db)` function
 * that receive the plugin's shared `Kysely<Database>` instance (or a
 * `Transaction<Database>` — a subtype — when run inside this module's own
 * per-migration transaction). Filenames are expected to start with a
 * zero-padded sequence number (`0001_create_widgets.ts`) so lexicographic
 * sort order is also run order — this module never inspects file content to
 * decide ordering, only the filename.
 *
 * ## Tracking table
 *
 * Every applied migration is recorded in {@link MIGRATIONS_TABLE}
 * (`id` autoincrement PK, `name` unique, `checksum`, `applied_at`) —
 * exactly the four columns this feature's step 1 names. The table is
 * created (`CREATE TABLE IF NOT EXISTS`) lazily, on the first `up()`/
 * `down()` call, so a fresh database needs no separate bootstrap step.
 *
 * ## Checksum verification
 *
 * `checksum` is a sha256 hex digest of the migration file's raw source
 * text (see {@link computeChecksum}), computed fresh from disk every run
 * and compared against what was recorded when the migration was applied.
 * {@link verifyAppliedChecksums} runs this check for *every* already-applied
 * migration before a single pending migration is executed (both directions
 * — `up()` and `down()` both call it first) — see this feature's step 2:
 * a modified already-applied migration file (or one that's been deleted
 * outright) throws a {@link MigrationError} and nothing runs, rather than
 * silently building on top of, or rolling back, a file that no longer
 * matches what actually ran.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sql, type Kysely } from "kysely";
import { MigrationError } from "../../../core/errors.js";
import type { Database } from "./db.js";

/** Tracks every applied migration: `id` (PK), `name`, `checksum`, `applied_at`. */
export const MIGRATIONS_TABLE = "schema_migrations";

/** A migration filename must start with a run-order-determining number, e.g. `0001_create_widgets.ts`. */
const MIGRATION_FILE_PATTERN = /^\d+.*\.(m?js|cjs|ts)$/;

/** A migration file discovered on disk, with its checksum already computed from its raw source text. */
export interface MigrationFile {
  /** Filename — the stable identifier stored in {@link MIGRATIONS_TABLE}'s `name` column. */
  name: string;
  /** Absolute path on disk. */
  filePath: string;
  /** sha256 hex digest of the file's raw source text. */
  checksum: string;
}

/** The shape a migration file's module must export. */
export interface MigrationModule {
  up(db: Kysely<Database>): Promise<void>;
  down(db: Kysely<Database>): Promise<void>;
}

/** A row from {@link MIGRATIONS_TABLE}. */
export interface AppliedMigrationRow {
  id: number;
  name: string;
  checksum: string;
  applied_at: Date | string;
}

/** sha256 hex digest of a migration file's raw source text. */
export function computeChecksum(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/**
 * Discover migration files in `migrationsDir`, sorted by filename (run
 * order). A non-existent directory returns an empty list rather than
 * throwing — a plugin/project with no migrations yet is a normal, common
 * state (mirrors registry.ts's "missing manifest is a per-item, not fatal,
 * condition" precedent), not a misconfiguration.
 */
export function listMigrationFiles(migrationsDir: string): MigrationFile[] {
  if (!existsSync(migrationsDir)) {
    return [];
  }
  return readdirSync(migrationsDir)
    .filter((entry) => MIGRATION_FILE_PATTERN.test(entry))
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => {
      const filePath = path.join(migrationsDir, entry);
      const checksum = computeChecksum(readFileSync(filePath, "utf8"));
      return { name: entry, filePath, checksum };
    });
}

/** Dynamically import a migration file and validate it exports both `up` and `down`. */
async function importMigrationModule(file: MigrationFile): Promise<MigrationModule> {
  const imported: unknown = await import(pathToFileURL(file.filePath).href);
  const candidate = imported as Partial<MigrationModule>;
  if (typeof candidate.up !== "function" || typeof candidate.down !== "function") {
    throw new MigrationError(
      `Migration "${file.name}" must export both an "up(db)" and a "down(db)" function.`,
      { details: { migration: file.name, reason: "malformed_module" } },
    );
  }
  return candidate as MigrationModule;
}

/** Create {@link MIGRATIONS_TABLE} if it doesn't already exist. Safe to call on every run. */
export async function ensureMigrationsTable(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable(MIGRATIONS_TABLE)
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.autoIncrement().primaryKey())
    .addColumn("name", "varchar(255)", (col) => col.notNull().unique())
    .addColumn("checksum", "varchar(64)", (col) => col.notNull())
    .addColumn("applied_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
}

/** Every applied migration, ordered by `id` (i.e. the order they were applied in). */
export async function getAppliedMigrations(db: Kysely<Database>): Promise<AppliedMigrationRow[]> {
  const rows = await db.selectFrom(MIGRATIONS_TABLE).selectAll().orderBy("id", "asc").execute();
  return rows as unknown as AppliedMigrationRow[];
}

/**
 * Verify every already-applied migration's recorded checksum still matches
 * its file's checksum right now. Throws {@link MigrationError} — naming the
 * migration and both checksums, never file contents — on the first
 * mismatch, or if an applied migration's file is missing entirely. Pure and
 * synchronous: takes the already-gathered `applied` rows and `files` list
 * rather than doing its own I/O, so it's cheap to unit test in isolation.
 */
export function verifyAppliedChecksums(
  applied: readonly AppliedMigrationRow[],
  files: readonly MigrationFile[],
): void {
  const byName = new Map(files.map((file) => [file.name, file]));
  for (const row of applied) {
    const file = byName.get(row.name);
    if (!file) {
      throw new MigrationError(
        `Applied migration "${row.name}" is missing its file on disk — cannot verify or run it.`,
        { details: { migration: row.name, reason: "missing_file" } },
      );
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `Migration "${row.name}" has been modified since it was applied ` +
          `(recorded checksum ${row.checksum}, file now hashes to ${file.checksum}). ` +
          "Refusing to run further migrations until this is resolved.",
        {
          details: {
            migration: row.name,
            reason: "checksum_mismatch",
            recordedChecksum: row.checksum,
            currentChecksum: file.checksum,
          },
        },
      );
    }
  }
}

/** Migration files not yet recorded as applied, in run order. */
export function planPendingMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigrationRow[],
): MigrationFile[] {
  const appliedNames = new Set(applied.map((row) => row.name));
  return files.filter((file) => !appliedNames.has(file.name));
}

export interface MigrateUpResult {
  /** Names of migrations applied by this call, in the order they ran. Empty if nothing was pending. */
  applied: string[];
}

/**
 * Apply every pending migration, in order. Ensures {@link MIGRATIONS_TABLE}
 * exists, then verifies every already-applied migration's checksum
 * (see {@link verifyAppliedChecksums}) *before* running anything pending.
 * Each migration runs in its own transaction: its `up(db)` plus the
 * corresponding `INSERT` into {@link MIGRATIONS_TABLE} commit together, so a
 * later migration's failure can never leave an earlier one half-recorded.
 */
export async function runMigrationsUp(
  db: Kysely<Database>,
  files: readonly MigrationFile[],
): Promise<MigrateUpResult> {
  await ensureMigrationsTable(db);
  const applied = await getAppliedMigrations(db);
  verifyAppliedChecksums(applied, files);

  const pending = planPendingMigrations(files, applied);
  const appliedNames: string[] = [];
  for (const file of pending) {
    const migration = await importMigrationModule(file);
    await db.transaction().execute(async (trx) => {
      await migration.up(trx);
      await trx
        .insertInto(MIGRATIONS_TABLE)
        .values({ name: file.name, checksum: file.checksum })
        .execute();
    });
    appliedNames.push(file.name);
  }
  return { applied: appliedNames };
}

export interface MigrateDownOptions {
  /** How many already-applied migrations to roll back, most-recently-applied first. Defaults to 1. */
  steps?: number;
}

export interface MigrateDownResult {
  /** Names of migrations rolled back by this call, most-recently-applied first. Empty if nothing was applied. */
  rolledBack: string[];
}

/**
 * Roll back the `steps` most-recently-applied migrations (default: 1),
 * most-recent first. Ensures {@link MIGRATIONS_TABLE} exists and verifies
 * every already-applied migration's checksum first, exactly like
 * {@link runMigrationsUp} — a modified migration file must be resolved
 * before its `down()` can be trusted to run either. Each migration's
 * `down(db)` plus the corresponding `DELETE` from {@link MIGRATIONS_TABLE}
 * run together in one transaction.
 */
export async function runMigrationsDown(
  db: Kysely<Database>,
  files: readonly MigrationFile[],
  options: MigrateDownOptions = {},
): Promise<MigrateDownResult> {
  const steps = options.steps ?? 1;
  await ensureMigrationsTable(db);
  const applied = await getAppliedMigrations(db);
  verifyAppliedChecksums(applied, files);

  if (steps <= 0) {
    return { rolledBack: [] };
  }

  const byName = new Map(files.map((file) => [file.name, file]));
  const targets = applied.slice(Math.max(applied.length - steps, 0)).reverse();

  const rolledBack: string[] = [];
  for (const row of targets) {
    const file = byName.get(row.name);
    if (!file) {
      // verifyAppliedChecksums() above already guarantees every applied row
      // has a matching file — this branch exists only to keep this
      // function's own reasoning self-contained and the map lookup typed.
      throw new MigrationError(`Cannot roll back missing migration file "${row.name}".`, {
        details: { migration: row.name, reason: "missing_file" },
      });
    }
    const migration = await importMigrationModule(file);
    await db.transaction().execute(async (trx) => {
      await migration.down(trx);
      await trx.deleteFrom(MIGRATIONS_TABLE).where("name", "=", row.name).execute();
    });
    rolledBack.push(row.name);
  }
  return { rolledBack };
}

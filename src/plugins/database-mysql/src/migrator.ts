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
 *
 * ## Per-plugin table namespace enforcement (feature #22)
 *
 * spec.md: "a per-plugin schema/table namespace convention so plugins
 * cannot collide". The convention is `<plugin_id>_<table>` — a plugin's
 * migrations may only create tables prefixed with that plugin's own id
 * (hyphens become underscores, since MySQL identifiers are conventionally
 * snake_case: plugin id `database-mysql` → prefix `database_mysql_`, e.g.
 * `database_mysql_widgets`; see {@link pluginTablePrefix}). `runMigrationsUp`/
 * `runMigrationsDown` both take a required `pluginId` and wrap the
 * `Kysely`/`Transaction` instance handed to a migration's `up`/`down` (see
 * {@link withTableNamespaceGuard}) so that `db.schema.createTable(name)` is
 * checked (via {@link assertTableNamespace}) *before* the real call ever
 * runs — a migration that creates a table outside its own plugin's
 * namespace throws a {@link MigrationError} and creates nothing. Because
 * every plugin's prefix is unique (plugin ids are unique — enforced at
 * manifest-validation time), rejecting anything that isn't under a
 * migration's own prefix necessarily also rejects any table name that
 * happens to fall inside a *different* plugin's namespace — there's no
 * need for the runner to separately enumerate every other plugin's id to
 * catch that case. The `schema_migrations` tracking table itself is exempt
 * (it's kernel bookkeeping, not a plugin-owned domain table — see this
 * module's `MIGRATIONS_TABLE` and feature #19's notes) since the guard
 * only wraps the object passed *into* a migration module, never the
 * runner's own internal `ensureMigrationsTable()`/tracking-row calls.
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

/**
 * Convert a plugin id (kebab-case, e.g. `"database-mysql"`) into its table
 * naming prefix (`"database_mysql_"`) — hyphens become underscores (MySQL
 * identifiers are conventionally snake_case) and a trailing `_` is added so
 * callers can prepend it straight onto a table's own name. See this
 * module's "Per-plugin table namespace enforcement" doc section above.
 */
export function pluginTablePrefix(pluginId: string): string {
  return `${pluginId.replace(/-/g, "_")}_`;
}

/**
 * Enforce the `<plugin_id>_<table>` naming convention (feature #22, step 1)
 * for a single table name a migration is about to create. Throws
 * {@link MigrationError} if `tableName` isn't prefixed with `pluginId`'s own
 * {@link pluginTablePrefix} — which also covers step 2 ("reject a migration
 * that creates a table violating another plugin's namespace"): since plugin
 * ids are unique, a table name outside a migration's own prefix can only
 * ever be either malformed or claim some other plugin's namespace, and
 * both are rejected identically here.
 */
export function assertTableNamespace(pluginId: string, tableName: string): void {
  const prefix = pluginTablePrefix(pluginId);
  if (tableName.startsWith(prefix) && tableName.length > prefix.length) {
    return;
  }
  throw new MigrationError(
    `Migration for plugin "${pluginId}" attempted to create table "${tableName}", which is outside ` +
      `its own namespace. Every table a plugin's migrations create must be named "${prefix}<table>" ` +
      `(e.g. "${prefix}widgets") so it can never collide with another plugin's tables.`,
    {
      details: {
        pluginId,
        tableName,
        requiredPrefix: prefix,
        reason: "table_namespace_violation",
      },
    },
  );
}

/**
 * Bind every function-valued property `target` exposes to `target` itself
 * before handing it back, and force `receiver = target` when reading a
 * getter (e.g. Kysely's `schema` getter, which constructs a fresh
 * `SchemaModule` per access). Kysely's own classes hold their state in true
 * private (`#`) fields, which throw if a method (or a getter) ever runs
 * with `this` bound to anything other than the exact instance that
 * constructed them — a plain `Proxy` that returns methods unbound would
 * break the instant a caller does `guarded.someMethod()`, since a member
 * call binds `this` to the proxy, not the real target. Binding up front
 * sidesteps that entirely: whatever the caller does with the returned
 * function, `this` is always the real instance.
 */
function bindToTarget<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop, t);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

/**
 * Wrap a `Kysely`/`Transaction` instance so that any `db.schema.createTable(name)`
 * call is checked with {@link assertTableNamespace} *before* the real
 * `createTable` runs — a migration that creates a table outside its own
 * plugin's namespace throws immediately and nothing is ever sent to MySQL.
 * Every other property/method (including every other `schema.*` method,
 * e.g. `dropTable`/`alterTable`) passes through untouched (via
 * {@link bindToTarget}) — this guard is deliberately narrow, matching this
 * feature's literal scope ("reject a migration that *creates* a table...").
 * Exported (rather than kept module-private like {@link bindToTarget}) so
 * this wiring — not just {@link assertTableNamespace}'s pure logic — has
 * direct unit coverage against a lightweight fake `Kysely`-shaped object,
 * without needing a real MySQL connection.
 */
export function withTableNamespaceGuard<T extends Kysely<Database>>(trx: T, pluginId: string): T {
  return new Proxy(trx, {
    get(target, prop) {
      if (prop === "schema") {
        // Force receiver = target so Kysely's `get schema()` getter builds
        // its SchemaModule correctly bound to the real transaction, not
        // this proxy — see bindToTarget's doc comment.
        const realSchema = Reflect.get(target, "schema", target) as object;
        const guardedSchema = bindToTarget(realSchema);
        return new Proxy(guardedSchema, {
          get(schemaTarget, schemaProp) {
            const value = Reflect.get(schemaTarget, schemaProp) as unknown;
            if (schemaProp === "createTable" && typeof value === "function") {
              return (tableName: string, ...rest: unknown[]) => {
                assertTableNamespace(pluginId, tableName);
                return (value as (...args: unknown[]) => unknown)(tableName, ...rest);
              };
            }
            return value;
          },
        });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
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

export interface MigrateUpOptions {
  /**
   * The id of the plugin these migration files belong to (e.g.
   * `"database-mysql"`). Required — every table a migration creates is
   * checked against this plugin's own namespace prefix (see
   * {@link assertTableNamespace}) before it's allowed to run.
   */
  pluginId: string;
}

/**
 * Apply every pending migration, in order. Ensures {@link MIGRATIONS_TABLE}
 * exists, then verifies every already-applied migration's checksum
 * (see {@link verifyAppliedChecksums}) *before* running anything pending.
 * Each migration runs in its own transaction: its `up(db)` plus the
 * corresponding `INSERT` into {@link MIGRATIONS_TABLE} commit together, so a
 * later migration's failure can never leave an earlier one half-recorded.
 * The `db` handed to the migration's own `up()` is wrapped with
 * {@link withTableNamespaceGuard} using `options.pluginId` — a migration
 * that tries to create a table outside its own plugin's namespace throws
 * a {@link MigrationError} (feature #22) and its transaction rolls back,
 * so nothing it did partially commits.
 */
export async function runMigrationsUp(
  db: Kysely<Database>,
  files: readonly MigrationFile[],
  options: MigrateUpOptions,
): Promise<MigrateUpResult> {
  await ensureMigrationsTable(db);
  const applied = await getAppliedMigrations(db);
  verifyAppliedChecksums(applied, files);

  const pending = planPendingMigrations(files, applied);
  const appliedNames: string[] = [];
  for (const file of pending) {
    const migration = await importMigrationModule(file);
    await db.transaction().execute(async (trx) => {
      await migration.up(withTableNamespaceGuard(trx, options.pluginId));
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
  /**
   * The id of the plugin these migration files belong to. Required — see
   * {@link MigrateUpOptions.pluginId}; the same namespace guard applies to
   * `down()` migrations for consistency, even though a downgrade creating a
   * table is unusual.
   */
  pluginId: string;
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
  options: MigrateDownOptions,
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
      await migration.down(withTableNamespaceGuard(trx, options.pluginId));
      await trx.deleteFrom(MIGRATIONS_TABLE).where("name", "=", row.name).execute();
    });
    rolledBack.push(row.name);
  }
  return { rolledBack };
}

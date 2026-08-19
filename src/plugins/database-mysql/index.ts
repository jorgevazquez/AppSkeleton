/**
 * database-mysql plugin lifecycle module.
 *
 * `plugin.json` (feature #17) has declared `entry_point: "index.ts"` and
 * `capabilities.provides: ["db:query", "db:transaction", "db:migrate"]`
 * since this plugin's manifest first landed, but — per this plugin's own
 * README and every sibling feature's `claude-progress.txt` notes (features
 * #20/#27/#34/#36) — no lifecycle module existed yet to actually wire
 * those already-built pieces (pool.ts/db.ts/query-capability.ts/
 * transaction-capability.ts/migrator.ts, features #18-27) into the
 * kernel's plugin loader. Every one of those features exercised its own
 * `src/` module directly instead. This module is that missing wiring,
 * built out as feature #29's own prerequisite: feature #29 ("Persist the
 * kernel audit trail into MySQL once the database plugin is available")
 * step 2 needs "once database-mysql has loaded" to be a real, checkable
 * condition, which requires this plugin to be loadable at all.
 *
 * ## Lifecycle
 *
 * - `onInstall` — synchronous. Loads `DB_*` config (`src/config.ts`) and
 *   fails fast (`ConfigError`) if it's missing/invalid — exactly the
 *   "falling back to in-memory [audit sink] if the DB plugin is disabled"
 *   case feature #29 describes: an operator who hasn't configured a
 *   database at all gets an isolated, logged plugin-load failure (per
 *   `loader.ts`'s per-plugin isolation), not a crashed kernel.
 * - `onEnable` — async. Builds the mysql2 pool (`pool.ts`), proves
 *   connectivity with retry (`connectWithRetry`, feature #23), builds the
 *   shared `Kysely<Database>` instance wired to slow-query
 *   logging/metrics (`db.ts`/`query-metrics.ts`, feature #26), and runs
 *   this plugin's own migrations (`src/migrations/`, currently just
 *   feature #29's own `database_mysql_audit_log` table) via the
 *   checksum-verified runner (`migrator.ts`, feature #19) — so the audit
 *   log table exists by the time this plugin finishes loading, before
 *   `server/index.ts`'s bootstrap ever tries to build a MySQL-backed audit
 *   sink against it. The same `pool` instance is also handed to
 *   `createDbQueryCapability()` (feature #30) so `db:query`'s
 *   `getPoolMetrics()` — and, through it, `core/introspect.ts`'s kernel
 *   introspection report — can read the pool's live active/idle/queued
 *   connection counts.
 * - `onDisable` — destroys the `Kysely` instance (which also closes the
 *   underlying mysql2 pool — see `db.ts`'s docs on why there is only ever
 *   one pool), so a runtime `kernel.disablePlugin("database-mysql")`
 *   (feature #16) doesn't leak connections.
 *
 * ## `db:migrate` — generic, not just for this plugin's own migrations
 *
 * Unlike `db:query`/`db:transaction` (thin, stable wrappers around this
 * plugin's own shared `db` instance), `db:migrate`'s two methods take an
 * explicit `{ pluginId, migrationsDir }` — there is no way for a plain
 * object capability implementation to know which plugin is calling it
 * (`broker.ts`'s `obtain()` does not thread caller identity into the
 * handle itself), so a capability consumer must name its own migrations
 * directory and plugin id explicitly, exactly like `rbac/src/
 * migrations-dir.ts`'s already-exported `RBAC_MIGRATIONS_DIR` anticipates
 * ("a future `db:migrate`-capability wiring ... can point it at this
 * plugin's own `src/migrations/`"). This plugin's *own* migrations
 * (below, in `onEnable`) are applied by calling `runMigrationsUp`
 * directly — an ordinary same-plugin call, not a round trip through this
 * plugin's own broker-registered capability.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely, Transaction } from "kysely";
import type { Pool } from "mysql2/promise";
import type { PluginLifecycleContext } from "../../core/loader.js";
import { loadDbConfig } from "./src/config.js";
import { createKyselyDb, type Database } from "./src/db.js";
import { connectWithRetry, createDbPool } from "./src/pool.js";
import { createDbQueryCapability, type DbQueryCapability } from "./src/query-capability.js";
import {
  createDbTransactionCapability,
  type DbTransactionCapability,
} from "./src/transaction-capability.js";
import { createQueryMetricsRecorder, createSlowQueryLogger } from "./src/query-metrics.js";
import {
  listMigrationFiles,
  runMigrationsDown,
  runMigrationsUp,
  type MigrateDownResult,
  type MigrateUpResult,
} from "./src/migrator.js";

/** This plugin's own id — matches `plugin.json`'s `id` field (feature #17). */
export const PLUGIN_ID = "database-mysql";

/** Absolute path to this plugin's own `src/migrations/` directory. */
export const DATABASE_MYSQL_MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "src/migrations",
);

/** The object registered with the capability broker as the `db:migrate` provider. See this module's "`db:migrate` — generic" docs. */
export interface DbMigrateCapability {
  up(options: { pluginId: string; migrationsDir: string }): Promise<MigrateUpResult>;
  down(options: {
    pluginId: string;
    migrationsDir: string;
    steps?: number;
  }): Promise<MigrateDownResult>;
}

/** This plugin's live runtime state — `undefined` until `onEnable` finishes constructing it. */
interface RuntimeState {
  readonly pool: Pool;
  readonly db: Kysely<Database>;
  readonly queryCapability: DbQueryCapability;
  readonly transactionCapability: DbTransactionCapability;
}

let state: RuntimeState | undefined;

/** Test-only escape hatch mirroring `rbac/index.ts`'s `resetPolicyStoreForTests()` precedent — lets a test observe/clear module-level state between runs without a fresh process. */
export function getRuntimeStateForTests(): RuntimeState | undefined {
  return state;
}

function requireState(): RuntimeState {
  if (!state) {
    throw new Error(
      `${PLUGIN_ID}: capability used before onEnable finished constructing the connection pool.`,
    );
  }
  return state;
}

/**
 * `provides` is built at module scope (registered with the broker before
 * any lifecycle hook runs — see `loader.ts`'s declare-before-hooks
 * ordering) with thin indirection wrappers, exactly like `api-gateway/
 * index.ts`'s `getApp()` precedent: the real capability objects don't
 * exist until `onEnable` has a live `db`/pool to build them from, but the
 * broker needs a stable, always-present object to register *now*. Every
 * wrapper method simply forwards to `requireState()`'s real
 * implementation at call time.
 */
export const provides: Readonly<Record<string, unknown>> = {
  "db:query": {
    // Method-shorthand (not an arrow-function property) so `<T>` stays a
    // real generic on this wrapper — an arrow-function property's type
    // would be pinned by contextual typing from `satisfies
    // DbQueryCapability` to a single, non-generic call shape, weakening
    // every caller's inferred return type to `unknown`.
    query<T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T> {
      return requireState().queryCapability.query(fn);
    },
    healthCheck: () => requireState().queryCapability.healthCheck(),
    getMetrics: () => requireState().queryCapability.getMetrics(),
    getPoolMetrics: () => requireState().queryCapability.getPoolMetrics(),
  } satisfies DbQueryCapability,
  "db:transaction": {
    transaction<T>(fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
      return requireState().transactionCapability.transaction(fn);
    },
  } satisfies DbTransactionCapability,
  "db:migrate": {
    async up({ pluginId, migrationsDir }) {
      const { db } = requireState();
      return runMigrationsUp(db, listMigrationFiles(migrationsDir), { pluginId });
    },
    async down({ pluginId, migrationsDir, steps }) {
      const { db } = requireState();
      return runMigrationsDown(db, listMigrationFiles(migrationsDir), {
        pluginId,
        ...(steps !== undefined ? { steps } : {}),
      });
    },
  } satisfies DbMigrateCapability,
};

/**
 * Synchronous: loads and validates `DB_*` config (`config.ts`) up front so
 * a missing/malformed value fails this plugin's load *immediately* with a
 * clear `ConfigError` (isolated by `loader.ts`, per-plugin — see this
 * module's docs) rather than surfacing later as an opaque connection
 * error from inside `onEnable`. Nothing async happens here — connecting to
 * MySQL is `onEnable`'s job.
 */
export function onInstall(_context: PluginLifecycleContext): void {
  loadDbConfig();
}

/**
 * Builds the pool/`Kysely` instance, proves connectivity, and applies this
 * plugin's own migrations — see this module's "Lifecycle" docs.
 */
export async function onEnable(context: PluginLifecycleContext): Promise<void> {
  const config = loadDbConfig();
  const pool = createDbPool(config);
  await connectWithRetry(pool);

  const metrics = createQueryMetricsRecorder();
  const db = createKyselyDb(pool, {
    log: createSlowQueryLogger({
      logger: context.logger,
      metrics,
      ...(config.DB_SLOW_QUERY_THRESHOLD_MS !== undefined
        ? { thresholdMs: config.DB_SLOW_QUERY_THRESHOLD_MS }
        : {}),
    }),
  });

  await runMigrationsUp(db, listMigrationFiles(DATABASE_MYSQL_MIGRATIONS_DIR), {
    pluginId: PLUGIN_ID,
  });

  state = {
    pool,
    db,
    queryCapability: createDbQueryCapability(db, { metrics, pool }),
    transactionCapability: createDbTransactionCapability(db),
  };
}

/** Releases the `Kysely` instance (and, with it, the underlying mysql2 pool — see `db.ts`'s docs) so a runtime disable (feature #16) doesn't leak connections. */
export async function onDisable(): Promise<void> {
  await state?.db.destroy();
  state = undefined;
}

/**
 * Seed data / fixtures mechanism for local development (feature #25).
 *
 * spec.md's kernel has no business logic of its own, but a *seed runner* is
 * infrastructure, not a domain concern — exactly like migrator.ts's
 * migration runner, just deliberately NOT that runner (feature #25 step 1:
 * "a seed runner separate from migrations"). It lives here in `src/core`
 * rather than inside the `database-mysql` plugin specifically so that ANY
 * plugin (not just database-mysql's own future consumers) can register dev
 * fixtures with it: docs/plugin-conventions.md section 5 forbids a plugin
 * from importing another plugin's internals directly, but explicitly
 * allows importing from `src/core/**` — so `rbac`'s future "seed default
 * roles" feature and `wiki`'s future "seed starter Home page" feature (both
 * already reference "the seed mechanism from feature 25" in
 * feature_list.json) call {@link registerSeed} from here, not from some
 * database-mysql-owned module.
 *
 * ## Registration, not discovery
 *
 * Unlike migrations (discovered by scanning a directory of numbered files —
 * see migrator.ts's `listMigrationFiles`), seeds are explicitly
 * *registered*: a plugin calls {@link registerSeed}`(pluginId, name, run)`
 * — typically from a `seeds/index.ts` at the root of its own plugin
 * directory, imported once (for its module-scope registration side effect)
 * by `src/cli/seed.ts` before {@link runSeeds} runs. Each registration's
 * key is `"<pluginId>:<name>"` (see {@link seedKey}) — namespaced by plugin
 * exactly like migrator.ts's `<plugin_id>_<table>` table-naming convention
 * (feature #22), so two plugins can each register a seed named e.g.
 * `"defaults"` without colliding.
 *
 * ## Idempotency
 *
 * Every applied seed is recorded by its key in {@link SEEDS_TABLE} — a
 * tracking table structurally identical in spirit to migrator.ts's
 * `schema_migrations` (id/name/applied_at), just with no checksum column
 * (a seed has no "modified since applied" concept the way a migration
 * file's checksum does; re-registering the same key with different code is
 * simply a new version of the same fixture, run once). {@link runSeeds}
 * skips any key already present in {@link SEEDS_TABLE} — this is what makes
 * seeding idempotent at the *runner* level: running `npm run seed` twice
 * never re-executes an already-applied seed, so a seed function that does a
 * plain `INSERT` (not an upsert) still cannot duplicate rows, without every
 * seed author having to hand-write their own existence check. Each seed's
 * `run(db)` plus its tracking-row `INSERT` commit together in one
 * transaction (mirrors `runMigrationsUp`), so a seed that throws halfway
 * through never gets silently recorded as applied.
 *
 * ## Dev-only
 *
 * {@link assertSeedingAllowed} refuses to run when `NODE_ENV=production` —
 * the seed mechanism exists to populate a local/dev database with fixture
 * data, never a production one. This is the second, independent layer
 * behind `init.sh`'s explicit `--seed` opt-in flag (feature #25 step 2): a
 * production deploy that never passes `--seed` never invokes `npm run
 * seed` at all, and even a mis-flagged invocation that does still gets
 * rejected here before a single query runs.
 */
import { sql, type Kysely } from "kysely";
import { SeedError } from "./errors.js";

/**
 * A minimal generic schema shape for {@link runSeeds}' `db` parameter —
 * enough for Kysely's schema builder (`db.schema.createTable(...)`) and
 * ordinary `selectFrom`/`insertInto` access to {@link SEEDS_TABLE} without
 * this kernel module depending on any specific plugin's concrete row
 * types. Structurally identical to database-mysql's own `Database` type
 * (`src/plugins/database-mysql/src/db.ts`), so a real `Kysely<Database>`
 * instance is assignable here with no cast required — mirrors that file's
 * own doc comment on why an index signature is used instead of `any`.
 */
export type SeedableDatabase = Record<string, Record<string, unknown>>;

/** Tracks every applied seed: `id` (PK), `name` (the seed's registration key), `applied_at`. */
export const SEEDS_TABLE = "schema_seeds";

/** A seed's own fixture logic. Receives the same `Kysely`/`Transaction` handle a migration's `up(db)` gets. */
export type SeedFunction = (db: Kysely<SeedableDatabase>) => Promise<void>;

/** One registered seed, keyed by `"<pluginId>:<name>"` (see {@link seedKey}). */
export interface SeedRegistration {
  /** `"<pluginId>:<name>"` — the stable identifier stored in {@link SEEDS_TABLE}'s `name` column. */
  readonly key: string;
  readonly pluginId: string;
  readonly name: string;
  readonly run: SeedFunction;
}

/** A row from {@link SEEDS_TABLE}. */
export interface AppliedSeedRow {
  id: number;
  name: string;
  applied_at: Date | string;
}

/** Build a seed's registration key from its owning plugin id and its own name. */
export function seedKey(pluginId: string, name: string): string {
  return `${pluginId}:${name}`;
}

/**
 * Process-wide registry of every seed registered so far via
 * {@link registerSeed}. A plain module-scope `Map` — exactly like
 * `rbac/index.ts`'s exported `policyStore` — since, like that module's
 * in-memory backing store, there is currently no capability broker wiring
 * for this (feature #25 has no such step); a future capability-brokered
 * version can replace this internal without changing {@link registerSeed}'s
 * or {@link runSeeds}' signatures.
 */
const registry = new Map<string, SeedRegistration>();

/**
 * Register a seed function under `pluginId`'s own namespace. Throws
 * {@link SeedError} if `pluginId:name` was already registered — catches a
 * copy-paste'd duplicate registration (e.g. two `seeds/index.ts` entries
 * with the same name) at registration time rather than letting the second
 * one silently replace the first.
 */
export function registerSeed(pluginId: string, name: string, run: SeedFunction): void {
  const key = seedKey(pluginId, name);
  if (registry.has(key)) {
    throw new SeedError(`Seed "${key}" is already registered.`, {
      details: { pluginId, name, reason: "duplicate_seed" },
    });
  }
  registry.set(key, { key, pluginId, name, run });
}

/** Every currently-registered seed, sorted by key for deterministic run order. */
export function listRegisteredSeeds(): SeedRegistration[] {
  return [...registry.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Reset the registry back to empty. Test-only convenience — production code
 * has no reason to call this (mirrors `rbac/index.ts`'s
 * `resetPolicyStoreForTests`).
 */
export function clearSeedRegistryForTests(): void {
  registry.clear();
}

/** Create {@link SEEDS_TABLE} if it doesn't already exist. Safe to call on every run. */
export async function ensureSeedsTable(db: Kysely<SeedableDatabase>): Promise<void> {
  await db.schema
    .createTable(SEEDS_TABLE)
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.autoIncrement().primaryKey())
    .addColumn("name", "varchar(255)", (col) => col.notNull().unique())
    .addColumn("applied_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
}

/** Every applied seed, ordered by `id` (i.e. the order they were applied in). */
export async function getAppliedSeeds(db: Kysely<SeedableDatabase>): Promise<AppliedSeedRow[]> {
  const rows = await db.selectFrom(SEEDS_TABLE).selectAll().orderBy("id", "asc").execute();
  return rows as unknown as AppliedSeedRow[];
}

/** Registered seeds not yet recorded as applied, in (already-sorted) registration-key order. */
export function planPendingSeeds(
  registered: readonly SeedRegistration[],
  applied: readonly AppliedSeedRow[],
): SeedRegistration[] {
  const appliedKeys = new Set(applied.map((row) => row.name));
  return registered.filter((seed) => !appliedKeys.has(seed.key));
}

/**
 * Refuse to seed a production environment. `nodeEnv` is checked against the
 * literal string `"production"` — the same value `core/config.ts`'s
 * `CoreConfigSchema.NODE_ENV` validates against — so this stays in lockstep
 * with however the rest of the kernel decides what "production" means.
 */
export function assertSeedingAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv === "production") {
    throw new SeedError(
      "Refusing to run dev seed data against NODE_ENV=production. The seed mechanism " +
        "(feature #25) is dev-only.",
      { details: { nodeEnv, reason: "production_environment" } },
    );
  }
}

export interface RunSeedsOptions {
  /** Which seeds to consider running. Defaults to every currently-registered seed ({@link listRegisteredSeeds}). */
  seeds?: readonly SeedRegistration[];
  /** `NODE_ENV` value checked by {@link assertSeedingAllowed}. Defaults to `process.env.NODE_ENV`. */
  nodeEnv?: string;
}

export interface RunSeedsResult {
  /** Registration keys applied by this call, in the order they ran. Empty if nothing was pending. */
  applied: string[];
  /** Registration keys that were already applied before this call, and so were skipped. */
  skipped: string[];
}

/**
 * Run every pending registered seed (see {@link RunSeedsOptions.seeds} to
 * scope this to a subset). Ensures {@link SEEDS_TABLE} exists, then applies
 * each not-yet-applied seed in one transaction per seed — the seed's own
 * `run(db)` plus the corresponding tracking-row `INSERT` commit together,
 * so a seed that throws partway through is never recorded as applied and
 * never leaves a half-written tracking row. Calling this twice in a row is
 * a no-op the second time: every seed from the first call is now recorded
 * in {@link SEEDS_TABLE}, so {@link planPendingSeeds} finds nothing pending
 * and `applied` comes back empty — this is the idempotency guarantee
 * feature #25 step 3 tests.
 */
export async function runSeeds(
  db: Kysely<SeedableDatabase>,
  options: RunSeedsOptions = {},
): Promise<RunSeedsResult> {
  assertSeedingAllowed(options.nodeEnv ?? process.env["NODE_ENV"]);

  await ensureSeedsTable(db);
  const seeds = options.seeds ?? listRegisteredSeeds();
  const applied = await getAppliedSeeds(db);
  const pending = planPendingSeeds(seeds, applied);

  const appliedNow: string[] = [];
  for (const seed of pending) {
    await db.transaction().execute(async (trx) => {
      await seed.run(trx);
      await trx.insertInto(SEEDS_TABLE).values({ name: seed.key }).execute();
    });
    appliedNow.push(seed.key);
  }

  const pendingKeys = new Set(pending.map((seed) => seed.key));
  const skipped = seeds.filter((seed) => !pendingKeys.has(seed.key)).map((seed) => seed.key);

  return { applied: appliedNow, skipped };
}

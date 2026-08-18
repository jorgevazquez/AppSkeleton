#!/usr/bin/env -S npx tsx
/**
 * CLI entry point for the seed runner (feature #25 — "Seed data / fixtures
 * mechanism for local development"). Wired up via `npm run seed` (see
 * package.json) which, in turn, `init.sh` only ever invokes behind its own
 * explicit `--seed` flag (feature #25 step 2) — never automatically, and
 * never for a production run even if mis-flagged, since `core/seed.ts`'s
 * `runSeeds()` independently refuses to run when `NODE_ENV=production`.
 *
 * Unlike `database-mysql/src/migrate.ts` (which only ever touches that one
 * plugin's own migrations directory), this script discovers *every*
 * plugin's dev fixtures: each plugin may drop a `seeds/index.ts` (or
 * `.js`/`.mjs`/`.cjs`) at the root of its own directory, and this script
 * dynamically imports each one it finds purely for its module-scope
 * `registerSeed(...)` side effects (see `core/seed.ts`) before running
 * whatever ends up registered. That discovery step deliberately lives here
 * — outside any single plugin's own `src/` — rather than inside, say,
 * `database-mysql/src/`, precisely so no plugin ever has to import another
 * plugin's internals directly to get its own seeds picked up
 * (docs/plugin-conventions.md section 5's forbidden-cross-plugin-imports
 * rule); this mirrors `src/cli/introspect.ts`, the other CLI script that
 * legitimately reaches across the whole plugin tree from outside it.
 *
 * The actual database connection still comes from database-mysql's own
 * pool/Kysely wiring (`pool.ts`/`db.ts`) — seeds run against the one real
 * MySQL connection pool the kernel has, exactly like `migrate.ts`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import "dotenv/config";
import { isAppError } from "../core/errors.js";
import { scanPluginDirectories } from "../core/registry.js";
import { listRegisteredSeeds, runSeeds } from "../core/seed.js";
import { createKyselyDb } from "../plugins/database-mysql/src/db.js";
import { createDbPoolFromEnv } from "../plugins/database-mysql/src/pool.js";

const PLUGINS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins");

/** Checked in this order per plugin directory; the first one found is imported. */
const SEED_FILE_CANDIDATES = [
  "seeds/index.ts",
  "seeds/index.js",
  "seeds/index.mjs",
  "seeds/index.cjs",
];

/**
 * Import every plugin's own `seeds/index.*` (if it has one), purely for the
 * `registerSeed(...)` side effects that module-scope code is expected to
 * run. A plugin with no `seeds/` directory at all is simply skipped — most
 * plugins have no dev fixtures to register, exactly like most plugins have
 * no migrations yet.
 */
async function loadPluginSeedModules(): Promise<void> {
  const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
  for (const entry of entries) {
    for (const candidate of SEED_FILE_CANDIDATES) {
      const seedFilePath = path.join(entry.directoryPath, candidate);
      if (existsSync(seedFilePath)) {
        await import(pathToFileURL(seedFilePath).href);
        break;
      }
    }
  }
}

/** Single-line, no-stack-trace message safe to print for any thrown value — same contract as migrate.ts's own. */
function formatFatalSeedError(error: unknown): string {
  const message = isAppError(error)
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
  return message.replace(/\s*\r?\n\s*/g, " ").trim();
}

async function main(): Promise<void> {
  await loadPluginSeedModules();

  const pool = createDbPoolFromEnv();
  const db = createKyselyDb(pool);
  try {
    const seeds = listRegisteredSeeds();
    const { applied, skipped } = await runSeeds(db, { seeds });
    if (applied.length === 0) {
      console.log(
        skipped.length === 0
          ? "Nothing to seed — no seeds are registered."
          : `Nothing to seed — all ${skipped.length} registered seed(s) already applied.`,
      );
    } else {
      console.log(`Applied ${applied.length} seed(s):`);
      for (const name of applied) {
        console.log(`  seed ${name}`);
      }
    }
  } finally {
    await db.destroy();
  }
}

main().catch((cause: unknown) => {
  console.error(`Seeding failed: ${formatFatalSeedError(cause)}`);
  process.exit(1);
});

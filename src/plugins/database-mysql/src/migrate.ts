#!/usr/bin/env -S npx tsx
/**
 * CLI entry point for the migration runner (feature #19). Wired up via
 * `npm run migrate` / `npm run migrate:down` (see package.json):
 *
 *   npm run migrate        -> tsx src/plugins/database-mysql/src/migrate.ts up
 *   npm run migrate:down   -> tsx src/plugins/database-mysql/src/migrate.ts down
 *
 * Loads `.env` via `dotenv/config` (nothing else in the repo does this yet
 * for a standalone script outside the Fastify bootstrap — see feature #2's
 * notes), builds a pool + `Kysely<Database>` from `DB_*` env vars exactly
 * like the rest of this plugin (pool.ts/db.ts), discovers migration files
 * under this file's sibling `migrations/` directory, and runs
 * migrator.ts's `runMigrationsUp`/`runMigrationsDown`.
 *
 * Fatal errors (bad config, checksum mismatch, a migration itself
 * throwing) print a single-line, non-stack-trace message to stderr and
 * exit non-zero — the same "no stack trace, no leaking a raw driver error"
 * contract `src/server/index.ts`'s `formatFatalStartupError` establishes
 * for the kernel's own bootstrap, reimplemented locally here so this
 * plugin script stays self-contained rather than importing the whole
 * kernel bootstrap module.
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAppError } from "../../../core/errors.js";
import { createKyselyDb } from "./db.js";
import { listMigrationFiles, runMigrationsDown, runMigrationsUp } from "./migrator.js";
import { createDbPoolFromEnv } from "./pool.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/** This plugin's own id — matches `plugin.json`'s `id` field. Used to namespace-check every table its migrations create (feature #22). */
const PLUGIN_ID = "database-mysql";

type Direction = "up" | "down";

function parseDirection(argv: readonly string[]): Direction {
  const direction = argv[2];
  if (direction === "up" || direction === "down") {
    return direction;
  }
  throw new Error(`Usage: migrate.ts <up|down> (got: ${direction ?? "(none)"})`);
}

/** Single-line, no-stack-trace message safe to print for any thrown value. */
function formatFatalMigrationError(error: unknown): string {
  const message = isAppError(error)
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
  return message.replace(/\s*\r?\n\s*/g, " ").trim();
}

async function main(): Promise<void> {
  const direction = parseDirection(process.argv);
  const pool = createDbPoolFromEnv();
  const db = createKyselyDb(pool);
  try {
    const files = listMigrationFiles(MIGRATIONS_DIR);
    if (direction === "up") {
      const { applied } = await runMigrationsUp(db, files, { pluginId: PLUGIN_ID });
      if (applied.length === 0) {
        console.log("Nothing to migrate — already up to date.");
      } else {
        console.log(`Applied ${applied.length} migration(s):`);
        for (const name of applied) {
          console.log(`  up   ${name}`);
        }
      }
    } else {
      const { rolledBack } = await runMigrationsDown(db, files, { pluginId: PLUGIN_ID });
      if (rolledBack.length === 0) {
        console.log("Nothing to roll back — no migrations are applied.");
      } else {
        console.log(`Rolled back ${rolledBack.length} migration(s):`);
        for (const name of rolledBack) {
          console.log(`  down ${name}`);
        }
      }
    }
  } finally {
    await db.destroy();
  }
}

main().catch((cause: unknown) => {
  console.error(`Migration failed: ${formatFatalMigrationError(cause)}`);
  process.exit(1);
});

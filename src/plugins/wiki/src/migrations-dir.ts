/**
 * This plugin's own migrations directory (feature #86, step 1 — "Add
 * wiki_pages, wiki_revisions, wiki_namespaces migrations under the wiki_
 * table namespace"). Mirrors `rbac/src/migrations-dir.ts`'s own
 * `RBAC_MIGRATIONS_DIR` constant (itself modeled on `database-mysql/
 * src/migrate.ts`'s `MIGRATIONS_DIR`) so a caller with a real,
 * checksum-verified, namespace-enforced migration runner
 * (`database-mysql/src/migrator.ts`'s `listMigrationFiles`/
 * `runMigrationsUp`/`runMigrationsDown`) can point it at this plugin's own
 * `src/migrations/` without hard-coding a relative path at every call site.
 * Exported as a plain constant (not a function) since it never changes at
 * runtime.
 *
 * This module deliberately does not import the migration runner itself —
 * only the *caller* (a future `db:migrate`-capability wiring, an ops
 * script, or — today — this feature's own integration test, which is
 * allowed to reach across plugins per `docs/plugin-conventions.md`'s
 * "kernel-integration tests" carve-out) decides which runner to apply
 * these files with, keeping this plugin's own `src/` free of any
 * cross-plugin import.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to `src/plugins/wiki/src/migrations/`. */
export const WIKI_MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

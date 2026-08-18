/**
 * This plugin's own migrations directory (feature #34, step 1 — "Add
 * roles/permissions/role_permissions/user_roles migrations under the
 * rbac_ table namespace"). Mirrors `database-mysql/src/migrate.ts`'s
 * `MIGRATIONS_DIR` constant so a caller with a real, checksum-verified,
 * namespace-enforced migration runner (`database-mysql/src/migrator.ts`'s
 * `listMigrationFiles`/`runMigrationsUp`/`runMigrationsDown`) can point it
 * at this plugin's own `src/migrations/` without hard-coding a relative
 * path at every call site. Exported as a plain constant (not a function)
 * since, like that file's own constant, it never changes at runtime.
 *
 * This module deliberately does not import the migration runner itself —
 * only the *caller* (a future `db:migrate`-capability wiring, an ops
 * script, or — today — this feature's own integration test, which is
 * allowed to reach across plugins per
 * `docs/plugin-conventions.md`'s "kernel-integration tests" carve-out)
 * decides which runner to apply these files with, keeping this plugin's
 * own `src/` free of any cross-plugin import.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to `src/plugins/rbac/src/migrations/`. */
export const RBAC_MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

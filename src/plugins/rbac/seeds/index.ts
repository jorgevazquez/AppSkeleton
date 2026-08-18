/**
 * Default roles and starter permission set (feature #37 — "Seed default
 * roles and permissions (admin, editor, viewer)").
 *
 * Registers one seed — `"rbac:default-roles"` (the exact
 * `registerSeed("rbac", "default-roles", ...)` pair `src/core/seed.ts`'s own
 * doc comment and `tests/core/seed.test.ts`'s examples already anticipate)
 * — with the generic seed mechanism `src/core/seed.ts` built for feature
 * #25. This module is picked up automatically: `src/cli/seed.ts`'s
 * `loadPluginSeedModules()` discovers every plugin's own
 * `seeds/index.{ts,js,mjs,cjs}` and imports it purely for this file's
 * module-scope {@link registerSeed} call, exactly like every other plugin's
 * (future) seed file would be.
 *
 * ## Why this writes straight to the `rbac_*` tables, not through `store.ts`
 * or `manage.ts`
 *
 * `manage.ts`'s `rbac:manage` operations are all gated on the caller already
 * holding `rbac:manage` (see that module's "Self-referential authorization"
 * docs) — but on a freshly-migrated database *nobody* holds any permission
 * yet, including `rbac:manage` itself (deny-by-default, `policy.ts` rule 1).
 * That is precisely the bootstrap problem this seed exists to solve: without
 * it, there would be no way to grant the very first admin their
 * `rbac:manage` permission except by hand-editing the database. A seed is
 * infrastructure that runs *before* any authorization check is meaningful,
 * so it intentionally writes through the same generic `Kysely` handle
 * `runSeeds()` hands every seed's `run(db)` (see `core/seed.ts`'s
 * `SeedFunction`/`SeedableDatabase`) directly against `store.ts`'s own table
 * names (`ROLES_TABLE`/`PERMISSIONS_TABLE`/`ROLE_PERMISSIONS_TABLE`,
 * duplicated here as plain string literals for the same self-containment
 * reason `store.ts` and `permission.ts` document for their own duplicated
 * constants/regexes — this file must not import another plugin's, or even
 * this plugin's own `src/`, module: `seeds/` sits alongside `src/`, not
 * inside it, and stays a free-standing, dependency-light fixture file).
 *
 * ## Idempotency (feature #37 step 2)
 *
 * This seed's own `run(db)` does plain, non-upserting `INSERT`s — it does
 * NOT check whether "admin" already exists before inserting it. That is
 * deliberate, and mirrors the precedent
 * `tests/plugins/database-mysql/seed.integration.test.ts` already
 * establishes for feature #25 itself: idempotency is a property of
 * `runSeeds()`'s own bookkeeping (the `schema_seeds` tracking table), not
 * something every seed author must hand-roll. Once `"rbac:default-roles"` is
 * recorded as applied, `runSeeds()` never calls this function again for that
 * database — so running the seed CLI twice (or a hundred times) inserts
 * these rows exactly once. See
 * `tests/core/rbac-default-roles-seed.integration.test.ts` for the test
 * proving this (feature #37 step 3).
 *
 * ## The starter permission set
 *
 * Chosen to exercise the two resources spec.md's "Shipped Plugins" section
 * already names as this platform's first real consumers of RBAC:
 *
 *   - `rbac:manage` — the same `resource:action` pair `manage.ts`'s
 *     `MANAGE_RESOURCE`/`MANAGE_ACTION` gate every role/permission
 *     management operation on. Only `admin` gets it — granting it is what
 *     turns "a" role into the one actual escape hatch out of
 *     deny-by-default for managing RBAC itself.
 *   - `wiki:read` / `wiki:write` / `wiki:admin` — spec.md's `wiki` plugin
 *     entry literally calls for "RBAC-gated read/write/admin permissions
 *     per page or namespace"; seeding these three now means the wiki
 *     plugin's own future features have real roles to gate routes on from
 *     day one, without inventing their own bootstrap permissions.
 *
 * `admin` holds all four permissions (full access, including managing RBAC
 * itself); `editor` holds `wiki:read`/`wiki:write` (can read and change
 * content, cannot manage roles); `viewer` holds only `wiki:read`
 * (read-only) — a standard, minimal three-tier starter set, not meant to be
 * exhaustive (operators/future features remain free to add more roles and
 * permissions through `rbac:manage` once `admin` exists to grant them).
 */
import { registerSeed, type SeedableDatabase } from "../../../core/seed.js";
import type { Kysely } from "kysely";

/** Mirrors `store.ts`'s own table-name constants — see this file's module doc for why they are duplicated, not imported. */
const ROLES_TABLE = "rbac_roles";
const PERMISSIONS_TABLE = "rbac_permissions";
const ROLE_PERMISSIONS_TABLE = "rbac_role_permissions";

/** This seed's own registration identity — `"rbac:default-roles"` once joined by `core/seed.ts`'s `seedKey`. */
export const RBAC_SEED_PLUGIN_ID = "rbac";
export const DEFAULT_ROLES_SEED_NAME = "default-roles";

interface DefaultPermission {
  readonly id: string;
  readonly resource: string;
  readonly action: string;
  readonly description: string;
}

interface DefaultRole {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** {@link DefaultPermission.id} values granted to this role. */
  readonly permissionIds: readonly string[];
}

/** The starter permission catalog — see this file's module doc, "The starter permission set". */
export const DEFAULT_PERMISSIONS: readonly DefaultPermission[] = [
  {
    id: "rbac:manage",
    resource: "rbac",
    action: "manage",
    description: "Create/update/delete roles and grant/revoke permissions and role assignments.",
  },
  {
    id: "wiki:read",
    resource: "wiki",
    action: "read",
    description: "View wiki pages.",
  },
  {
    id: "wiki:write",
    resource: "wiki",
    action: "write",
    description: "Create and edit wiki pages.",
  },
  {
    id: "wiki:admin",
    resource: "wiki",
    action: "admin",
    description: "Administer wiki pages/namespaces (delete, move, manage page-level access).",
  },
];

/** The three default roles — see this file's module doc, "The starter permission set". */
export const DEFAULT_ROLES: readonly DefaultRole[] = [
  {
    id: "admin",
    name: "Administrator",
    description: "Full system access, including managing roles and permissions.",
    permissionIds: ["rbac:manage", "wiki:read", "wiki:write", "wiki:admin"],
  },
  {
    id: "editor",
    name: "Editor",
    description: "Can read and write content; cannot manage roles or permissions.",
    permissionIds: ["wiki:read", "wiki:write"],
  },
  {
    id: "viewer",
    name: "Viewer",
    description: "Read-only access to content.",
    permissionIds: ["wiki:read"],
  },
] as const;

/**
 * The seed's fixture logic — exported (not just registered) so a test can
 * call {@link registerSeed} with it directly (see
 * `tests/core/rbac-default-roles-seed.integration.test.ts`), the same way
 * `tests/plugins/database-mysql/seed.integration.test.ts` re-registers its
 * own fixture seed per test rather than depending on this module's
 * side-effecting import having already run in that process.
 *
 * Inserts every {@link DEFAULT_PERMISSIONS} row, then every
 * {@link DEFAULT_ROLES} row plus its `rbac_role_permissions` grants — all
 * within the one transaction `runSeeds()` already wraps this call in (see
 * `core/seed.ts`'s `runSeeds`), so a failure partway through never leaves a
 * half-seeded database recorded as applied.
 */
export async function seedDefaultRolesAndPermissions(db: Kysely<SeedableDatabase>): Promise<void> {
  for (const permission of DEFAULT_PERMISSIONS) {
    await db
      .insertInto(PERMISSIONS_TABLE)
      .values({
        id: permission.id,
        resource: permission.resource,
        action: permission.action,
        description: permission.description,
      })
      .execute();
  }

  for (const role of DEFAULT_ROLES) {
    await db
      .insertInto(ROLES_TABLE)
      .values({ id: role.id, name: role.name, description: role.description })
      .execute();

    for (const permissionId of role.permissionIds) {
      await db
        .insertInto(ROLE_PERMISSIONS_TABLE)
        .values({ role_id: role.id, permission_id: permissionId })
        .execute();
    }
  }
}

registerSeed(RBAC_SEED_PLUGIN_ID, DEFAULT_ROLES_SEED_NAME, seedDefaultRolesAndPermissions);

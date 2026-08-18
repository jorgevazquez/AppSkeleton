/**
 * Persistent data-access layer for RBAC roles, permissions, and
 * assignments (feature #34 — "Persistent storage for roles, permissions,
 * and assignments via database-mysql").
 *
 * Before this feature, the only "store" this plugin had was `rbac/index.ts`'s
 * `policyStore` — two plain mutable in-memory arrays with no read/write API
 * of their own, seeded only by tests pushing directly into them (see
 * `resetPolicyStoreForTests`). This module is the real data-access layer
 * `types.ts`'s own doc comment earmarked for this feature: a typed CRUD
 * surface over `rbac_roles`/`rbac_permissions`/`rbac_role_permissions`/
 * `rbac_user_roles` (this plugin's own migrations — see `./migrations/`),
 * reading and writing exclusively through a `db:query`-shaped capability's
 * `query(fn)` method — never a raw SQL string (see the repo-wide
 * `no-restricted-syntax` ESLint rule) and never an in-memory array.
 *
 * ## Why `RbacDbQueryCapability` is a locally-declared interface
 *
 * This module must not import `src/plugins/database-mysql/src/query-capability.ts`
 * directly — `docs/plugin-conventions.md` section 5 forbids importing
 * another plugin's internals; only a kernel-brokered capability handle is
 * allowed. {@link RbacDbQueryCapability} duplicates just the one method
 * shape this module actually calls (same self-containment rationale
 * `permission.ts` documents for duplicating `CAPABILITY_PATTERN`'s regex
 * rather than importing it). A real `DbQueryCapability` instance satisfies
 * this interface structurally with zero cast: its `query()` method's
 * `Kysely<Database>` parameter uses the exact same generic index-signature
 * shape as this plugin's own `./db.js` `Database` type (see that file's doc
 * comment, and `src/core/seed.ts`'s `SeedableDatabase` for the identical
 * precedent).
 *
 * ## What's deliberately NOT here
 *
 * This module does not touch `rbac/index.ts`'s `check()`/`policyStore` —
 * making `check()` read the database on every call would be a real,
 * per-request I/O cost, and `check()`'s current synchronous signature is a
 * public contract `tests/plugins/rbac/index.test.ts` and
 * `check-capability.integration.test.ts` (feature #39, already passing)
 * depend on. (Feature #35, "Policy decision caching with invalidation on
 * role/permission change", has since layered an in-process, short-TTL
 * cache in front of `check()`'s existing in-memory `policyStore` reads —
 * see that module's docs — but that is orthogonal to this module: it
 * caches `can()` decisions, not `db:query` I/O, and this module's own
 * `loadPolicyStore` below is not yet the thing `check()` reads from.)
 * {@link loadPolicyStore} below produces exactly the `PolicyStore` shape
 * `policy.ts`'s `can()` already consumes — unchanged, per that module's own
 * doc comment ("`can()` itself never changes, since it only ever reads the
 * two association arrays it's handed") — so a future feature wiring this
 * module's DB-backed store up to `check()` can call `loadPolicyStore()`
 * once and feed the result into `can()`, or hydrate `policyStore`'s arrays
 * from it, without this module needing to change.
 * Role/permission *management* semantics (duplicate-name rejection,
 * "assign a nonexistent permission" validation, an `rbac:manage`
 * authorization gate) are feature #36's job, not this one's — this layer
 * is intentionally a thin, unopinionated CRUD surface over the four tables.
 *
 * ## Permission-grammar validation (feature #42)
 *
 * This module is one of the boundaries feature #42 ("Permission grammar
 * validator rejects malformed resource:action strings at every entry
 * point") requires to apply `permission.ts`'s `parsePermissionString`
 * parser: every method here that accepts a caller-supplied permission
 * identifier — {@link RbacStore.createPermission}'s `permission.id`,
 * {@link RbacStore.getPermission}'s `id`, and {@link
 * RbacStore.assignPermissionToRole}'s `permissionId` — validates it
 * against the `resource:action` grammar via {@link assertValidPermissionId}
 * before it ever reaches a query, and throws the same {@link
 * ValidationError} `parsePermissionString` itself produces on rejection.
 * `createPermission` also re-derives `resource`/`action` from the
 * validated id rather than trusting the caller-supplied fields, so a
 * hand-built `Permission` literal (this interface's doc comment already
 * warns callers to prefer {@link toPermission} instead) can never persist
 * with an `id` that disagrees with its own `resource`/`action` — the same
 * invariant `toPermission` itself guarantees, just enforced again here so
 * this layer never trusts an already-parsed-looking object it didn't
 * parse itself. This is deliberately independent of feature #36's
 * still-not-built authorization/duplicate-name checks (see above): grammar
 * validity is a syntactic property of the string itself, checkable with no
 * database access and no `rbac:manage` grant required.
 */
import type { Kysely } from "kysely";
import type { Database } from "./db.js";
import { parsePermissionString, type PermissionString } from "./permission.js";
import type { PolicyStore } from "./policy.js";
import type { Permission, Role, RolePermission, UserRole } from "./types.js";

/** Table names — the `rbac_` namespace this plugin's migrations create (feature #22's per-plugin convention). */
export const ROLES_TABLE = "rbac_roles";
export const PERMISSIONS_TABLE = "rbac_permissions";
export const ROLE_PERMISSIONS_TABLE = "rbac_role_permissions";
export const USER_ROLES_TABLE = "rbac_user_roles";

/**
 * Structural shape of the `db:query` capability this module needs — see
 * this file's module doc for why this is a local duplicate, not an import
 * of database-mysql's own `DbQueryCapability` type.
 */
export interface RbacDbQueryCapability {
  query<T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T>;
}

/** Raw `rbac_roles` row shape, before mapping to {@link Role}. */
interface RoleRow {
  id: string;
  name: string;
  description: string | null;
}

/** Raw `rbac_permissions` row shape, before mapping to {@link Permission}. */
interface PermissionRow {
  id: string;
  resource: string;
  action: string;
  description: string | null;
}

/** Raw `rbac_role_permissions` row shape, before mapping to {@link RolePermission}. */
interface RolePermissionRow {
  role_id: string;
  permission_id: string;
}

/** Raw `rbac_user_roles` row shape, before mapping to {@link UserRole}. */
interface UserRoleRow {
  user_id: string;
  role_id: string;
}

function roleFromRow(row: RoleRow): Role {
  return row.description === null
    ? { id: row.id, name: row.name }
    : { id: row.id, name: row.name, description: row.description };
}

function permissionFromRow(row: PermissionRow): Permission {
  return row.description === null
    ? { id: row.id, resource: row.resource, action: row.action }
    : { id: row.id, resource: row.resource, action: row.action, description: row.description };
}

/**
 * Validate `id` against the `resource:action` grammar (feature #32's
 * parser) and return its parsed `{ resource, action }` segments. Throws
 * the {@link ValidationError} `parsePermissionString` itself produces —
 * unchanged, with `error.details.input` still carrying the offending
 * value — on any grammar violation (not a string, empty, wrong shape,
 * extra/missing colon, uppercase, leading/trailing/double hyphens, etc.).
 * The one boundary-layer helper every permission-accepting {@link
 * RbacStore} method below routes through (feature #42).
 */
function assertValidPermissionId(id: unknown): { resource: string; action: string } {
  const parsed = parsePermissionString(id);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

/** The typed CRUD surface {@link createRbacStore} returns. */
export interface RbacStore {
  /** Persist a new role. Throws (via the `db:query` capability's own `DatabaseError` normalization) on a duplicate `id`. */
  createRole(role: Role): Promise<void>;
  getRole(id: string): Promise<Role | undefined>;
  listRoles(): Promise<Role[]>;
  /**
   * Persist a new permission. Throws a {@link ValidationError} (feature #42)
   * if `permission.id` does not follow the `resource:action` grammar;
   * throws on a duplicate `id` otherwise.
   */
  createPermission(permission: Permission): Promise<void>;
  /** Throws a {@link ValidationError} (feature #42) if `id` does not follow the `resource:action` grammar. */
  getPermission(id: PermissionString): Promise<Permission | undefined>;
  listPermissions(): Promise<Permission[]>;
  /**
   * Grant `permissionId` to `roleId`. Throws a {@link ValidationError}
   * (feature #42) if `permissionId` does not follow the `resource:action`
   * grammar; throws on a duplicate `(roleId, permissionId)` pair otherwise.
   */
  assignPermissionToRole(roleId: string, permissionId: PermissionString): Promise<void>;
  listRolePermissions(): Promise<RolePermission[]>;
  /** Assign `roleId` to `userId`. Throws on a duplicate `(userId, roleId)` pair. */
  assignRoleToUser(userId: string, roleId: string): Promise<void>;
  listUserRoles(): Promise<UserRole[]>;
  /**
   * Assemble a `policy.ts`-ready {@link PolicyStore} snapshot straight from
   * the database — every current user->role and role->permission row, in
   * the exact shape `can()` already expects. This is "the caller that
   * assembles a PolicyStore from db:query results" `policy.ts`'s own doc
   * comment anticipated for this feature.
   */
  loadPolicyStore(): Promise<PolicyStore>;
}

/**
 * Build the RBAC data-access layer over an already-obtained `db:query`
 * capability handle. Every method issues its own query through
 * `dbQuery.query(fn)` — this module holds no connection/pool of its own,
 * exactly like `database-mysql`'s own capability wrappers.
 */
export function createRbacStore(dbQuery: RbacDbQueryCapability): RbacStore {
  async function listRoles(): Promise<Role[]> {
    const rows = await dbQuery.query((db) => db.selectFrom(ROLES_TABLE).selectAll().execute());
    return (rows as unknown as RoleRow[]).map(roleFromRow);
  }

  async function listPermissions(): Promise<Permission[]> {
    const rows = await dbQuery.query((db) =>
      db.selectFrom(PERMISSIONS_TABLE).selectAll().execute(),
    );
    return (rows as unknown as PermissionRow[]).map(permissionFromRow);
  }

  async function listRolePermissions(): Promise<RolePermission[]> {
    const rows = await dbQuery.query((db) =>
      db.selectFrom(ROLE_PERMISSIONS_TABLE).selectAll().execute(),
    );
    return (rows as unknown as RolePermissionRow[]).map((row) => ({
      roleId: row.role_id,
      permissionId: row.permission_id,
    }));
  }

  async function listUserRoles(): Promise<UserRole[]> {
    const rows = await dbQuery.query((db) => db.selectFrom(USER_ROLES_TABLE).selectAll().execute());
    return (rows as unknown as UserRoleRow[]).map((row) => ({
      userId: row.user_id,
      roleId: row.role_id,
    }));
  }

  return {
    async createRole(role) {
      await dbQuery.query((db) =>
        db
          .insertInto(ROLES_TABLE)
          .values({ id: role.id, name: role.name, description: role.description ?? null })
          .execute(),
      );
    },

    async getRole(id) {
      const row = await dbQuery.query((db) =>
        db.selectFrom(ROLES_TABLE).selectAll().where("id", "=", id).executeTakeFirst(),
      );
      return row === undefined ? undefined : roleFromRow(row as unknown as RoleRow);
    },

    listRoles,

    async createPermission(permission) {
      // Re-derive resource/action from the validated id rather than
      // trusting the caller-supplied fields — see this module's doc
      // comment ("Permission-grammar validation (feature #42)") for why.
      const { resource, action } = assertValidPermissionId(permission.id);
      await dbQuery.query((db) =>
        db
          .insertInto(PERMISSIONS_TABLE)
          .values({
            id: permission.id,
            resource,
            action,
            description: permission.description ?? null,
          })
          .execute(),
      );
    },

    async getPermission(id) {
      assertValidPermissionId(id);
      const row = await dbQuery.query((db) =>
        db.selectFrom(PERMISSIONS_TABLE).selectAll().where("id", "=", id).executeTakeFirst(),
      );
      return row === undefined ? undefined : permissionFromRow(row as unknown as PermissionRow);
    },

    listPermissions,

    async assignPermissionToRole(roleId, permissionId) {
      assertValidPermissionId(permissionId);
      await dbQuery.query((db) =>
        db
          .insertInto(ROLE_PERMISSIONS_TABLE)
          .values({ role_id: roleId, permission_id: permissionId })
          .execute(),
      );
    },

    listRolePermissions,

    async assignRoleToUser(userId, roleId) {
      await dbQuery.query((db) =>
        db.insertInto(USER_ROLES_TABLE).values({ user_id: userId, role_id: roleId }).execute(),
      );
    },

    listUserRoles,

    async loadPolicyStore() {
      const [userRoles, rolePermissions] = await Promise.all([
        listUserRoles(),
        listRolePermissions(),
      ]);
      return { userRoles, rolePermissions };
    },
  };
}

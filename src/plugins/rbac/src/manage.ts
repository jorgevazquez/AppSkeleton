/**
 * Role and permission management operations (feature #36 — "Role and
 * permission management operations (create/update/delete role,
 * assign/revoke permission and role)").
 *
 * This module is the typed, programmatic management API feature #36's
 * step 1 asks for — "ahead of any HTTP surface": every operation is a
 * plain async function taking an explicit `callerId` and returning (or
 * throwing) a real value, with no route, request, or response object
 * anywhere in this file. A future HTTP surface (an api-gateway route) would
 * be a thin adapter calling straight into {@link RbacManagementApi}, not a
 * rewrite of it.
 *
 * ## Self-referential authorization (step 2)
 *
 * Every operation this module exposes first checks that `callerId` already
 * holds the `"rbac:manage"` permission (`resource: "rbac"`,
 * `action: "manage"` — the exact grammar `permission.ts` and this plugin's
 * own `plugin.json` `capabilities.provides` entry already use) via
 * {@link RbacManageAuthorizer.check} — structurally the same shape as
 * `index.ts`'s own `RbacCheckCapability.check`. This is deliberately
 * *self-referential*: the mechanism that decides who may create a role,
 * delete a role, or grant/revoke a permission is the very same
 * roles/permissions system being managed — there is no separate,
 * out-of-band "admin" bit. A caller who has never been granted
 * `rbac:manage` (including, on a freshly-booted system with no roles
 * seeded yet, *every* caller — see `policy.ts`'s deny-by-default rule)
 * cannot perform any operation here, full stop; see
 * {@link assertCanManage}.
 *
 * ## Storage-agnostic (dependency inversion)
 *
 * This module depends only on {@link RbacManagementStore}, a narrow
 * interface, never on a concrete backing store. `index.ts` currently wires
 * an in-memory implementation built on the same `policyStore` arrays
 * `check()` already reads (see that module's docs: "feature #36's eventual
 * `rbac:manage` implementation mutates these same arrays, so a role/
 * permission change takes effect on the very next check with nothing
 * separate to invalidate") — but nothing here assumes that. A future,
 * `db:query`-backed implementation (extending `store.ts`'s already-built
 * `RbacStore`, feature #34) can be substituted with zero changes to this
 * file, exactly the way `RbacDbQueryCapability`/`RbacCheckCapability` are
 * used elsewhere in this plugin.
 *
 * ## Validated failure paths (step 3)
 *
 * Two business-rule failures are enforced here, on top of whatever a
 * concrete store also enforces at its own layer (e.g. a duplicate role
 * *id* — a primary-key collision — is left to the store, exactly like
 * `store.ts`'s `createRole` already documents for the real DB-backed case):
 *
 *   - **Duplicate role name**: `rbac_roles.name` has no uniqueness
 *     constraint at the storage layer (see that migration's own doc
 *     comment — only `id` is a primary key), so this module enforces name
 *     uniqueness itself, via {@link assertRoleNameAvailable}, before
 *     `createRole`/`updateRole` ever reach the store.
 *   - **Assigning a nonexistent permission**: `assignPermissionToRole`
 *     looks the permission up first ({@link requirePermission}) and
 *     refuses to create a dangling grant referencing a permission id no
 *     catalog entry backs.
 */
import { CapabilityDeniedError, NotFoundError, ValidationError } from "../../../core/errors.js";
import type { PermissionString } from "./permission.js";
import type { Permission, Role } from "./types.js";

/** The `resource:action` pair every operation in this module gates on — see the module docs' "Self-referential authorization" section. */
export const MANAGE_RESOURCE = "rbac";
export const MANAGE_ACTION = "manage";

/**
 * Structural shape of the authorization check this module needs — the same
 * shape as `index.ts`'s `RbacCheckCapability.check`, duplicated locally
 * (not imported) for the same self-containment reason `store.ts`'s
 * `RbacDbQueryCapability` documents: a real `check()` closure satisfies
 * this interface with zero cast.
 */
export interface RbacManageAuthorizer {
  check(callerId: string, action: string, resource: string): boolean;
}

/**
 * Fields that may be changed on an existing role via
 * {@link RbacManagementApi.updateRole}. An omitted field is left
 * unchanged; `description: null` explicitly clears a previously-set
 * description.
 */
export interface RoleUpdate {
  readonly name?: string;
  readonly description?: string | null;
}

/** Input to {@link RbacManagementApi.createRole}. */
export interface CreateRoleInput {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/**
 * Storage this module needs, independent of whatever ultimately backs it —
 * see the module docs' "Storage-agnostic" section. Every method mirrors an
 * operation this feature's own description calls for (role create/update/
 * delete, permission/role assign/revoke) plus the two lookups
 * ({@link getRole}/{@link getPermission}) needed to validate them.
 */
export interface RbacManagementStore {
  getRole(id: string): Promise<Role | undefined>;
  listRoles(): Promise<Role[]>;
  createRole(role: Role): Promise<void>;
  updateRole(id: string, changes: RoleUpdate): Promise<Role>;
  deleteRole(id: string): Promise<void>;
  getPermission(id: PermissionString): Promise<Permission | undefined>;
  assignPermissionToRole(roleId: string, permissionId: PermissionString): Promise<void>;
  revokePermissionFromRole(roleId: string, permissionId: PermissionString): Promise<void>;
  assignRoleToUser(userId: string, roleId: string): Promise<void>;
  revokeRoleFromUser(userId: string, roleId: string): Promise<void>;
}

/**
 * The typed programmatic API {@link createRbacManagementApi} returns.
 * Every method takes `callerId` first — the identity {@link
 * RbacManageAuthorizer.check} is asked about — so authorization is never
 * optional or forgettable at a call site.
 */
export interface RbacManagementApi {
  /**
   * List every role currently defined (feature #44, step 1 — "list ...
   * roles"). Gated by {@link assertCanManage} exactly like every other
   * operation here: listing roles is itself an `rbac:manage`-scoped
   * administrative read, not a public lookup — see this module's docs on
   * self-referential authorization.
   */
  listRoles(callerId: string): Promise<Role[]>;
  createRole(callerId: string, input: CreateRoleInput): Promise<Role>;
  updateRole(callerId: string, roleId: string, changes: RoleUpdate): Promise<Role>;
  deleteRole(callerId: string, roleId: string): Promise<void>;
  assignPermissionToRole(
    callerId: string,
    roleId: string,
    permissionId: PermissionString,
  ): Promise<void>;
  revokePermissionFromRole(
    callerId: string,
    roleId: string,
    permissionId: PermissionString,
  ): Promise<void>;
  assignRoleToUser(callerId: string, userId: string, roleId: string): Promise<void>;
  revokeRoleFromUser(callerId: string, userId: string, roleId: string): Promise<void>;
}

/**
 * Throws {@link CapabilityDeniedError} unless `authorizer.check(callerId,
 * "manage", "rbac")` returns `true`. Called first, before any store I/O, in
 * every operation below — see the module docs' "Self-referential
 * authorization" section.
 */
function assertCanManage(authorizer: RbacManageAuthorizer, callerId: string): void {
  if (!authorizer.check(callerId, MANAGE_ACTION, MANAGE_RESOURCE)) {
    throw new CapabilityDeniedError(
      `Caller "${callerId}" does not hold "${MANAGE_RESOURCE}:${MANAGE_ACTION}" and cannot ` +
        `perform role/permission management operations.`,
      {
        details: {
          reason: "not_granted",
          capabilityId: `${MANAGE_RESOURCE}:${MANAGE_ACTION}`,
          callerId,
        },
      },
    );
  }
}

/**
 * Build the role/permission management API over an already-constructed
 * {@link RbacManagementStore} and {@link RbacManageAuthorizer}. Pure
 * dependency injection — no capability broker, no HTTP framework, no
 * module-level singleton — so this is directly unit-testable with
 * hand-rolled fakes for both dependencies (see `tests/plugins/rbac/manage.test.ts`).
 */
export function createRbacManagementApi(
  store: RbacManagementStore,
  authorizer: RbacManageAuthorizer,
): RbacManagementApi {
  async function requireRole(roleId: string): Promise<Role> {
    const role = await store.getRole(roleId);
    if (!role) {
      throw new NotFoundError(`Role "${roleId}" does not exist.`, { details: { roleId } });
    }
    return role;
  }

  async function assertRoleNameAvailable(name: string, excludeRoleId?: string): Promise<void> {
    const roles = await store.listRoles();
    const conflict = roles.find((role) => role.name === name && role.id !== excludeRoleId);
    if (conflict) {
      throw new ValidationError(`Role name "${name}" is already in use by role "${conflict.id}".`, {
        details: { name, conflictingRoleId: conflict.id },
      });
    }
  }

  async function requirePermission(permissionId: PermissionString): Promise<Permission> {
    const permission = await store.getPermission(permissionId);
    if (!permission) {
      throw new ValidationError(
        `Permission "${permissionId}" does not exist and cannot be assigned to a role.`,
        { details: { permissionId } },
      );
    }
    return permission;
  }

  return {
    async listRoles(callerId) {
      assertCanManage(authorizer, callerId);
      return store.listRoles();
    },

    async createRole(callerId, input) {
      assertCanManage(authorizer, callerId);
      await assertRoleNameAvailable(input.name);
      const role: Role =
        input.description === undefined
          ? { id: input.id, name: input.name }
          : { id: input.id, name: input.name, description: input.description };
      await store.createRole(role);
      return role;
    },

    async updateRole(callerId, roleId, changes) {
      assertCanManage(authorizer, callerId);
      await requireRole(roleId);
      if (changes.name !== undefined) {
        await assertRoleNameAvailable(changes.name, roleId);
      }
      return store.updateRole(roleId, changes);
    },

    async deleteRole(callerId, roleId) {
      assertCanManage(authorizer, callerId);
      await requireRole(roleId);
      await store.deleteRole(roleId);
    },

    async assignPermissionToRole(callerId, roleId, permissionId) {
      assertCanManage(authorizer, callerId);
      await requireRole(roleId);
      await requirePermission(permissionId);
      await store.assignPermissionToRole(roleId, permissionId);
    },

    async revokePermissionFromRole(callerId, roleId, permissionId) {
      assertCanManage(authorizer, callerId);
      await store.revokePermissionFromRole(roleId, permissionId);
    },

    async assignRoleToUser(callerId, userId, roleId) {
      assertCanManage(authorizer, callerId);
      await requireRole(roleId);
      await store.assignRoleToUser(userId, roleId);
    },

    async revokeRoleFromUser(callerId, userId, roleId) {
      assertCanManage(authorizer, callerId);
      await store.revokeRoleFromUser(userId, roleId);
    },
  };
}

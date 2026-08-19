/**
 * Policy evaluation engine: `can(store, userId, action, resource)`.
 *
 * Resolves a user's roles (via {@link UserRole}) to the union of
 * permissions those roles hold (via {@link RolePermission}), then checks
 * whether the requested `action`/`resource` pair is granted. This module
 * is a pure function over an explicit, in-memory {@link PolicyStore} —
 * feature #34 ("Persistent storage ... via database-mysql") swaps the
 * caller that assembles a `PolicyStore` from `db:query` results; `can()`
 * itself never changes, since it only ever reads the two association
 * arrays it's handed.
 *
 * ## Precedence rules (read before changing this file)
 *
 * 1. **Deny-by-default.** Access is granted only if at least one matching
 *    grant is found; an unknown user, a user with no roles, a role with no
 *    permissions, or any other absence of evidence all resolve to `false`.
 *    There is no explicit "deny" permission in this model — only the
 *    presence or absence of a grant.
 * 2. **Permissions are additive across a user's roles.** `can()` computes
 *    the *union* of every permission held by every role assigned to the
 *    user, then checks the union. If a user holds two roles and only one
 *    of them grants the requested permission, access is allowed — a role
 *    that stays silent on a permission never narrows what a sibling role
 *    grants. (There is no mechanism for a role to explicitly revoke a
 *    permission another of the user's roles grants; "conflicting roles"
 *    only ever conflict in the sense of one granting more than another,
 *    never in the sense of one blocking another.)
 * 3. **Wildcard grants (`"resource:*"`) match any action on that exact
 *    resource only.** `"wiki:*"` grants `read`/`edit`/`delete`/... on
 *    `wiki`, but grants nothing on any other resource — there is no
 *    resource-level wildcard (e.g. `"*:read"` or `"*:*"`) in this feature;
 *    only the trailing action segment may be a wildcard.
 * 4. **An exact match and a wildcard match are equally strong.** Because
 *    grants are purely additive (rule 2) and there is no deny (rule 1),
 *    a wildcard grant from one role and a narrower exact grant from
 *    another role never "conflict" — either alone is sufficient to allow
 *    access, so the two are evaluated as one flat set of candidate grants
 *    with no ordering between them that could change the outcome.
 * 5. **Role hierarchy is additive and transitive, just like multi-role
 *    membership itself (rule 2).** If a user's role inherits from a parent
 *    role (feature #43, `hierarchy.ts`'s {@link RoleHierarchy} edges), the
 *    user is treated as if they also directly held every ancestor role —
 *    not just the immediate parent, but that parent's own parents, and so
 *    on. Inheriting from a parent never *narrows* what a role's own direct
 *    grants (or its other parents') already allow; it can only add more.
 *    Resolution walks {@link PolicyStore.roleParents} via `hierarchy.ts`'s
 *    {@link resolveAncestorRoleIds}, which is cycle-safe by construction —
 *    see that module's docs for why `can()` itself never needs its own
 *    cycle guard.
 */
import { resolveAncestorRoleIds } from "./hierarchy.js";
import type { PermissionString } from "./permission.js";
import type { RoleHierarchy, RolePermission, UserRole } from "./types.js";

/**
 * The explicit, in-memory data `can()` reads to resolve a user's roles to
 * permissions. `userRoles`/`rolePermissions` mirror {@link UserRole}/
 * {@link RolePermission} (feature #32) — a future DB-backed caller (feature
 * #34) constructs one of these per check (or per request) from `db:query`
 * results. `roleParents` (feature #43) is optional and defaults to "no
 * hierarchy" (treated as `[]`) so every pre-existing caller that only ever
 * built `{ userRoles, rolePermissions }` literals keeps working unchanged.
 */
export interface PolicyStore {
  /** Every user→role assignment currently in effect. */
  readonly userRoles: readonly UserRole[];
  /** Every role→permission grant currently in effect. */
  readonly rolePermissions: readonly RolePermission[];
  /**
   * Every role→parent-role inheritance edge currently in effect (feature
   * #43). Omitted or empty means no role inherits from any other.
   */
  readonly roleParents?: readonly RoleHierarchy[];
}

/**
 * Test whether a single granted permission string (as stored in
 * {@link RolePermission.permissionId}, e.g. `"wiki:read"` or the wildcard
 * form `"wiki:*"`) covers the requested `resource`/`action` pair. Never
 * throws — a malformed `granted` string simply fails to match anything
 * (deny-by-default, rule 1).
 *
 * Exported standalone (not just used internally by {@link can}) so the
 * wildcard precedence rules documented above can be unit-tested directly
 * against the matcher, independent of role/user resolution.
 */
export function matchesPermission(
  granted: PermissionString,
  resource: string,
  action: string,
): boolean {
  const separatorIndex = granted.indexOf(":");
  if (separatorIndex === -1 || granted.indexOf(":", separatorIndex + 1) !== -1) {
    // No colon, or more than one colon (e.g. "wiki:read:extra") — not a
    // recognizable resource:action / resource:* grant.
    return false;
  }

  const grantedResource = granted.slice(0, separatorIndex);
  const grantedAction = granted.slice(separatorIndex + 1);

  if (grantedResource === "" || grantedResource !== resource) {
    return false;
  }

  return grantedAction === "*" || grantedAction === action;
}

/**
 * Resolve `userId`'s roles — plus, transitively, every role those roles
 * inherit from (feature #43, precedence rule 5) — to their union of
 * granted permissions, and check whether `action` on `resource` is
 * allowed. Deny-by-default: returns `false` unless at least one directly
 * held or inherited role holds a matching exact or wildcard grant.
 */
export function can(store: PolicyStore, userId: string, action: string, resource: string): boolean {
  const directRoleIds = store.userRoles
    .filter((userRole) => userRole.userId === userId)
    .map((userRole) => userRole.roleId);

  if (directRoleIds.length === 0) {
    return false;
  }

  const roleParents = store.roleParents ?? [];
  const roleIds = new Set(directRoleIds);
  for (const roleId of directRoleIds) {
    for (const ancestorRoleId of resolveAncestorRoleIds(roleParents, roleId)) {
      roleIds.add(ancestorRoleId);
    }
  }

  return store.rolePermissions.some(
    (grant) => roleIds.has(grant.roleId) && matchesPermission(grant.permissionId, resource, action),
  );
}

/**
 * Core RBAC data model: roles, permissions, and the two association
 * ("join") tables that connect them to each other and to users.
 *
 * These are deliberately plain, storage-agnostic interfaces — feature #34
 * ("Persistent storage for roles, permissions, and assignments via
 * database-mysql") will add `rbac_roles` / `rbac_permissions` /
 * `rbac_role_permissions` / `rbac_user_roles` migrations under the
 * `rbac_` table namespace and a data-access layer that reads/writes
 * through the `db:query` capability; the shapes below are written to map
 * 1:1 onto that eventual schema so the swap from in-memory structures to
 * DB-backed ones (feature #34) doesn't require redesigning the model,
 * only its storage. Until then, an in-process Map/array keyed the same
 * way these interfaces imply is enough for feature #33's `can()` policy
 * engine to consume.
 *
 * Permission identity: a {@link Permission}'s `id` is its canonical
 * `"resource:action"` string (see permission.ts) — not a separate
 * surrogate key — so role-permission associations can reference a
 * permission by the same string a plugin author writes in a manifest or
 * policy check, with no extra lookup indirection.
 */

import type { PermissionString } from "./permission.js";

/**
 * A named, grantable bundle of permissions. Roles are assigned to users
 * (via {@link UserRole}) and hold permissions (via {@link RolePermission});
 * a role itself never grants access directly — `can()` (feature #33)
 * resolves a user's roles to their union of permissions before checking.
 */
export interface Role {
  /** Stable identifier, lowercase-kebab-case (e.g. "wiki-editor"). Primary key. */
  readonly id: string;
  /** Human-readable display name (e.g. "Wiki Editor"). */
  readonly name: string;
  /** Optional human-readable explanation of what the role is for. */
  readonly description?: string;
}

/**
 * A single grantable permission, following the `resource:action` grammar
 * shared with the kernel's plugin capability strings (feature #15's
 * `namespace:action` grammar — see `src/core/manifest.ts`'s
 * `CAPABILITY_PATTERN`). Always construct via {@link toPermission} in
 * permission.ts rather than a literal, so `id`/`resource`/`action` can
 * never disagree with each other.
 */
export interface Permission {
  /** Canonical `"resource:action"` string (e.g. "wiki:read"). Primary key. */
  readonly id: PermissionString;
  /** The resource segment (e.g. "wiki"). */
  readonly resource: string;
  /** The action segment (e.g. "read"). */
  readonly action: string;
  /** Optional human-readable explanation of what the permission allows. */
  readonly description?: string;
}

/**
 * Association table: a permission granted to a role. Mirrors the future
 * `rbac_role_permissions` table (feature #34) — `(roleId, permissionId)`
 * is the composite primary key; a given pair should appear at most once
 * in any store.
 */
export interface RolePermission {
  /** {@link Role.id} of the role the permission is granted to. */
  readonly roleId: string;
  /** {@link Permission.id} of the granted permission. */
  readonly permissionId: PermissionString;
}

/**
 * Association table: a role assigned to a user. Mirrors the future
 * `rbac_user_roles` table (feature #34) — `(userId, roleId)` is the
 * composite primary key; a given pair should appear at most once in any
 * store. `userId` is intentionally an opaque string (not a foreign key
 * into a users table owned by this plugin) — user identity is owned
 * elsewhere; the rbac plugin only records which roles a given user id
 * holds.
 */
export interface UserRole {
  /** Opaque identifier of the user the role is assigned to. */
  readonly userId: string;
  /** {@link Role.id} of the assigned role. */
  readonly roleId: string;
}

/**
 * Role hierarchy / inheritance data model (feature #43 — "Role hierarchy /
 * inheritance support").
 *
 * A role may inherit permissions from one or more "parent" roles via
 * {@link RoleHierarchy} association records (`types.ts`) — the same
 * child/parent association-table shape as {@link RolePermission}/
 * {@link UserRole}, and mirrors the eventual `rbac_role_hierarchy` table
 * (feature #34's persistence layer). Inheritance is transitive: if role C's
 * parent is B, and B's parent is A, then C inherits every permission A
 * holds too, not just B's own. See `policy.ts`'s `can()` for where this is
 * actually folded into a permission check — this module only owns the data
 * model and its graph operations (resolving ancestors, detecting cycles).
 *
 * ## Cycle detection
 *
 * A role hierarchy is a directed graph; if it were allowed to contain a
 * cycle (e.g. A inherits from B, B inherits from A), a naive "walk every
 * ancestor" resolution would loop forever. Two independent defenses, per
 * this feature's step 1 ("... with cycle detection"):
 *
 *  1. {@link addRoleParent} — the sanctioned way to grow a `RoleHierarchy[]`
 *     collection outside of hand-seeded test/fixture data. It calls
 *     {@link wouldCreateCycle} *before* mutating the array and throws a
 *     {@link ValidationError} instead of adding the edge if doing so would
 *     create one (including a direct self-reference, `roleId ===
 *     parentRoleId`) — a cyclic edge is rejected at the point of mutation
 *     and never enters the store.
 *  2. {@link resolveAncestorRoleIds} still guards against a cycle
 *     defensively (a visited-set breadth-first walk, never naive unguarded
 *     recursion) even if one somehow ends up in the store anyway — e.g.
 *     hand-seeded test data that bypasses {@link addRoleParent}, or a
 *     future DB-backed store written to directly. Resolution must never
 *     hang or stack-overflow regardless of how the data got there.
 */
import { ValidationError } from "../../../core/errors.js";
import type { RoleHierarchy } from "./types.js";

/**
 * Would adding a `roleId -> parentRoleId` inheritance edge to `roleParents`
 * create a cycle? True for:
 *
 *  - a direct self-reference (`roleId === parentRoleId`); and
 *  - any indirect cycle — `parentRoleId` (walking up *its own* existing
 *    ancestor chain) can already reach `roleId`, so the new edge would
 *    close a loop back to where it started.
 *
 * Pure — never mutates `roleParents`.
 */
export function wouldCreateCycle(
  roleParents: readonly RoleHierarchy[],
  roleId: string,
  parentRoleId: string,
): boolean {
  if (roleId === parentRoleId) {
    return true;
  }
  return resolveAncestorRoleIds(roleParents, parentRoleId).has(roleId);
}

/**
 * Resolve every ancestor role id of `roleId` — its direct parent(s), their
 * parent(s), and so on, per the currently-recorded `roleParents` edges.
 * Never includes `roleId` itself. Order is unspecified (a `Set`).
 *
 * Cycle-safe by construction: a breadth-first walk with an explicit
 * `visited` set, so even a hierarchy that already contains a cycle
 * (however it got there — see this module's doc) terminates instead of
 * looping forever.
 */
export function resolveAncestorRoleIds(
  roleParents: readonly RoleHierarchy[],
  roleId: string,
): Set<string> {
  const ancestors = new Set<string>();
  const visited = new Set<string>([roleId]);
  const queue: string[] = [roleId];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of roleParents) {
      if (edge.roleId !== current || visited.has(edge.parentRoleId)) {
        continue;
      }
      visited.add(edge.parentRoleId);
      ancestors.add(edge.parentRoleId);
      queue.push(edge.parentRoleId);
    }
  }

  return ancestors;
}

/**
 * Add a `roleId -> parentRoleId` inheritance edge to `roleParents`, in
 * place. Throws a {@link ValidationError} instead of mutating the array if:
 *
 *  - the edge would create a cycle (per {@link wouldCreateCycle}, including
 *    a direct self-reference); or
 *  - the exact `(roleId, parentRoleId)` edge is already present.
 *
 * The sanctioned way to grow a `RoleHierarchy[]` collection outside of
 * hand-seeded test/fixture data — see this module's doc comment for why
 * {@link resolveAncestorRoleIds} also guards against cycles defensively,
 * independent of every caller reliably going through this function.
 */
export function addRoleParent(
  roleParents: RoleHierarchy[],
  roleId: string,
  parentRoleId: string,
): void {
  if (wouldCreateCycle(roleParents, roleId, parentRoleId)) {
    throw new ValidationError(
      `Assigning "${parentRoleId}" as a parent of "${roleId}" would create a cyclic role hierarchy.`,
      { details: { roleId, parentRoleId } },
    );
  }

  const alreadyExists = roleParents.some(
    (edge) => edge.roleId === roleId && edge.parentRoleId === parentRoleId,
  );
  if (alreadyExists) {
    throw new ValidationError(
      `Role "${roleId}" already inherits from parent role "${parentRoleId}".`,
      { details: { roleId, parentRoleId } },
    );
  }

  roleParents.push({ roleId, parentRoleId });
}

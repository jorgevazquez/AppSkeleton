/**
 * rbac plugin lifecycle module (feature #39 — "Expose rbac:check as a
 * consumable capability for other plugins").
 *
 * Registers `can()` (feature #33's pure, storage-agnostic policy-evaluation
 * engine — see `./src/policy.ts`) as the `rbac:check` capability this
 * plugin's manifest already declares under `capabilities.provides` (feature
 * #31). Any other plugin that lists `rbac:check` under its own
 * `capabilities.requires` and is granted it can call `check(userId, action,
 * resource)` through the broker — no direct import of this plugin's
 * internals, only the kernel-brokered handle, exactly like api-gateway's
 * `http:route` capability (feature #59, see
 * `../api-gateway/index.ts`, whose `provides`-at-module-scope /
 * declare-before-lifecycle-hooks shape this module follows).
 *
 * ## Backing store
 *
 * Persistent storage (feature #34) and role/permission management
 * operations (feature #36, `rbac:manage`) haven't landed yet, so `check()`
 * currently reads from a plain in-memory {@link PolicyStore} (two mutable
 * arrays) — exactly what `./src/types.ts` anticipates: "an in-process
 * Map/array ... is enough for feature #33's can() policy engine to
 * consume." {@link policyStore} is exported (not private module state) so:
 *
 *   - tests — including this feature's own fixture-consumer integration
 *     test — can seed roles/permissions directly, without a not-yet-built
 *     management capability to go through;
 *   - feature #34 can swap what backs `PolicyStore` for something read from
 *     `db:query` without changing `check()`'s signature or this module's
 *     `provides` wiring;
 *   - feature #36's eventual `rbac:manage` implementation mutates these same
 *     arrays, so a role/permission change takes effect on the very next
 *     check with nothing separate to invalidate (feature #35 layers caching
 *     on top of this later).
 *
 * `rbac:manage` itself is intentionally NOT implemented here — this plugin's
 * manifest declares it under `capabilities.provides` (feature #31), so the
 * *real* rbac plugin will not fully load via the kernel's plugin loader
 * (`loader.ts` requires every declared `provides` id to have an
 * implementation before a plugin counts as loaded) until feature #36 adds
 * it — matching the same, already-accepted interim state `database-mysql`
 * and `html-renderer` are in for their own not-yet-fully-wired manifests.
 * Tests for `rbac:check` alone use a purpose-built manifest fixture
 * declaring only `["rbac:check"]`, exactly like
 * `route-capability.integration.test.ts` does for `http:route`.
 */
import { can, type PolicyStore } from "./src/policy.js";
import type { RolePermission, UserRole } from "./src/types.js";

/**
 * What `rbac:check` hands back to a consuming plugin.
 */
export interface RbacCheckCapability {
  /**
   * Deny-by-default policy check: does `userId` currently hold a role that
   * grants `action` on `resource`? See `policy.ts`'s `can()` for the full
   * precedence rules (additive across roles, wildcard-on-resource support,
   * no explicit deny) this defers to entirely.
   */
  check(userId: string, action: string, resource: string): boolean;
}

/**
 * In-memory backing store for `check()` — see the module docs above for why
 * this is exported, mutable state rather than a private module variable.
 * Starts empty: with no roles/permissions seeded, every check
 * deny-by-defaults (policy.ts rule 1), matching a freshly-booted kernel with
 * no RBAC data configured yet.
 */
export const policyStore: { userRoles: UserRole[]; rolePermissions: RolePermission[] } = {
  userRoles: [],
  rolePermissions: [],
};

/**
 * Reset {@link policyStore} back to empty. Test-only convenience so
 * independent test cases sharing this module's singleton state (ordinary
 * ESM module caching within a test file/process) don't leak roles or
 * permissions into each other — production code has no reason to call this.
 */
export function resetPolicyStoreForTests(): void {
  policyStore.userRoles.length = 0;
  policyStore.rolePermissions.length = 0;
}

function check(userId: string, action: string, resource: string): boolean {
  return can(policyStore as PolicyStore, userId, action, resource);
}

/**
 * Registered with the broker before this module's lifecycle hooks would run
 * (see `loader.ts`'s declare-before-hooks ordering). `rbac:check` needs no
 * per-instance construction (unlike api-gateway's Fastify instance, which
 * needs `onEnable`) — `check()` is a stable closure over {@link policyStore}
 * from the moment this module is imported, so this plugin currently exports
 * no lifecycle hooks at all.
 */
export const provides: Readonly<Record<string, unknown>> = {
  "rbac:check": { check } satisfies RbacCheckCapability,
};

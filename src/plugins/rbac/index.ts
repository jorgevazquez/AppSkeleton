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
 * ## Audit logging of every access-check decision (feature #38)
 *
 * Every `check()` call — the only path into `can()` this plugin exposes —
 * records one {@link AuditEvent} to the kernel's shared audit trail
 * (`core/audit.ts`, feature #11): `actor` is the `userId` being checked,
 * `action`/`target` are the requested action/resource verbatim, and
 * `outcome` is `"allowed"` or `"denied"`, matching spec.md's "every
 * capability grant, permission check, and mutating action is logged with
 * actor/target/outcome" requirement for the RBAC half of that promise.
 *
 * The sink itself is threaded in, not imported as a singleton: `onInstall`
 * (see `loader.ts`'s `PluginLifecycleContext.auditSink`, feature #38) copies
 * the kernel's real sink into {@link auditState} the same way the loader
 * already threads it into `broker.ts`. `check()` tolerates a missing sink
 * (e.g. this plugin's many existing unit tests, which call `check()`
 * directly without ever going through `loadPlugins()`) by simply not
 * recording — exactly like `broker.ts`'s own optional `auditSink`.
 *
 * ### High-frequency checks: allow-sampling tradeoff
 *
 * A *denied* decision is always recorded in full, unsampled — it is the
 * security-relevant signal (someone was refused something) and, under
 * normal operation, comparatively rare, so there is no volume problem to
 * solve for it. An *allowed* decision is the hot path — a busy deployment
 * can call `check()` on every request, every render, every route — so
 * recording every single one risks the in-memory sink (an unbounded array,
 * see `audit.ts`) growing unboundedly under sustained load. {@link
 * auditState.allowSampleEvery} bounds that growth by recording only 1 out
 * of every N *allowed* decisions (default `1`: record every allow too,
 * matching "audit everything" until an operator opts into sampling).
 * Denies are never subject to this — sampling only ever thins out the noisy,
 * already-granted-access half of the stream, never the half that matters
 * most for incident investigation.
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
 *   - feature #36's `rbac:manage` implementation mutates these same
 *     arrays, so a role/permission change is reflected in `policyStore`
 *     immediately (feature #35 layers a short-TTL decision cache in front
 *     of `check()` on top of this, invalidated on every such mutation —
 *     see "Policy decision caching" below).
 *
 * `rbac:manage` (feature #36 — "Role and permission management
 * operations") is implemented in `./src/manage.ts`, wired in below as this
 * plugin's second `provides` entry. `manage.ts` is storage-agnostic (see
 * its own docs); the adapter this module builds ({@link
 * createInMemoryManagementStore}) backs it with the exact same
 * {@link policyStore} arrays `check()` reads, plus two new catalogs
 * ({@link roleCatalog}/{@link permissionCatalog}) for role/permission
 * entities themselves — so a role created or a grant assigned through
 * `rbac:manage` is reflected in `policyStore` immediately. Every
 * `rbac:manage` operation is itself gated by a `check()` call for the
 * caller's own `rbac:manage` grant — see `manage.ts`'s "Self-referential
 * authorization" docs.
 *
 * ## Policy decision caching (feature #35)
 *
 * `check()` no longer recomputes `can()` from scratch on every call: a
 * decision for a given `(userId, action, resource)` triple is memoized in
 * {@link checkCacheState} for a short TTL ({@link
 * DEFAULT_CHECK_CACHE_TTL_MS}), since a busy deployment can call `check()`
 * far more often than roles/permissions actually change. Correctness is
 * preserved by invalidating the *entire* cache — see {@link
 * invalidateCheckCache} for why a full clear, not surgical per-key
 * eviction, is the right granularity here — from every mutating operation
 * {@link createInMemoryManagementStore} performs, so a role, permission
 * grant, or user-role assignment change made through `rbac:manage` is
 * visible on the very next `check()` call, never stale for up to the TTL.
 * `resetPolicyStoreForTests()` also clears it, so no cached decision from
 * one test leaks into the next.
 */
import type { AuditSink } from "../../core/audit.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import type { PluginLifecycleContext } from "../../core/loader.js";
import {
  createRbacManagementApi,
  type RbacManagementApi,
  type RbacManagementStore,
} from "./src/manage.js";
import { can, type PolicyStore } from "./src/policy.js";
import type { Permission, Role, RolePermission, UserRole } from "./src/types.js";

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
 * In-memory role/permission catalogs backing `rbac:manage` (feature #36) —
 * keyed by {@link Role.id}/{@link Permission.id}, exported mutable state
 * mirroring {@link policyStore}'s own precedent (see that export's docs)
 * so tests (and, until a real permission-catalog-populating mechanism such
 * as feature #37's seed data lands, any other caller) can seed a
 * permission directly with a plain `.set(...)` call, no management
 * operation required. `rbac:manage` itself never creates permissions —
 * feature #36's own description scopes it to role create/update/delete
 * plus permission/role assign/revoke — so {@link permissionCatalog}
 * starts, and stays, empty unless something outside this module populates
 * it; a `rbac:manage` caller trying to assign an unseeded permission
 * correctly gets `manage.ts`'s "nonexistent permission" validation error.
 */
export const roleCatalog: Map<string, Role> = new Map();
export const permissionCatalog: Map<string, Permission> = new Map();

/**
 * Default TTL, in milliseconds, a cached `check()` decision stays valid
 * for before it would (absent an invalidating mutation) be recomputed —
 * see {@link checkCacheState} and this module's "Policy decision caching"
 * docs above. Short relative to typical session lengths: this cache exists
 * to collapse bursts of repeated checks (the same request re-checking the
 * same permission, a render loop calling `check()` per row), not to serve
 * a decision long after it might have gone stale.
 */
export const DEFAULT_CHECK_CACHE_TTL_MS = 5000;

/** One memoized `check()` decision, plus when it stops being valid. */
interface CheckCacheEntry {
  readonly allowed: boolean;
  readonly expiresAt: number;
}

/**
 * Backing state for `check()`'s decision cache (feature #35) — exported,
 * mutable state mirroring {@link policyStore}/{@link auditState}'s own
 * precedent (see {@link policyStore}'s docs) so tests can inspect/tune it
 * (e.g. shrink `ttlMs` to assert on expiry) without a dedicated
 * configuration capability. `entries` is keyed by {@link checkCacheKey}'s
 * `(userId, action, resource)` encoding.
 */
export const checkCacheState: { ttlMs: number; entries: Map<string, CheckCacheEntry> } = {
  ttlMs: DEFAULT_CHECK_CACHE_TTL_MS,
  entries: new Map(),
};

/**
 * Encode a `(userId, action, resource)` triple as a single cache key.
 * `JSON.stringify` over the 3-tuple (rather than plain string
 * concatenation) means no combination of inputs can collide across the
 * join points — e.g. `userId: "a", action: "b:c"` never collides with
 * `userId: "a:b", action: "c"` the way naive `${userId}:${action}`
 * concatenation could.
 */
function checkCacheKey(userId: string, action: string, resource: string): string {
  return JSON.stringify([userId, action, resource]);
}

/**
 * Drop every cached `check()` decision immediately. Called by every
 * mutating {@link createInMemoryManagementStore} operation (feature #35
 * step 2), so a role/permission/assignment change is visible on the very
 * next `check()` call, not after the TTL.
 *
 * A full clear, not surgical per-key eviction: `can()`'s grants are
 * additive across a user's roles and wildcard-aware (`policy.ts` rules
 * 2–3), so a single mutation — e.g. revoking a `"wiki:*"` grant from a
 * role — can change the cached answer for every action on `wiki`, for
 * every user holding that role, across keys this function has no cheap
 * way to enumerate without re-deriving the same join `can()` already does
 * (at which point the cache buys nothing). Management mutations are rare
 * relative to `check()` calls — the entire premise of caching decisions in
 * the first place — so clearing everything on the rare path is correct
 * and cheap; only checks that outlive the mutation on the (already fast)
 * hot path recompute once and re-populate the cache.
 */
export function invalidateCheckCache(): void {
  checkCacheState.entries.clear();
}

/**
 * Reset {@link policyStore}, {@link roleCatalog}, {@link permissionCatalog},
 * {@link checkCacheState}, and {@link auditState} back to their fresh-boot
 * defaults. Test-only convenience so independent test cases sharing this
 * module's singleton state (ordinary ESM module caching within a test
 * file/process) don't leak roles, permissions, assignments, a previous
 * test's cached decisions, or a previous test's audit sink/sample counter
 * into each other — production code has no reason to call this.
 */
export function resetPolicyStoreForTests(): void {
  policyStore.userRoles.length = 0;
  policyStore.rolePermissions.length = 0;
  roleCatalog.clear();
  permissionCatalog.clear();
  checkCacheState.entries.clear();
  checkCacheState.ttlMs = DEFAULT_CHECK_CACHE_TTL_MS;
  auditState.sink = undefined;
  auditState.allowSampleEvery = 1;
  auditState.allowCount = 0;
}

/**
 * Remove every element of `array` matching `predicate`, in place. Used by
 * {@link createInMemoryManagementStore}'s revoke/delete operations instead
 * of reassigning `policyStore.userRoles`/`policyStore.rolePermissions` to a
 * new array — reassignment would detach any reference a caller already
 * holds onto (e.g. this module's own tests, which push directly into
 * `policyStore.rolePermissions`/`.userRoles`, per {@link policyStore}'s own
 * docs), whereas an in-place splice keeps every existing reference valid.
 */
function removeInPlace<T>(array: T[], predicate: (item: T) => boolean): void {
  for (let i = array.length - 1; i >= 0; i -= 1) {
    const item = array[i];
    if (item !== undefined && predicate(item)) {
      array.splice(i, 1);
    }
  }
}

/**
 * The {@link RbacManagementStore} implementation `rbac:manage` (feature
 * #36) is currently wired with — see this module's doc comment for why an
 * in-memory adapter over {@link policyStore}/{@link roleCatalog}/{@link
 * permissionCatalog} rather than the real `db:query`-backed `store.ts`
 * (feature #34): `check()` itself still reads the same in-memory
 * `policyStore`, so backing `rbac:manage` the same way keeps every
 * management mutation visible to `can()`'s next fresh read, and keeps this
 * plugin's manifest exactly as declared today (no new
 * `capabilities.requires`/`depends_on` on `database-mysql`, whose own
 * entry point does not exist yet).
 *
 * Every operation that actually changes `policyStore`/`roleCatalog`/
 * `permissionCatalog` also calls {@link invalidateCheckCache} (feature
 * #35 step 2), so `check()`'s cache never serves a decision a mutation
 * just invalidated. `getRole`/`listRoles`/`getPermission` are pure reads
 * and need no invalidation.
 */
function createInMemoryManagementStore(): RbacManagementStore {
  return {
    async getRole(id) {
      return roleCatalog.get(id);
    },

    async listRoles() {
      return Array.from(roleCatalog.values());
    },

    async createRole(role) {
      if (roleCatalog.has(role.id)) {
        throw new ValidationError(`Role "${role.id}" already exists.`, {
          details: { roleId: role.id },
        });
      }
      roleCatalog.set(role.id, role);
      invalidateCheckCache();
    },

    async updateRole(id, changes) {
      const existing = roleCatalog.get(id);
      if (!existing) {
        throw new NotFoundError(`Role "${id}" does not exist.`, { details: { roleId: id } });
      }
      const name = changes.name ?? existing.name;
      const description =
        "description" in changes ? (changes.description ?? undefined) : existing.description;
      const updated: Role = description === undefined ? { id, name } : { id, name, description };
      roleCatalog.set(id, updated);
      invalidateCheckCache();
      return updated;
    },

    async deleteRole(id) {
      roleCatalog.delete(id);
      removeInPlace(policyStore.rolePermissions, (grant) => grant.roleId === id);
      removeInPlace(policyStore.userRoles, (assignment) => assignment.roleId === id);
      invalidateCheckCache();
    },

    async getPermission(id) {
      return permissionCatalog.get(id);
    },

    async assignPermissionToRole(roleId, permissionId) {
      const alreadyGranted = policyStore.rolePermissions.some(
        (grant) => grant.roleId === roleId && grant.permissionId === permissionId,
      );
      if (alreadyGranted) {
        throw new ValidationError(
          `Permission "${permissionId}" is already assigned to role "${roleId}".`,
          { details: { roleId, permissionId } },
        );
      }
      policyStore.rolePermissions.push({ roleId, permissionId });
      invalidateCheckCache();
    },

    async revokePermissionFromRole(roleId, permissionId) {
      removeInPlace(
        policyStore.rolePermissions,
        (grant) => grant.roleId === roleId && grant.permissionId === permissionId,
      );
      invalidateCheckCache();
    },

    async assignRoleToUser(userId, roleId) {
      const alreadyAssigned = policyStore.userRoles.some(
        (assignment) => assignment.userId === userId && assignment.roleId === roleId,
      );
      if (alreadyAssigned) {
        throw new ValidationError(`Role "${roleId}" is already assigned to user "${userId}".`, {
          details: { userId, roleId },
        });
      }
      policyStore.userRoles.push({ userId, roleId });
      invalidateCheckCache();
    },

    async revokeRoleFromUser(userId, roleId) {
      removeInPlace(
        policyStore.userRoles,
        (assignment) => assignment.userId === userId && assignment.roleId === roleId,
      );
      invalidateCheckCache();
    },
  };
}

/**
 * Backing audit state for `check()`'s access-decision logging (feature #38)
 * — exported, mutable state, mirroring {@link policyStore}'s own precedent
 * (see that export's docs) rather than a private module variable, so:
 *
 *   - {@link onInstall} wires the kernel's real audit sink in when this
 *     plugin is loaded normally, through `loadPlugins()`;
 *   - tests that call `check()` directly — most of this module's existing
 *     tests, which never go through `loadPlugins()`/`onInstall` at all (see
 *     `tests/plugins/rbac/index.test.ts`) — can still seed a sink (and tune
 *     the sample rate) with a plain assignment, no lifecycle hook required.
 *
 * `sink` starts `undefined`: a `check()` made before it is wired (or in a
 * test that never wires one) still returns its allow/deny result — it's
 * simply not audited, exactly like `broker.ts`'s own optional `auditSink`.
 * See the module docs' "High-frequency checks: allow-sampling tradeoff" for
 * what `allowSampleEvery`/`allowCount` do.
 */
export const auditState: {
  sink: AuditSink | undefined;
  allowSampleEvery: number;
  allowCount: number;
} = {
  sink: undefined,
  allowSampleEvery: 1,
  allowCount: 0,
};

/**
 * Record one access-check decision to {@link auditState.sink}, if one is
 * configured — a no-op otherwise. Denies are always recorded in full;
 * allows are recorded 1-out-of-every-`allowSampleEvery` (default: every
 * one) — see the module docs' sampling tradeoff for why the two are treated
 * differently. Never throws: a malformed/missing sink degrades to "this
 * decision goes unaudited," never to a broken access check.
 */
function recordCheckDecision(
  userId: string,
  action: string,
  resource: string,
  allowed: boolean,
): void {
  const sink = auditState.sink;
  if (!sink) {
    return;
  }

  if (allowed) {
    auditState.allowCount += 1;
    const every = Math.max(1, Math.trunc(auditState.allowSampleEvery));
    if (auditState.allowCount % every !== 0) {
      return;
    }
  }

  sink.record({
    actor: userId,
    action,
    target: resource,
    outcome: allowed ? "allowed" : "denied",
    timestamp: Date.now(),
    details: { kind: "rbac:check" },
  });
}

/**
 * Deny-by-default policy check, memoized (feature #35): a `(userId,
 * action, resource)` triple already answered within the last {@link
 * checkCacheState.ttlMs} milliseconds returns the cached decision instead
 * of re-walking `policyStore` through `can()`. A cache miss (first time
 * this triple was asked about, or its entry expired) falls through to
 * `can()` and populates the cache for next time. Every call — hit or miss
 * — is still audited via {@link recordCheckDecision}: caching is purely a
 * `can()`-computation optimization, invisible to the audit trail, which
 * cares about how many times a decision was *asked for*, not how many
 * times it was *computed* (see `audit.test.ts`'s allow-sampling tests,
 * which call `check()` on the same triple repeatedly and expect every call
 * counted).
 */
function check(userId: string, action: string, resource: string): boolean {
  const key = checkCacheKey(userId, action, resource);
  const now = Date.now();
  const cached = checkCacheState.entries.get(key);

  let allowed: boolean;
  if (cached !== undefined && cached.expiresAt > now) {
    allowed = cached.allowed;
  } else {
    allowed = can(policyStore as PolicyStore, userId, action, resource);
    checkCacheState.entries.set(key, { allowed, expiresAt: now + checkCacheState.ttlMs });
  }

  recordCheckDecision(userId, action, resource, allowed);
  return allowed;
}

/**
 * Copies the kernel's real audit sink (`loader.ts`'s
 * `PluginLifecycleContext.auditSink`, feature #38) into {@link auditState}
 * so every subsequent `check()` call is audited. The only lifecycle hook
 * this plugin needs — `check()` itself remains a stable closure over
 * {@link policyStore}/{@link auditState} from the moment this module is
 * imported, exactly as before this feature; this hook exists solely to
 * receive the one piece of kernel-provided context (the sink) that isn't
 * available at module-import time.
 */
export function onInstall(context: PluginLifecycleContext): void {
  auditState.sink = context.auditSink;
}

/**
 * Registered with the broker before this module's lifecycle hooks run (see
 * `loader.ts`'s declare-before-hooks ordering). Neither `rbac:check` nor
 * `rbac:manage` needs per-instance construction (unlike api-gateway's
 * Fastify instance, which needs `onEnable`) — `check()` is a stable closure
 * over {@link policyStore} from the moment this module is imported, and
 * {@link managementApi} (feature #36) is built once, at module scope, over
 * the in-memory adapter {@link createInMemoryManagementStore} returns —
 * itself a closure over the same module-level state — plus `check` as its
 * self-referential authorizer; `provides` is therefore built at module
 * scope here, same as before {@link onInstall} existed.
 */
const managementApi: RbacManagementApi = createRbacManagementApi(createInMemoryManagementStore(), {
  check,
});

export const provides: Readonly<Record<string, unknown>> = {
  "rbac:check": { check } satisfies RbacCheckCapability,
  "rbac:manage": managementApi,
};

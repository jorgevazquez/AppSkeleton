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
import type { AuditSink } from "../../core/audit.js";
import type { PluginLifecycleContext } from "../../core/loader.js";
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
 * Reset {@link policyStore} and {@link auditState} back to their fresh-boot
 * defaults. Test-only convenience so independent test cases sharing this
 * module's singleton state (ordinary ESM module caching within a test
 * file/process) don't leak roles, permissions, or a previous test's audit
 * sink/sample counter into each other — production code has no reason to
 * call this.
 */
export function resetPolicyStoreForTests(): void {
  policyStore.userRoles.length = 0;
  policyStore.rolePermissions.length = 0;
  auditState.sink = undefined;
  auditState.allowSampleEvery = 1;
  auditState.allowCount = 0;
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

function check(userId: string, action: string, resource: string): boolean {
  const allowed = can(policyStore as PolicyStore, userId, action, resource);
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
 * `loader.ts`'s declare-before-hooks ordering). `rbac:check` needs no
 * per-instance construction (unlike api-gateway's Fastify instance, which
 * needs `onEnable`) — `check()` is a stable closure over {@link policyStore}
 * from the moment this module is imported; `provides` is therefore built at
 * module scope here, same as before {@link onInstall} existed.
 */
export const provides: Readonly<Record<string, unknown>> = {
  "rbac:check": { check } satisfies RbacCheckCapability,
};

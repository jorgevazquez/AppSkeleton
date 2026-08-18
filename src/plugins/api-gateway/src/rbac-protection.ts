/**
 * RBAC middleware integration: per-route required permission (feature #65).
 *
 * Completes the "gate a route behind a permission" half of `registerRoute()`'s
 * `requiredPermission` option (`./route-capability.ts`, step 1): a single
 * `preHandler` hook, wired onto the api-gateway-owned Fastify instance once
 * in `../index.ts`'s `buildApp()`, that runs before *any* protected route's
 * own handler.
 *
 * ## Resolving "who is the caller" (step 1)
 *
 * There is no separate user-account system in this codebase yet — the
 * signed session id feature #63's `session.ts` issues/verifies is already
 * documented as "the value a caller should actually use to key server-side
 * session state" (see `./session.ts`'s `issueSessionCookie` docs). This hook
 * takes that literally: the bare session id `readSessionId()` returns *is*
 * the `userId` passed to `rbac:check`. A request with no valid session
 * cookie at all has no identity to check anything against.
 *
 * `SessionConfig` (which needs `SESSION_SECRET`, feature #63's one
 * *required* config field) is loaded lazily, inside the hook, and only for a
 * request that actually matched a `requiredPermission`-protected route —
 * mirroring `./session-config.ts`'s own documented split between
 * `loadCookieConfig()` (safe to call unconditionally at boot) and
 * `loadSessionConfig()` ("loaded on demand by whichever route handler
 * actually needs it"). A deployment that registers no protected route never
 * needs `SESSION_SECRET` configured at all.
 *
 * ## Obtaining `rbac:check` lazily, not at `buildApp()` time
 *
 * `capabilities.obtain()` only succeeds once a provider is actually
 * registered with the broker (`core/broker.ts`) — and plugin load order is
 * driven purely by `depends_on` (`core/graph.ts`), not by
 * `capabilities.requires`/`provides`, so there is no guarantee `rbac` has
 * already registered `rbac:check` by the moment api-gateway's own `onEnable`
 * runs `buildApp()`. Calling `obtain()` there would be a load-order race.
 * Calling it here instead — inside the hook, once per protected request —
 * is always safe: by the time any HTTP request is actually being served,
 * the entire plugin-load pass has long since completed (see
 * `../../../server/index.ts`'s "listening only ever happens strictly after
 * the whole plugin-load pass completes" module docs).
 *
 * ## Step 2 — 401 vs. 403, without leaking which one more than necessary
 *
 * Two distinct failure modes, two distinct `AppError` subclasses
 * (`core/errors.ts`):
 *
 *   - No valid session at all → {@link AuthenticationError} (401). `rbac:check`
 *     is never even consulted — there is no identity to ask it about.
 *   - A valid session, but `rbac:check(userId, action, resource)` returns
 *     `false` → {@link AuthorizationError} (403).
 *
 * Both errors' client-visible `publicMessage` is a fixed, generic string —
 * see their own docs in `core/errors.ts` for why: the 401-vs-403 status
 * split is already the full distinction step 2 wants a client to see. Every
 * other detail (the route, the required permission, the resolved user id,
 * *why* a check failed) only ever goes into the error's internal `message`,
 * which `error-handler.ts`'s uniform envelope never serializes to a client
 * (see `core/errors.ts`'s own `AppError` docs) — available to an operator
 * from their own logs, never from the response body.
 */
import type { PluginCapabilityAccess } from "../../../core/broker.js";
import { AuthenticationError, AuthorizationError } from "../../../core/errors.js";
import { isErr } from "../../../core/types.js";
import type { RbacCheckCapability } from "../../rbac/index.js";
import type { ApiGatewayApp } from "../index.js";
import type { ParsedRequiredPermission } from "./route-capability.js";
import { loadSessionConfig, type SessionConfig } from "./session-config.js";
import { readSessionId } from "./session.js";

/**
 * Extends Fastify's own route-config extension point — the same one
 * `./csrf.ts` already augments with `csrfExempt` — so `requiredPermission`
 * is properly typed wherever a route's config is read or written, without a
 * manual cast at either call site (`./route-capability.ts` writing it, this
 * module's hook reading it).
 */
declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * Set by `registerRoute()`'s `requiredPermission` option — see
     * `./route-capability.ts`'s `RegisterRouteOptions.requiredPermission`
     * docs. When present, {@link registerRbacProtection}'s hook resolves the
     * caller's identity and checks it against this permission before the
     * route's own handler ever runs. Absent (the overwhelming majority of
     * routes) means the hook skips this route entirely.
     */
    requiredPermission?: ParsedRequiredPermission;
  }
}

/** The capability id `rbac`'s plugin registers `check()` under (feature #39). */
const RBAC_CHECK_CAPABILITY_ID = "rbac:check";

export interface RegisterRbacProtectionOptions {
  /**
   * Override for resolving `SessionConfig` — defaults to the real
   * `loadSessionConfig` (reads `SESSION_SECRET`/`COOKIE_SECURE`/
   * `SESSION_COOKIE_NAME` from the environment). Only ever called for a
   * request that actually matched a `requiredPermission`-protected route
   * (see this module's docs on why that stays lazy). Test-only seam,
   * mirroring this plugin's other `register*` functions' options objects
   * (e.g. `./error-handler.ts`'s `RegisterErrorHandlingOptions.nodeEnv`).
   */
  loadSessionConfig?: () => SessionConfig;
}

/**
 * Wire the RBAC `preHandler` hook onto `app` (step 1). Must be called once,
 * before any route that might set `requiredPermission` is registered —
 * mirrors `../index.ts`'s own ordering for `registerCsrfProtection`/
 * `registerSessionCookies` (a `preHandler` hook, like this one and CSRF's,
 * runs against `request.routeOptions.config` — populated once the request
 * has matched a route — so registration order relative to *route*
 * registration doesn't matter, only relative to *other hooks* it depends
 * on: `request.cookies`, already populated by `registerSessionCookies`'s
 * `onRequest` hook, same ordering guarantee CSRF's own docs explain).
 *
 * `capabilities` is `context.capabilities` from api-gateway's own
 * `PluginLifecycleContext` (`../index.ts`'s `onEnable`) — the narrow,
 * identity-bound facade api-gateway itself was handed as a plugin, not the
 * full broker (see `core/broker.ts`'s "No ambient authority" docs). Reusing
 * it here means every `rbac:check` obtain this hook performs is properly
 * attributed to api-gateway in the broker's own audit trail, exactly like
 * any other capability api-gateway consumes.
 */
export function registerRbacProtection(
  app: ApiGatewayApp,
  capabilities: PluginCapabilityAccess,
  options: RegisterRbacProtectionOptions = {},
): void {
  const resolveSessionConfig = options.loadSessionConfig ?? loadSessionConfig;

  app.addHook("preHandler", async (request) => {
    const requiredPermission = request.routeOptions.config?.requiredPermission;
    if (requiredPermission === undefined) {
      return;
    }

    const routeLabel = `${request.method} ${request.url}`;
    const permissionLabel = `${requiredPermission.resource}:${requiredPermission.action}`;

    const sessionConfig = resolveSessionConfig();
    const userId = readSessionId(request, sessionConfig);
    if (userId === undefined) {
      throw new AuthenticationError(
        `${routeLabel} requires permission "${permissionLabel}" but the request carried no valid ` +
          `session cookie.`,
      );
    }

    const obtained = capabilities.obtain<RbacCheckCapability>(RBAC_CHECK_CAPABILITY_ID);
    if (isErr(obtained)) {
      // api-gateway itself couldn't reach rbac:check (not granted, or the
      // rbac plugin isn't loaded) — a deployment/wiring problem, not this
      // particular user's access decision. Still surfaces as 403, not a
      // 500: from the caller's point of view "you may not do this" is the
      // only observable fact either way, and collapsing this into the same
      // generic AuthorizationError avoids adding a third distinguishable
      // outcome step 2 didn't ask for.
      throw new AuthorizationError(
        `${routeLabel} requires permission "${permissionLabel}" for user "${userId}", but api-gateway ` +
          `could not obtain "${RBAC_CHECK_CAPABILITY_ID}": ${obtained.error.message}`,
      );
    }

    const allowed = obtained.value.check(
      userId,
      requiredPermission.action,
      requiredPermission.resource,
    );
    if (!allowed) {
      throw new AuthorizationError(
        `${routeLabel} requires permission "${permissionLabel}", which user "${userId}" does not hold.`,
      );
    }
  });
}

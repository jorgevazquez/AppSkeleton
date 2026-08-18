/**
 * api-gateway plugin lifecycle module (feature #58 — "Fastify instance owned
 * by api-gateway, mounted into kernel bootstrap").
 *
 * spec.md: "The single place HTTP routes come into existence. Wraps
 * Fastify..." — this module is where that wrapping actually happens. Nothing
 * outside this plugin ever calls `Fastify(...)` directly; the kernel
 * bootstrap (`src/server/index.ts`) only ever reaches the resulting instance
 * through the `http:route` capability this plugin registers, which is how
 * spec.md's "no plugin imports another plugin's internals directly — only
 * via kernel-brokered capabilities" holds for the HTTP layer too.
 *
 * ## Why the Fastify instance is constructed in `onEnable`, not at module scope
 *
 * The loader (`loader.ts`) registers a plugin's `capabilities.provides`
 * implementations with the broker *before* calling `onInstall`/`onEnable` —
 * so `provides["http:route"]` must already be a stable object reference by
 * the time this module is first imported. To still honor this feature's
 * step 1 ("move Fastify construction ... into the api-gateway plugin's
 * `onEnable` hook"), `provides["http:route"]` is a small, stable facade
 * ({@link HttpRouteCapability}) whose `getApp()` method closes over a
 * module-level `app` variable that is only assigned once `onEnable` actually
 * runs `Fastify(...)` — the facade object itself never changes identity, but
 * it has nothing live to hand back until `onEnable` has run.
 *
 * ## Scope of this feature
 *
 * This module owns constructing the instance and a `/health` route, proving
 * the kernel can mount and listen on a plugin-owned Fastify instance
 * (feature #58) — plus the typed `registerRoute()` surface other plugins
 * use to register their own routes through `http:route` (feature #59, see
 * `./src/route-capability.ts`, which does the actual schema-enforcement and
 * `app.route()` wrapping; this module only wires it to the same `getApp`
 * closure `HttpRouteCapability.getApp()` already uses).
 */
import Fastify from "fastify";
import { createLogger } from "../../core/logger.js";
import type { PluginLifecycleContext } from "../../core/loader.js";
import { registerCsrfProtection } from "./src/csrf.js";
import { registerErrorHandling } from "./src/error-handler.js";
import { loadRateLimitConfig } from "./src/rate-limit-config.js";
import { registerRateLimiting } from "./src/rate-limit.js";
import {
  createRouteRegistrar,
  type HttpRouteRegistrationCapability,
} from "./src/route-capability.js";
import { loadSecurityHeadersConfig } from "./src/security-headers-config.js";
import { registerSecurityHeaders } from "./src/security-headers.js";
import { loadCookieConfig } from "./src/session-config.js";
import { registerSessionCookies } from "./src/session.js";

// Re-exported so a consuming plugin (or a test) can reference the CSRF
// cookie/header names or the protection hook itself without reaching into
// this plugin's `src/` internals — feature #64, see `./src/csrf.ts` for the
// full contract.
export {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  generateCsrfToken,
  registerCsrfProtection,
} from "./src/csrf.js";

// Re-exported so a consuming plugin (or a test) can issue/verify signed
// session cookies without reaching into this plugin's `src/` internals —
// feature #63, see `./src/session.ts` and `./src/session-config.ts` for the
// full contract.
export {
  issueSessionCookie,
  issueSessionId,
  readSessionId,
  registerSessionCookies,
  verifySessionId,
} from "./src/session.js";
export {
  loadCookieConfig,
  loadSessionConfig,
  type CookieConfig,
  type SessionConfig,
} from "./src/session-config.js";

// Re-exported so a consuming plugin (or a test) can reference the global
// rate-limit config schema/loader, or wire rate limiting onto a standalone
// test instance, without reaching into this plugin's `src/` internals —
// feature #66, see `./src/rate-limit-config.ts` and `./src/rate-limit.ts`
// for the full contract.
export {
  RateLimitConfigSchema,
  loadRateLimitConfig,
  type RateLimitConfig,
} from "./src/rate-limit-config.js";
export { registerRateLimiting } from "./src/rate-limit.js";

// Re-exported so a consuming plugin (or a test) can reference the
// security-headers config schema/loader, or wire helmet onto a standalone
// test instance, without reaching into this plugin's `src/` internals —
// feature #67, see `./src/security-headers-config.ts` and
// `./src/security-headers.ts` for the full contract.
export {
  SecurityHeadersConfigSchema,
  loadSecurityHeadersConfig,
  type SecurityHeadersConfig,
} from "./src/security-headers-config.js";
export { registerSecurityHeaders } from "./src/security-headers.js";

// Re-exported so a consuming plugin can type-only import everything it
// needs for `capabilities.obtain<HttpRouteCapability>("http:route")` calls
// (schema shape, handler signature, etc.) from this one module, the same
// way it already imports `HttpRouteCapability`/`ApiGatewayApp` from here —
// see the kernel bootstrap's own comment on why a type-only import here
// creates no runtime coupling.
export type {
  HttpMethod,
  HttpRouteRegistrationCapability,
  JsonSchemaObject,
  RegisterRouteOptions,
  RouteHandler,
  RouteRequestSchema,
  RouteSchema,
} from "./src/route-capability.js";

// Re-exported so a consuming plugin (or a test) can reference the default
// API version segment `registerRoute()` prefixes routes with (feature #62)
// without hard-coding the literal "v1" — see ./src/route-capability.ts.
export { DEFAULT_API_VERSION } from "./src/route-capability.js";

/**
 * Construct the Fastify instance this plugin owns, with the given lifecycle
 * context's logger level. A standalone function — rather than inlining this
 * in `onEnable` — purely so {@link ApiGatewayApp} can be derived from its
 * actual return type: `Fastify(...)`'s generic `LoggerType` parameter is
 * inferred from the `loggerInstance` passed here (pino's `Logger`, not
 * Fastify's own default `FastifyBaseLogger`), and those two are not
 * interchangeable in Fastify's own types (`route()`'s options are typed
 * contravariantly in `LoggerType`) — so anything holding onto this instance
 * elsewhere in this module must use this exact inferred type, not a
 * default-generic `FastifyInstance`.
 *
 * Async — unlike the rest of this module's setup — solely because
 * `registerRateLimiting()` (feature #66) and `registerSecurityHeaders()`
 * (feature #67) must be *awaited* before any route is registered:
 * `@fastify/rate-limit` and `@fastify/helmet` both intercept routes via
 * Fastify's `onRoute` hook, which fires synchronously at
 * `app.route()`/`app.get()` call time using whatever `onRoute` hooks already
 * exist *at that instant* — unlike `onRequest`/`preHandler` hooks (used by
 * `registerSessionCookies`/`registerCsrfProtection` below), it is not
 * compiled lazily against every route once `.ready()` runs. Since
 * `app.register()`'s own plugin body only actually executes once its
 * promise is awaited (or the instance boots), a fire-and-forget
 * `void app.register(fastifyRateLimit, ...)` followed immediately by a
 * synchronous `built.get("/health", ...)` would silently register `/health`
 * (and, by the same ordering, whatever route a consumer plugin registers
 * next) with no rate limiting/per-route helmet override applied at all —
 * see `./src/rate-limit.ts`'s and `./src/security-headers.ts`'s module docs
 * for the full explanation and
 * `../../../tests/plugins/api-gateway/rate-limit.test.ts` for the
 * regression this guards against. `onEnable` below awaits both functions
 * for exactly that reason.
 */
async function buildApp(context: PluginLifecycleContext) {
  const built = Fastify({
    loggerInstance: createLogger({
      level: context.logger.level,
      context: { module: "http" },
    }),
  });

  // Wired before any route is registered (feature #60) so the uniform
  // {code, message, details} envelope covers /health, every route a
  // consumer registers via registerRoute() (feature #59), Fastify's own
  // schema-validation failures, and unmatched routes alike — see
  // ./src/error-handler.ts's module docs.
  registerErrorHandling(built);

  // Wired — and *awaited* — before any route is registered (feature #66)
  // so every route, /health included, plus every route a consumer plugin
  // registers afterwards via registerRoute(), is covered by the global
  // rate-limit defaults unless it opts into a stricter per-route override
  // (route-capability.ts's `rateLimit` option). Loads
  // RATE_LIMIT_MAX/RATE_LIMIT_WINDOW_MS unconditionally, the same way
  // registerSessionCookies below loads COOKIE_SECURE unconditionally — both
  // have safe defaults, so the server can always boot without an operator
  // having configured either. Must be awaited, unlike every other call in
  // this function — see this function's own module docs above and
  // ./src/rate-limit.ts's module docs for why.
  await registerRateLimiting(built, loadRateLimitConfig());

  // Wired — and *awaited*, for the same `onRoute`-hook-timing reason as
  // registerRateLimiting above — before any route is registered (feature
  // #67) so /health and every route a consumer plugin registers afterwards
  // via registerRoute() gets a sensible-default set of security response
  // headers (CSP, HSTS, X-Frame-Options, etc.) unless the deployment
  // explicitly configures otherwise. Loads
  // HELMET_ENABLED/HELMET_CSP_ENABLED/HELMET_HSTS_ENABLED/
  // HELMET_HSTS_MAX_AGE unconditionally — like loadRateLimitConfig above,
  // every field has a safe default, so the server can always boot without
  // an operator having configured any of them. See ./src/security-headers.ts
  // and ./src/security-headers-config.ts's module docs.
  await registerSecurityHeaders(built, loadSecurityHeadersConfig());

  // Wired before any route is registered (feature #63) so `request.cookies`
  // is already populated and `reply.setCookie()` already carries the secure
  // (HttpOnly/Secure/SameSite=Lax) defaults for /health and every route a
  // consumer registers via registerRoute(). Only loads COOKIE_SECURE — see
  // ./src/session-config.ts's module docs on why this can't require
  // SESSION_SECRET to be configured yet, this early in boot.
  registerSessionCookies(built, loadCookieConfig());

  // Wired before any route is registered (feature #64) so every
  // state-changing route (POST/PUT/PATCH/DELETE) — every future
  // registerRoute() call included — gets double-submit-cookie CSRF
  // protection by default, with no per-route opt-in required. See
  // ./src/csrf.ts's module docs on why registration order relative to
  // registerSessionCookies (above) doesn't matter here (preHandler vs.
  // onRequest), and ./src/route-capability.ts's `csrfExempt` option for the
  // audited opt-out (step 2).
  registerCsrfProtection(built);

  built.get("/health", async () => ({ status: "ok" }));

  return built;
}

/** The exact Fastify instance type {@link buildApp} produces — see its docs. `Awaited` because `buildApp` is itself async (see its docs). */
export type ApiGatewayApp = Awaited<ReturnType<typeof buildApp>>;

/**
 * What api-gateway registers with the broker under the `http:route`
 * capability id: reaching the live Fastify instance (feature #58's
 * `getApp()`) plus the typed route-registration surface other plugins use
 * to mount their own endpoints on it (feature #59's `registerRoute()`, see
 * `./src/route-capability.ts`).
 */
export interface HttpRouteCapability extends HttpRouteRegistrationCapability {
  /**
   * The live Fastify instance constructed in `onEnable`. Throws if called
   * before `onEnable` has run (which should never happen for a caller
   * reading this off an already-`loaded` plugin, since `onInstall` +
   * `onEnable` always complete before a plugin is recorded as loaded — see
   * `loader.ts`).
   */
  getApp(): ApiGatewayApp;
}

/** The Fastify instance this plugin owns, constructed by `onEnable`. `undefined` before enable / after disable. */
let app: ApiGatewayApp | undefined;

function getApp(): ApiGatewayApp {
  if (!app) {
    throw new Error(
      "api-gateway: the Fastify instance was requested before onEnable constructed it.",
    );
  }
  return app;
}

/**
 * `registerRoute()`'s implementation, built once at module scope — see
 * `./src/route-capability.ts`'s docs on why it's safe to construct this
 * ahead of `onEnable` (it only closes over `getApp`, never calls it until a
 * caller actually invokes `registerRoute()`).
 */
const routeRegistrar = createRouteRegistrar(getApp);

/**
 * Registered with the broker before this module's lifecycle hooks run — see
 * module docs. Typed as always-present (`Readonly<Record<string, unknown>>`,
 * not `PluginModule["provides"]`'s `| undefined`) since this module always
 * has an `http:route` implementation to offer, regardless of lifecycle
 * state; `PluginModule["provides"]` is optional only for plugins that
 * provide nothing at all.
 */
export const provides: Readonly<Record<string, unknown>> = {
  "http:route": {
    getApp,
    registerRoute: routeRegistrar.registerRoute,
  } satisfies HttpRouteCapability,
};

/**
 * Construct the Fastify instance this plugin owns (see {@link buildApp}),
 * registering its one built-in route (`/health`, matching the pre-existing
 * toolchain smoke test's shape). `buildApp` uses a fresh `createLogger()` —
 * not `context.logger` directly — for the same reason the former placeholder
 * bootstrap did: pino `child()` bindings append alongside a parent's `base`
 * fields rather than replacing them, so reusing `context.logger` (already
 * scoped with `plugin: "api-gateway"`) as Fastify's request logger would end
 * up duplicating `module`-shaped fields instead of cleanly setting `module:
 * "http"`. The child logger's `level` is carried over so HTTP logs match the
 * rest of the kernel's configured verbosity.
 *
 * Async (returns `Promise<void>`, awaited) because `buildApp` itself is now
 * async — see its docs (feature #66). The loader (`loader.ts`) already
 * `await`s every plugin's `onEnable` before moving on to the next plugin in
 * dependency order, so this doesn't change when `getApp()` first becomes
 * safe to call for a dependent plugin's own `onEnable` — it's still only
 * ever reachable once this plugin's entire `onEnable`, rate-limit
 * registration included, has fully completed.
 */
export async function onEnable(context: PluginLifecycleContext): Promise<void> {
  app = await buildApp(context);
}

/** Release the Fastify instance's own resources and clear the module-level reference. */
export async function onDisable(): Promise<void> {
  await app?.close();
  app = undefined;
}

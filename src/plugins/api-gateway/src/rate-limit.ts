/**
 * Global rate limiting for the api-gateway-owned Fastify instance (feature
 * #66 — "Configurable rate limiting (global and per-route)").
 *
 * spec.md frames api-gateway as the single place HTTP concerns like request
 * validation and consistent error envelopes live — this module is where
 * rate limiting joins that list. `registerRateLimiting(app, config)` wires
 * `@fastify/rate-limit` (already a dependency) as a *global* default
 * (step 1, first half): every route registered afterwards — `/health`
 * included, plus every route a consumer plugin mounts via `registerRoute()`
 * — is rate-limited unless it opts into a per-route override.
 *
 * ## Per-route overrides (step 1, second half)
 *
 * `@fastify/rate-limit` itself supports overriding its global defaults per
 * route via that route's own `config.rateLimit` (an object it deep-merges
 * over the global settings — see its `onRoute` hook — or the literal
 * `false` to disable rate limiting for that route entirely). This module
 * doesn't need to implement that merge itself; `route-capability.ts`'s
 * `registerRoute()` just needs to thread its own typed `rateLimit` option
 * through to that same `config.rateLimit` slot (see that module's docs) —
 * the *intended* use is a *stricter* override (a lower `max` and/or shorter
 * `timeWindow` than the global default), e.g. a login or password-reset
 * route that should rate-limit far more aggressively than the rest of the
 * API, though nothing here enforces "stricter" as a runtime invariant
 * (`@fastify/rate-limit` has no concept of "stricter than the global
 * default" to validate against — it's on the caller to actually pass a
 * tighter value).
 *
 * ## 429 responses (step 2)
 *
 * By default, `@fastify/rate-limit` throws a plain `Error` (with a bolted-on
 * `statusCode = 429`) when a client exceeds its limit — which, left alone,
 * would fall through `error-handler.ts`'s generic "non-AppError but has a
 * 4xx statusCode" branch (`toGenericClientErrorEnvelope`) and surface with
 * `code: "BAD_REQUEST"`, not a rate-limit-specific code. The
 * `errorResponseBuilder` below replaces that default with a
 * {@link RateLimitError} instead, so a rate-limited response gets the exact
 * same `{code: "RATE_LIMIT_EXCEEDED", message, details}` envelope every
 * other AppError produces, via `error-handler.ts`'s `isAppError()` branch.
 *
 * The `Retry-After` header itself is unaffected by any of this:
 * `@fastify/rate-limit` sets it directly on the reply (`res.header(...)`,
 * keyed off the remaining TTL in the current window) *before* calling
 * `errorResponseBuilder` and throwing — see its own `index.js`
 * (`rateLimitRequestHandler`) — so it's present on the response headers
 * regardless of what `errorResponseBuilder` returns, including this
 * module's `RateLimitError`.
 *
 * ## Why `registerRateLimiting()` must be awaited (unlike `registerSessionCookies`)
 *
 * `@fastify/rate-limit` enforces per-route limits by adding a Fastify
 * `onRoute` hook (inside its own plugin body) that intercepts every route
 * registered afterwards and attaches the actual rate-limiting `preHandler`/
 * `onRequest` hook to it. Unlike ordinary `onRequest`/`preHandler` hooks —
 * which Fastify compiles lazily against every route once `.ready()` runs,
 * so their registration order relative to a route declaration doesn't
 * matter (this is why `registerSessionCookies`/`registerCsrfProtection` in
 * `../index.ts` are safe to call unawaited) — `onRoute` fires *synchronously,
 * immediately*, at the exact moment `app.route()`/`app.get()` is called,
 * using only whichever `onRoute` hooks already exist at that instant. A
 * plugin registered via `app.register()` only actually *runs* its body
 * (and therefore only actually adds its `onRoute` hook) once that
 * registration is awaited (or the instance otherwise boots) — so a
 * fire-and-forget `void app.register(fastifyRateLimit, ...)` followed
 * immediately by a synchronous route declaration would silently register
 * that route with **no rate limiting applied at all**, since the hook
 * that would have intercepted it doesn't exist yet. `registerRateLimiting`
 * is therefore `async` and actually awaits `app.register(...)` internally;
 * `../index.ts`'s `buildApp()` awaits this function in turn, before
 * registering `/health` or letting any other plugin register a route.
 */
import fastifyRateLimit, { type RateLimitPluginOptions } from "@fastify/rate-limit";
import { RateLimitError } from "../../../core/errors.js";
import type { ApiGatewayApp } from "../index.js";
import type { RateLimitConfig } from "./rate-limit-config.js";

/**
 * Wire `@fastify/rate-limit` onto `app` with `config`'s global defaults
 * (step 1, first half). Must be called — and its returned promise
 * *awaited* — once, before any route that should be rate-limited is
 * registered. See this module's own docs ("Why `registerRateLimiting()`
 * must be awaited") for exactly why this can't follow
 * `registerSessionCookies`'s fire-and-forget pattern.
 *
 * `global: true` is passed explicitly (it is already `@fastify/rate-limit`'s
 * own default) purely to make step 1's "global defaults" requirement
 * legible at the call site — every route is covered unless it declares its
 * own `config.rateLimit` override (see module docs).
 */
export async function registerRateLimiting(
  app: ApiGatewayApp,
  config: RateLimitConfig,
): Promise<void> {
  // `options` is explicitly typed as `RateLimitPluginOptions` so
  // `errorResponseBuilder`'s `(request, context)` parameters below are
  // contextually typed from `@fastify/rate-limit`'s own declarations
  // (its `errorResponseBuilderContext`), rather than this module having to
  // hand-duplicate that shape and risk drifting from it.
  const options: RateLimitPluginOptions = {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: (request, context) =>
      // See module docs: replaces @fastify/rate-limit's own default plain
      // Error (statusCode bolted on, code always "BAD_REQUEST" once it
      // reaches error-handler.ts) with a proper AppError subclass so a
      // rate-limited response gets the same envelope every other AppError
      // produces.
      new RateLimitError(
        `Rate limit exceeded for ${request.method} ${request.url}: more than ` +
          `${context.max} requests, retry after ${context.after}.`,
        {
          details: {
            max: context.max,
            retryAfter: context.after,
          },
        },
      ),
  };

  await app.register(fastifyRateLimit, options);
}

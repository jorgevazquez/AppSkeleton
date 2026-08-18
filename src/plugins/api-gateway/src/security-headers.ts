/**
 * Security headers for the api-gateway-owned Fastify instance (feature #67
 * — "Security headers (CSP, HSTS, X-Frame-Options, etc.) via helmet").
 *
 * spec.md frames api-gateway as the single place HTTP concerns like a
 * consistent error envelope, rate limiting, and session cookies live — this
 * module is where response security headers join that list.
 * `registerSecurityHeaders(app, config)` wires `@fastify/helmet` (already a
 * dependency; wraps the battle-tested `helmet` npm package) onto every route
 * — `/health` included, plus every route a consumer plugin mounts via
 * `registerRoute()` — with its own sensible defaults for the headers this
 * feature names explicitly:
 *
 *   - `Content-Security-Policy` — default-src 'self' and friends (helmet's
 *     own `contentSecurityPolicy` default directives).
 *   - `Strict-Transport-Security` — `max-age=<HELMET_HSTS_MAX_AGE>;
 *     includeSubDomains` (helmet's `hsts` middleware).
 *   - `X-Frame-Options: SAMEORIGIN` (helmet's `frameguard`).
 *   - Plus the rest of helmet's default set out of the box:
 *     `X-Content-Type-Options: nosniff`, `X-DNS-Prefetch-Control: off`,
 *     `X-Download-Options: noopen`, `Referrer-Policy: no-referrer`,
 *     `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, and
 *     helmet no longer setting the deprecated `X-XSS-Protection` (removed
 *     upstream — modern browsers ignore it in favor of CSP).
 *
 * ## Configurable per-deployment (step 1)
 *
 * `security-headers-config.ts`'s `SecurityHeadersConfig` exposes the three
 * knobs an operator most plausibly needs without this module hand-rolling a
 * full CSP-directive-override surface: a master `HELMET_ENABLED` kill
 * switch, a `HELMET_CSP_ENABLED` toggle (CSP is the header most likely to
 * break a deployment's own inline scripts/third-party embeds before it's
 * been tuned), and `HELMET_HSTS_ENABLED`/`HELMET_HSTS_MAX_AGE` (HSTS only
 * makes sense once TLS is actually terminated — local dev over plain HTTP
 * is the main reason to turn it off). See that module's docs for the full
 * rationale on each field.
 *
 * ## Why `registerSecurityHeaders()` must be awaited (like rate limiting, unlike sessions/CSRF)
 *
 * `@fastify/helmet` adds an `onRoute` hook (inside its own plugin body,
 * registered via `fastify-plugin` so it applies at the root encapsulation
 * context) that lets an individual route opt out or override helmet's
 * global config via that route's own `routeOptions.helmet`. Exactly like
 * `@fastify/rate-limit` (see `rate-limit.ts`'s module docs for the full
 * mechanics), that `onRoute` hook only exists once `app.register(...)`'s
 * plugin body has actually run — which only happens once the registration
 * promise is awaited (or the instance otherwise boots). A fire-and-forget
 * `void app.register(fastifyHelmet, ...)` followed immediately by a
 * synchronous route declaration would still get the *headers* themselves
 * (helmet's header-writing hooks are ordinary `onRequest` hooks, compiled
 * lazily like `registerSessionCookies`/`registerCsrfProtection`), but would
 * silently lose any later route's ability to override/opt out via
 * `routeOptions.helmet` for that specific route, since the hook that reads
 * it wouldn't have been registered yet. `../index.ts`'s `buildApp()` awaits
 * this function, before registering `/health` or letting any other plugin
 * register a route, for exactly that reason — and to keep this module's own
 * async contract consistent with `registerRateLimiting()`'s.
 */
import fastifyHelmet, { type FastifyHelmetOptions } from "@fastify/helmet";
import type { ApiGatewayApp } from "../index.js";
import type { SecurityHeadersConfig } from "./security-headers-config.js";

/**
 * Wire `@fastify/helmet` onto `app` per `config` (step 1). Must be called —
 * and its returned promise *awaited* — once, before any route that should
 * carry these headers is registered. See this module's own docs ("Why
 * `registerSecurityHeaders()` must be awaited") for why this can't follow
 * `registerSessionCookies`'s fire-and-forget pattern.
 *
 * A no-op when `config.HELMET_ENABLED` is `false` (the deployment's own kill
 * switch — see `security-headers-config.ts`'s docs) — no headers are set at
 * all, and no `onRoute` hook is added, rather than registering helmet with
 * every individual header disabled.
 */
export async function registerSecurityHeaders(
  app: ApiGatewayApp,
  config: SecurityHeadersConfig,
): Promise<void> {
  if (!config.HELMET_ENABLED) {
    return;
  }

  // `false` fully removes the header/middleware; omitting the key entirely
  // leaves helmet's own sensible default directives in place — see module
  // docs on why CSP and HSTS are independently toggleable. Built up
  // conditionally, rather than assigning `undefined` to the keys, because
  // this project's `tsconfig.json` sets `exactOptionalPropertyTypes: true`,
  // under which `FastifyHelmetOptions["contentSecurityPolicy"]` (typed
  // `boolean | ContentSecurityPolicyOptions`, no `| undefined`) rejects an
  // explicit `undefined` value even though the key itself is optional.
  const options: FastifyHelmetOptions = {
    ...(config.HELMET_CSP_ENABLED ? {} : { contentSecurityPolicy: false as const }),
    hsts: config.HELMET_HSTS_ENABLED
      ? { maxAge: config.HELMET_HSTS_MAX_AGE, includeSubDomains: true }
      : false,
  };

  await app.register(fastifyHelmet, options);
}

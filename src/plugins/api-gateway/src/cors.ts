/**
 * CORS allow-list for the api-gateway-owned Fastify instance (feature #68 —
 * "Configurable CORS allow-list").
 *
 * `registerCors(app, config)` wires `@fastify/cors` (already a dependency)
 * onto every route — `/health` included, plus every route a consumer plugin
 * mounts via `registerRoute()` — with an origin-matching function driven by
 * `cors-config.ts`'s `CorsConfig.CORS_ORIGIN` allow-list rather than
 * `@fastify/cors`'s own upstream default (`origin: true`, which reflects
 * *any* requesting origin and would be an accidental allow-everything
 * posture for a deployment that never configures this).
 *
 * ## Deny by default (step 1)
 *
 * A request's `Origin` header is checked against the configured allow-list:
 *   - Present and on the list -> that exact origin is reflected back via
 *     `Access-Control-Allow-Origin`, and the browser proceeds.
 *   - Present but *not* on the list -> no `Access-Control-Allow-Origin`
 *     header is set at all, so the browser blocks the calling page from
 *     reading the response, no matter how the allow-list is configured
 *     (including left at its empty default). This is "deny", not an error
 *     response — the request still reaches the route handler and gets a
 *     normal response; only a *browser*, enforcing CORS client-side, treats
 *     the missing header as a denial. A non-browser caller (curl, another
 *     service) is unaffected either way, matching upstream `@fastify/cors`
 *     semantics.
 *   - Absent entirely (curl, server-to-server calls, same-origin requests) ->
 *     there is no origin to check, so the request proceeds with no CORS
 *     headers added — the allow-list has nothing to say about a request a
 *     browser was never going to apply CORS to in the first place.
 *
 * ## Why `registerCors()` must be awaited (like rate limiting and security headers)
 *
 * `@fastify/cors` adds an `onRoute` hook (registered via `fastify-plugin` so
 * it applies at the root encapsulation context, exactly like
 * `@fastify/helmet`/`@fastify/rate-limit`) that both auto-generates each
 * route's `OPTIONS` preflight handler and lets an individual route override
 * this plugin's global options via `routeOptions.cors`. That hook only
 * exists once `app.register(...)`'s plugin body has actually run — which
 * only happens once the registration promise is awaited (or the instance
 * otherwise boots). A fire-and-forget `void app.register(fastifyCors, ...)`
 * followed immediately by a synchronous route declaration would silently
 * register that route (`/health` included) with no preflight handling and
 * no CORS headers at all — see `./rate-limit.ts` and
 * `./security-headers.ts`'s module docs for the identical `onRoute`-hook-
 * timing hazard this guards against. `../index.ts`'s `buildApp()` awaits
 * this function, before registering `/health` or letting any other plugin
 * register a route, for exactly that reason.
 */
import fastifyCors from "@fastify/cors";
import type { ApiGatewayApp } from "../index.js";
import type { CorsConfig } from "./cors-config.js";

/**
 * Wire `@fastify/cors` onto `app` per `config`'s allow-list (step 1). Must
 * be called — and its returned promise *awaited* — once, before any route
 * that should be covered by CORS is registered. See this module's own docs
 * ("Why `registerCors()` must be awaited") for why this can't follow
 * `registerSessionCookies`'s fire-and-forget pattern.
 */
export async function registerCors(app: ApiGatewayApp, config: CorsConfig): Promise<void> {
  const allowedOrigins = new Set(config.CORS_ORIGIN);

  await app.register(fastifyCors, {
    origin(origin, callback) {
      if (origin === undefined || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      // Deny by default: an Origin present but not on the allow-list gets
      // no Access-Control-Allow-Origin header — see module docs.
      callback(null, false);
    },
  });
}

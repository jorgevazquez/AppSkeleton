/**
 * `registerRoute` — the typed route-registration half of the `http:route`
 * capability (feature #59 — "typed route registration API for other
 * plugins").
 *
 * spec.md frames api-gateway as "the single place HTTP routes come into
 * existence" and `http:route` as the capability every other plugin must go
 * through to mount an endpoint — nothing outside this plugin ever calls
 * `Fastify(...)` or an already-live instance's own `.route()`/`.get()`/etc.
 * directly (see `../index.ts`'s module docs, feature #58). This module is
 * the wrapper that makes that possible: {@link createRouteRegistrar} closes
 * over a `getApp()` accessor (the same one `../index.ts` already exposes)
 * and returns a `registerRoute(options)` function that validates the
 * caller declared a request *and* response JSON schema (step 2) before
 * forwarding to Fastify's own `route()` API (step 1).
 *
 * ## Why enforcement is both a compile-time type and a runtime check
 *
 * {@link RouteSchema.response} is a *required* property in the TypeScript
 * type, so a plugin written in TypeScript against this module's exported
 * types cannot even compile a `registerRoute()` call that omits it. But
 * plugin entry points are resolved via a dynamic `import()` of whatever
 * JavaScript a plugin's `entry_point` happens to contain (see
 * `src/server/index.ts`'s `resolvePluginDefinition()`) — there is no
 * compiler in that path, so a malformed or hand-written-JS caller could
 * still call `registerRoute()` with a schema missing `response` or missing
 * every request-shape field. {@link assertDeclaresRequestAndResponseSchema}
 * is the runtime backstop that makes step 2 ("enforce") hold regardless of
 * whether the caller went through TypeScript's type checker at all.
 */
import type { RateLimitOptions } from "@fastify/rate-limit";
import { ValidationError } from "../../../core/errors.js";
import type { ApiGatewayApp } from "../index.js";

/** The exact object shape `ApiGatewayApp["route"]` accepts, extracted from the live instance's own type rather than re-declared — see this module's docs on why `../index.ts`'s custom `LoggerType` generic makes a hand-rolled Fastify type risky to duplicate here. */
type AppRouteOptions = Parameters<ApiGatewayApp["route"]>[0];

/** The exact handler signature Fastify expects for a route registered on {@link ApiGatewayApp}. */
export type RouteHandler = AppRouteOptions["handler"];

/** HTTP methods this capability accepts — the subset of Fastify's own `HTTPMethods` a plugin route is expected to use. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

/**
 * A JSON Schema document (spec.md/this feature: "declares a request/response
 * JSON schema"). Deliberately typed as an open object rather than a full
 * JSON-Schema-draft type — Fastify itself does the same (its own
 * `FastifySchema` types every field as `unknown`, see `fastify`'s
 * `types/schema.d.ts`) since it defers structural validation to whichever
 * schema compiler (ajv, by default) is actually wired up, not to
 * TypeScript.
 */
export interface JsonSchemaObject {
  readonly [key: string]: unknown;
}

/** The request-side schema fields a route may declare — mirrors Fastify's own `body`/`querystring`/`params`/`headers` schema slots exactly, so this passes straight through to `app.route()`. */
export interface RouteRequestSchema {
  readonly body?: JsonSchemaObject;
  readonly querystring?: JsonSchemaObject;
  readonly params?: JsonSchemaObject;
  readonly headers?: JsonSchemaObject;
}

/**
 * The full schema a registered route must declare. `response` is required
 * (not optional) — this is the type-level half of step 2's enforcement, see
 * module docs — keyed by HTTP status code (or `"default"`, Fastify's own
 * catch-all key) to a JSON schema for that response body.
 */
export interface RouteSchema extends RouteRequestSchema {
  readonly response: Readonly<Record<string, JsonSchemaObject>>;
}

export interface RegisterRouteOptions {
  readonly method: HttpMethod;
  readonly path: string;
  readonly schema: RouteSchema;
  readonly handler: RouteHandler;
  /**
   * The API version segment this route is mounted under (feature #62 — "API
   * versioning convention"). `options.path` is prefixed as `/api/<version>`
   * before being handed to Fastify — a route registered with `path:
   * "/widgets"` is reachable at `/api/v1/widgets`, never at bare `/widgets`.
   * Defaults to {@link DEFAULT_API_VERSION} ("v1"); the overwhelming
   * majority of `registerRoute()` callers should omit this entirely and let
   * the default apply. Pass a different segment (e.g. `"v2"`) only when
   * deliberately introducing a new, breaking API version alongside the
   * existing one — see `docs/api-versioning.md` for the full
   * versioning/deprecation policy this implements.
   */
  readonly version?: string;

  /**
   * Explicit, audited opt-out from CSRF protection (feature #64, step 2).
   * Omit this for every ordinary route — by default, `registerRoute()`
   * registers every route behind `./csrf.ts`'s double-submit-cookie
   * protection (state-changing methods require a matching `x-csrf-token`
   * header; safe methods are unaffected either way). Only set this for a
   * route that is safe by construction regardless of CSRF — spec.md's own
   * example: "pure JSON APIs with strict CORS + no cookies" — i.e. nothing
   * that authenticates via an ambient browser credential (a cookie) a
   * forged cross-site request could ride along on.
   *
   * `reason` must be a real, specific justification (at least
   * {@link MIN_CSRF_EXEMPT_REASON_LENGTH} characters) — `registerRoute()`
   * throws {@link ValidationError} if it's missing or too short to be a
   * real explanation, and logs a warn-level line recording the route and
   * the stated reason (this codebase's structured-logger audit trail, see
   * `core/logger.ts`) every time an opt-out actually takes effect, so it
   * shows up in operational logs alongside everywhere else CSRF protection
   * would otherwise have applied.
   */
  readonly csrfExempt?: {
    readonly reason: string;
  };

  /**
   * Per-route override of api-gateway's global rate-limit defaults
   * (feature #66, step 1 — "support for stricter per-route overrides").
   * Omit this for every ordinary route — by default, `registerRoute()`
   * leaves the route on `@fastify/rate-limit`'s global config, wired once
   * in `../index.ts`'s `buildApp()` from `RATE_LIMIT_MAX`/
   * `RATE_LIMIT_WINDOW_MS` (see `./rate-limit-config.ts`). Pass a partial
   * `@fastify/rate-limit` options object (typically just `{ max, timeWindow
   * }`) to tighten the limit for a specific route — e.g. a login or
   * password-reset endpoint that should throttle far more aggressively than
   * the rest of the API — any field left unset still falls back to the
   * global default (`@fastify/rate-limit` deep-merges route-level config
   * over its global settings, see `./rate-limit.ts`'s module docs). Pass
   * the literal `false` to disable rate limiting for this route entirely.
   * Nothing here enforces that an override is actually *stricter* than the
   * global default — `@fastify/rate-limit` has no such concept to validate
   * against — it is on the caller to pass a tighter value.
   */
  readonly rateLimit?: RateLimitOptions | false;
}

/** Minimum length {@link RegisterRouteOptions.csrfExempt}'s `reason` must meet — see its docs. */
export const MIN_CSRF_EXEMPT_REASON_LENGTH = 20;

/** What `http:route` exposes for *registering* new routes — merged into `HttpRouteCapability` alongside `getApp()` in `../index.ts`. */
export interface HttpRouteRegistrationCapability {
  /**
   * Register a new route on the api-gateway-owned Fastify instance,
   * wrapping Fastify's own `route()` API (step 1). Throws
   * {@link ValidationError} if `options.schema` does not declare both a
   * request-shape schema (`body`/`querystring`/`params`/`headers` — at
   * least one, an explicit permissive schema like `{ type: "object" }` is a
   * valid way to declare "no input") and a `response` schema (step 2).
   * Delegates to `app.route()` — a malformed-but-present JSON schema (e.g.
   * an unknown keyword) surfaces as whatever error Fastify's own schema
   * compiler (ajv) raises at route-registration time, not from this
   * function.
   *
   * `options.path` is always mounted under an API version segment
   * (`/api/<version>`, defaulting to `/api/v1` — feature #62). A route
   * registered with `path: "/widgets"` is reachable at `/api/v1/widgets`;
   * it is never reachable at bare `/widgets`. See
   * `docs/api-versioning.md` for the full policy.
   */
  registerRoute(options: RegisterRouteOptions): void;
}

/** The request-schema slots `assertDeclaresRequestAndResponseSchema` checks — every one of `RouteRequestSchema`'s own keys. */
const REQUEST_SCHEMA_KEYS = ["body", "querystring", "params", "headers"] as const;

/**
 * The API version segment `registerRoute()` prefixes a route's `path` with
 * when `options.version` is omitted (feature #62). See
 * `docs/api-versioning.md` for the versioning/deprecation policy this
 * implements.
 */
export const DEFAULT_API_VERSION = "v1";

/** A version segment must look like `v1`, `v2`, `v10`, etc. — matches this repo's `/api/v<N>` convention (docs/api-versioning.md). */
const API_VERSION_PATTERN = /^v[1-9][0-9]*$/;

/**
 * Prefix `options.path` with `/api/<version>` (feature #62, step 1). Throws
 * {@link ValidationError} if `version` doesn't look like a version segment
 * (`v1`, `v2`, ...) — this can only be reached via a caller-supplied
 * `options.version`, since {@link DEFAULT_API_VERSION} itself always
 * matches.
 */
function buildVersionedPath(options: RegisterRouteOptions, version: string): string {
  const routeLabel = `${options.method} ${options.path}`;

  if (!API_VERSION_PATTERN.test(version)) {
    throw new ValidationError(
      `registerRoute("${routeLabel}"): version "${version}" is not a valid API version segment — ` +
        `expected something matching ${API_VERSION_PATTERN.toString()} (e.g. "v1", "v2").`,
      { details: { method: options.method, path: options.path, version } },
    );
  }

  const suffix = options.path.startsWith("/") ? options.path : `/${options.path}`;
  return `/api/${version}${suffix}`;
}

/**
 * Runtime backstop for step 2 — see module docs for why this can't be
 * type-checking alone. Throws a {@link ValidationError} (not a bare
 * `Error`) so a caller crossing this boundary sees the same AppError
 * taxonomy every other kernel-surfaced failure uses (errors.ts).
 */
function assertDeclaresRequestAndResponseSchema(options: RegisterRouteOptions): void {
  const routeLabel = `${options.method} ${options.path}`;

  const hasRequestSchema = REQUEST_SCHEMA_KEYS.some((key) => options.schema[key] !== undefined);
  if (!hasRequestSchema) {
    throw new ValidationError(
      `registerRoute("${routeLabel}"): schema must declare a request schema — at least one of ` +
        `"body", "querystring", "params", or "headers" — before this route can be registered. ` +
        `A route with no input can pass an explicit empty object schema (e.g. { "type": "object" }).`,
      { details: { method: options.method, path: options.path, missing: "request" } },
    );
  }

  const responseSchema: unknown = options.schema.response;
  const hasResponseSchema =
    typeof responseSchema === "object" &&
    responseSchema !== null &&
    Object.keys(responseSchema).length > 0;
  if (!hasResponseSchema) {
    throw new ValidationError(
      `registerRoute("${routeLabel}"): schema.response must declare at least one status-code -> JSON ` +
        `schema mapping (e.g. { "response": { "200": { "type": "object", ... } } }) before this route ` +
        `can be registered.`,
      { details: { method: options.method, path: options.path, missing: "response" } },
    );
  }
}

/**
 * Runtime backstop for {@link RegisterRouteOptions.csrfExempt}'s audit
 * requirement (step 2) — see that field's docs and module docs on why this
 * can't be type-checking alone (the same dynamic-`import()`-of-plugin-code
 * reasoning as {@link assertDeclaresRequestAndResponseSchema}). A no-op when
 * `csrfExempt` is omitted entirely, which is the overwhelming majority of
 * routes.
 */
function assertValidCsrfExemptReason(options: RegisterRouteOptions): void {
  if (options.csrfExempt === undefined) {
    return;
  }

  const routeLabel = `${options.method} ${options.path}`;
  const reason: unknown = options.csrfExempt.reason;

  if (typeof reason !== "string" || reason.trim().length < MIN_CSRF_EXEMPT_REASON_LENGTH) {
    throw new ValidationError(
      `registerRoute("${routeLabel}"): csrfExempt.reason must be a real, specific justification of ` +
        `at least ${MIN_CSRF_EXEMPT_REASON_LENGTH} characters explaining why this route is safe by ` +
        `construction without CSRF protection (e.g. "pure JSON API behind strict CORS, authenticates ` +
        `via bearer token only, never reads a cookie").`,
      { details: { method: options.method, path: options.path, missing: "csrfExempt.reason" } },
    );
  }
}

/**
 * Build the `registerRoute` implementation `../index.ts` merges into its
 * `http:route` capability object. `getApp` is passed in (rather than a live
 * instance) so this module can be constructed once at module scope, exactly
 * like `../index.ts`'s own `getApp` closure — the returned function only
 * calls `getApp()` (and therefore only throws api-gateway's own
 * "before onEnable" error) at actual `registerRoute()` call time, never at
 * construction time.
 */
export function createRouteRegistrar(getApp: () => ApiGatewayApp): HttpRouteRegistrationCapability {
  return {
    registerRoute(options: RegisterRouteOptions): void {
      assertDeclaresRequestAndResponseSchema(options);
      assertValidCsrfExemptReason(options);

      const versionedPath = buildVersionedPath(options, options.version ?? DEFAULT_API_VERSION);

      if (options.csrfExempt) {
        // The audit trail half of the opt-out (see RegisterRouteOptions.csrfExempt's
        // docs) — a structured, queryable record of every route that ever
        // disabled CSRF protection and why, independent of whoever reads
        // this source file later.
        getApp().log.warn(
          { method: options.method, path: versionedPath, reason: options.csrfExempt.reason },
          `registerRoute("${options.method} ${versionedPath}"): CSRF protection explicitly disabled ` +
            `for this route (audited opt-out, feature #64 step 2).`,
        );
      }

      const routeConfig: { csrfExempt?: true; rateLimit?: RateLimitOptions | false } = {};
      if (options.csrfExempt) {
        routeConfig.csrfExempt = true;
      }
      if (options.rateLimit !== undefined) {
        routeConfig.rateLimit = options.rateLimit;
      }

      getApp().route({
        method: options.method,
        url: versionedPath,
        schema: options.schema,
        handler: options.handler,
        config: Object.keys(routeConfig).length > 0 ? routeConfig : undefined,
      } as AppRouteOptions);
    },
  };
}

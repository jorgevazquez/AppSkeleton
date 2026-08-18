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
}

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
   */
  registerRoute(options: RegisterRouteOptions): void;
}

/** The request-schema slots `assertDeclaresRequestAndResponseSchema` checks — every one of `RouteRequestSchema`'s own keys. */
const REQUEST_SCHEMA_KEYS = ["body", "querystring", "params", "headers"] as const;

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

      getApp().route({
        method: options.method,
        url: options.path,
        schema: options.schema,
        handler: options.handler,
      } as AppRouteOptions);
    },
  };
}

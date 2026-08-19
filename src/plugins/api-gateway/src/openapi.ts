/**
 * OpenAPI 3 document generation (feature #70 — "OpenAPI documentation
 * auto-generated from registered routes").
 *
 * `./route-capability.ts`'s `registerRoute()` already enforces (feature #59,
 * step 2) that every route declares a request *and* response JSON schema —
 * this module's job is purely mechanical: fold the accumulated
 * {@link RegisteredRouteInfo} list (`getRegisteredRoutes()`, feature #70's
 * own addition to `./route-capability.ts`) into an OpenAPI 3.0.3 document,
 * with no separate schema authored by hand anywhere. `../index.ts` wires
 * {@link buildOpenApiDocument} to a `GET /api/v1/openapi.json` route
 * registered — like every other route in this codebase — through
 * `registerRoute()` itself (step 1), and {@link renderApiDocsHtml} to a
 * `GET /api/v1/docs` route for human browsing (step 2).
 *
 * ## Why `/docs` renders a static table instead of embedding real Swagger UI
 *
 * A genuine Swagger UI bundle either pulls its JS from a third-party CDN or
 * ships inline `<script>`/`<style>` tags — both are blocked by this
 * project's own secure-by-default posture: `HELMET_CSP_ENABLED` defaults to
 * `true` (`./security-headers-config.ts`), and helmet's default CSP
 * (`default-src 'self'`) would refuse to execute either an external-origin
 * script or an inline one with no nonce. Rather than special-case `/docs`
 * with a weaker CSP (or ship a vendored copy of `swagger-ui-dist`), this
 * renders a dependency-free, script-free HTML page — every registered
 * route's method/path/summary in a table, linking to the machine-readable
 * `/api/v1/openapi.json` — that works identically under this project's
 * default security headers with zero extra configuration. This is the
 * "or equivalent" the feature's own step 2 wording explicitly allows.
 */
import type { HttpMethod, JsonSchemaObject, RegisteredRouteInfo } from "./route-capability.js";

/** The OpenAPI spec version every generated document declares — see https://spec.openapis.org/oas/v3.0.3. */
export const OPENAPI_VERSION = "3.0.3";

/** Default `info.title`/`info.version` for a document built with no explicit override — see {@link BuildOpenApiDocumentOptions}. */
export const DEFAULT_OPENAPI_TITLE = "AppSkeleton API";
export const DEFAULT_OPENAPI_INFO_VERSION = "1.0.0";

/** An OpenAPI Parameter Object (the subset this module ever emits — `in: "path" | "query" | "header"`, never `"cookie"`). */
export interface OpenApiParameter {
  readonly name: string;
  readonly in: "path" | "query" | "header";
  readonly required: boolean;
  readonly schema: JsonSchemaObject;
}

/** An OpenAPI Request Body Object, always keyed to a single `application/json` media type — every `body` schema in this codebase is JSON (route-capability.ts's `RouteRequestSchema`). */
export interface OpenApiRequestBody {
  readonly required: true;
  readonly content: {
    readonly "application/json": { readonly schema: JsonSchemaObject };
  };
}

/** An OpenAPI Response Object, always keyed to a single `application/json` media type — same reasoning as {@link OpenApiRequestBody}. */
export interface OpenApiResponse {
  readonly description: string;
  readonly content: {
    readonly "application/json": { readonly schema: JsonSchemaObject };
  };
}

/** An OpenAPI Operation Object — one HTTP method on one path. */
export interface OpenApiOperation {
  readonly summary: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: OpenApiRequestBody;
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
}

/** An OpenAPI Path Item Object — every HTTP method registered on one path, keyed by lowercase method (`"get"`, `"post"`, ...). */
export type OpenApiPathItem = Readonly<Record<string, OpenApiOperation>>;

/** The full OpenAPI 3 document {@link buildOpenApiDocument} returns. */
export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Readonly<Record<string, OpenApiPathItem>>;
}

export interface BuildOpenApiDocumentOptions {
  readonly title?: string;
  readonly version?: string;
}

/** A single Fastify-style `:paramName` path segment. */
const FASTIFY_PARAM_SEGMENT = /:([A-Za-z0-9_]+)/g;

/**
 * Convert a Fastify-style path (`/widgets/:id`) into OpenAPI's own
 * `{paramName}` brace syntax (`/widgets/{id}`) — the two frameworks use
 * different, incompatible conventions for the exact same concept (a named
 * path parameter).
 */
function toOpenApiPath(fastifyPath: string): string {
  return fastifyPath.replace(FASTIFY_PARAM_SEGMENT, (_match, name: string) => `{${name}}`);
}

/** Narrow an unknown JSON-schema-shaped value down to something safe to read `properties`/`required` off of. */
function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return typeof value === "object" && value !== null;
}

/** Pull `schema.properties` out safely — `{}` for anything not shaped like an object schema with declared properties. */
function extractProperties(schema: JsonSchemaObject | undefined): Record<string, JsonSchemaObject> {
  if (!isJsonSchemaObject(schema)) {
    return {};
  }
  const properties: unknown = schema["properties"];
  if (!isJsonSchemaObject(properties)) {
    return {};
  }
  return properties as Record<string, JsonSchemaObject>;
}

/** Pull `schema.required` out safely — `[]` for anything not shaped like a string array. */
function extractRequired(schema: JsonSchemaObject | undefined): readonly string[] {
  if (!isJsonSchemaObject(schema)) {
    return [];
  }
  const required: unknown = schema["required"];
  if (!Array.isArray(required)) {
    return [];
  }
  return required.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Convert one of a route's request-side JSON Schema slots (`params`,
 * `querystring`, `headers` — never `body`, which becomes an
 * {@link OpenApiRequestBody} instead, see {@link buildRequestBody}) into
 * OpenAPI Parameter Objects, one per declared property. Path parameters are
 * always `required: true` regardless of the schema's own `required` array
 * (OpenAPI 3's own rule, spec section 4.8.11.1: "If the parameter location
 * is 'path', this property is REQUIRED and its value MUST be true") — every
 * other location follows the schema's declared `required` list.
 */
function buildParameters(
  location: OpenApiParameter["in"],
  schema: JsonSchemaObject | undefined,
): OpenApiParameter[] {
  const properties = extractProperties(schema);
  const required = extractRequired(schema);

  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: location,
    required: location === "path" ? true : required.includes(name),
    schema: propertySchema,
  }));
}

/** `schema.body` (if declared) becomes a single required `application/json` request body — every `body` schema in this codebase already is JSON (Fastify's own default body parser). */
function buildRequestBody(
  bodySchema: JsonSchemaObject | undefined,
): OpenApiRequestBody | undefined {
  if (!isJsonSchemaObject(bodySchema)) {
    return undefined;
  }
  return { required: true, content: { "application/json": { schema: bodySchema } } };
}

/** A response schema's own `description` keyword, if the route author declared one — falls back to a generic `"<status> response"` otherwise. */
function extractDescription(schema: JsonSchemaObject, status: string): string {
  const description: unknown = schema["description"];
  return typeof description === "string" && description.length > 0
    ? description
    : `${status} response`;
}

/** `schema.response` (required by `registerRoute()` for every route, feature #59 step 2) becomes one OpenAPI Response Object per declared status code. */
function buildResponses(
  responseSchemas: Readonly<Record<string, JsonSchemaObject>>,
): Record<string, OpenApiResponse> {
  const responses: Record<string, OpenApiResponse> = {};
  for (const [status, schema] of Object.entries(responseSchemas)) {
    responses[status] = {
      description: extractDescription(schema, status),
      content: { "application/json": { schema } },
    };
  }
  return responses;
}

/**
 * Derive a full OpenAPI 3 document from every route `registerRoute()` has
 * accumulated so far (`getRegisteredRoutes()`, `./route-capability.ts`,
 * feature #70 step 1). Pure and synchronous — every input is already the
 * exact JSON Schema each route declared at registration time; this function
 * performs no I/O and calls no capability.
 */
export function buildOpenApiDocument(
  routes: readonly RegisteredRouteInfo[],
  options: BuildOpenApiDocumentOptions = {},
): OpenApiDocument {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};

  for (const route of routes) {
    const openApiPath = toOpenApiPath(route.path);
    const parameters = [
      ...buildParameters("path", route.schema.params),
      ...buildParameters("query", route.schema.querystring),
      ...buildParameters("header", route.schema.headers),
    ];
    const requestBody = buildRequestBody(route.schema.body);

    const operation: OpenApiOperation = {
      summary: `${route.method} ${route.path}`,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses: buildResponses(route.schema.response),
    };

    const pathItem = (paths[openApiPath] ??= {});
    pathItem[route.method.toLowerCase()] = operation;
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: options.title ?? DEFAULT_OPENAPI_TITLE,
      version: options.version ?? DEFAULT_OPENAPI_INFO_VERSION,
    },
    paths,
  };
}

/** Escape text before interpolating it into {@link renderApiDocsHtml}'s output — every value here ultimately traces back to a plugin's own route registration, not end-user input, but this project's own convention (see `html-renderer`'s parser) is to auto-escape any interpolated text regardless of its trust level. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderOperationRow(method: string, path: string, operation: OpenApiOperation): string {
  return (
    `<tr><td>${escapeHtml(method.toUpperCase())}</td>` +
    `<td><code>${escapeHtml(path)}</code></td>` +
    `<td>${escapeHtml(operation.summary)}</td></tr>`
  );
}

/**
 * Render a minimal, script-free, CSP-safe HTML page listing every route in
 * `document.paths` — this project's "or equivalent" to a full interactive
 * Swagger UI (feature #70 step 2, see module docs for why). `openApiJsonPath`
 * is the path human readers can follow to the machine-readable document
 * itself (`/api/v1/openapi.json`) — passed in rather than hard-coded so this
 * function has no dependency on `route-capability.ts`'s versioning
 * constants.
 */
export function renderApiDocsHtml(document: OpenApiDocument, openApiJsonPath: string): string {
  const rows = Object.entries(document.paths)
    .flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) =>
        renderOperationRow(method, path, operation),
      ),
    )
    .join("\n    ");

  const title = escapeHtml(document.info.title);
  const version = escapeHtml(document.info.version);
  const jsonPath = escapeHtml(openApiJsonPath);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — API Docs</title>
</head>
<body>
  <h1>${title}</h1>
  <p>
    Version ${version} — OpenAPI ${escapeHtml(document.openapi)}.
    Machine-readable document: <a href="${jsonPath}"><code>${jsonPath}</code></a>.
  </p>
  <table>
    <thead><tr><th>Method</th><th>Path</th><th>Summary</th></tr></thead>
    <tbody>
    ${rows}
    </tbody>
  </table>
</body>
</html>
`;
}

export type { HttpMethod, JsonSchemaObject, RegisteredRouteInfo };

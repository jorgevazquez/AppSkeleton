/**
 * Unit tests for feature #70 ("OpenAPI documentation auto-generated from
 * registered routes"), step 1 (`buildOpenApiDocument`) and step 2
 * (`renderApiDocsHtml`) — driven directly against pure `RegisteredRouteInfo`
 * fixtures, the same "no live Fastify instance needed" style
 * `route-versioning.test.ts`'s `DEFAULT_API_VERSION` unit test uses for
 * anything that doesn't actually need one.
 */
import { describe, expect, it } from "vitest";
import {
  buildOpenApiDocument,
  DEFAULT_OPENAPI_INFO_VERSION,
  DEFAULT_OPENAPI_TITLE,
  OPENAPI_VERSION,
  renderApiDocsHtml,
} from "../../../src/plugins/api-gateway/src/openapi.js";
import type { RegisteredRouteInfo } from "../../../src/plugins/api-gateway/src/route-capability.js";

function route(overrides: Partial<RegisteredRouteInfo> = {}): RegisteredRouteInfo {
  return {
    method: "GET",
    path: "/api/v1/widgets",
    schema: {
      querystring: { type: "object", properties: {}, additionalProperties: false },
      response: {
        200: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    },
    ...overrides,
  };
}

describe("buildOpenApiDocument — feature #70, step 1", () => {
  it("returns a well-formed OpenAPI 3 document envelope for an empty route list", () => {
    const document = buildOpenApiDocument([]);

    expect(document.openapi).toBe(OPENAPI_VERSION);
    expect(document.openapi).toMatch(/^3\./);
    expect(document.info).toEqual({
      title: DEFAULT_OPENAPI_TITLE,
      version: DEFAULT_OPENAPI_INFO_VERSION,
    });
    expect(document.paths).toEqual({});
  });

  it("honors an explicit title/version override", () => {
    const document = buildOpenApiDocument([], { title: "Widgets API", version: "9.9.9" });

    expect(document.info).toEqual({ title: "Widgets API", version: "9.9.9" });
  });

  it("derives one path item, keyed by the route's own path, from a single registered route", () => {
    const document = buildOpenApiDocument([route()]);

    expect(Object.keys(document.paths)).toEqual(["/api/v1/widgets"]);
    expect(Object.keys(document.paths["/api/v1/widgets"] as object)).toEqual(["get"]);
  });

  it("converts Fastify's :param path syntax into OpenAPI's {param} syntax", () => {
    const document = buildOpenApiDocument([
      route({
        path: "/api/v1/widgets/:id",
        schema: {
          params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          response: { 200: { type: "object" } },
        },
      }),
    ]);

    expect(Object.keys(document.paths)).toEqual(["/api/v1/widgets/{id}"]);
  });

  it("converts every :param segment for a multi-parameter path", () => {
    const document = buildOpenApiDocument([
      route({
        path: "/api/v1/orgs/:orgId/widgets/:widgetId",
        schema: {
          params: {
            type: "object",
            properties: { orgId: { type: "string" }, widgetId: { type: "string" } },
            required: ["orgId", "widgetId"],
          },
          response: { 200: { type: "object" } },
        },
      }),
    ]);

    expect(Object.keys(document.paths)).toEqual(["/api/v1/orgs/{orgId}/widgets/{widgetId}"]);
  });

  it("groups multiple methods on the same path under one path item", () => {
    const document = buildOpenApiDocument([
      route({ method: "GET", path: "/api/v1/widgets" }),
      route({
        method: "POST",
        path: "/api/v1/widgets",
        schema: {
          body: { type: "object", properties: { name: { type: "string" } } },
          response: { 201: { type: "object" } },
        },
      }),
    ]);

    expect(Object.keys(document.paths)).toEqual(["/api/v1/widgets"]);
    expect(Object.keys(document.paths["/api/v1/widgets"] as object).sort()).toEqual([
      "get",
      "post",
    ]);
  });

  it("emits path parameters from schema.params, always required:true regardless of the schema's own required list", () => {
    const document = buildOpenApiDocument([
      route({
        path: "/api/v1/widgets/:id",
        schema: {
          // Deliberately NOT listing "id" in required — OpenAPI's own rule
          // (path params are always required) must still win.
          params: { type: "object", properties: { id: { type: "string" } } },
          response: { 200: { type: "object" } },
        },
      }),
    ]);

    const operation = document.paths["/api/v1/widgets/{id}"]?.["get"];
    expect(operation?.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ]);
  });

  it("emits query parameters from schema.querystring, required only for names in its own required list", () => {
    const document = buildOpenApiDocument([
      route({
        schema: {
          querystring: {
            type: "object",
            properties: { limit: { type: "integer" }, sort: { type: "string" } },
            required: ["limit"],
          },
          response: { 200: { type: "object" } },
        },
      }),
    ]);

    const operation = document.paths["/api/v1/widgets"]?.["get"];
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([
        { name: "limit", in: "query", required: true, schema: { type: "integer" } },
        { name: "sort", in: "query", required: false, schema: { type: "string" } },
      ]),
    );
  });

  it("emits header parameters from schema.headers", () => {
    const document = buildOpenApiDocument([
      route({
        schema: {
          headers: {
            type: "object",
            properties: { "x-api-key": { type: "string" } },
            required: ["x-api-key"],
          },
          response: { 200: { type: "object" } },
        },
      }),
    ]);

    const operation = document.paths["/api/v1/widgets"]?.["get"];
    expect(operation?.parameters).toEqual([
      { name: "x-api-key", in: "header", required: true, schema: { type: "string" } },
    ]);
  });

  it("omits `parameters` entirely when the route declares no params/querystring/headers properties", () => {
    const document = buildOpenApiDocument([
      route({ schema: { body: { type: "object" }, response: { 200: { type: "object" } } } }),
    ]);

    const operation = document.paths["/api/v1/widgets"]?.["get"];
    expect(operation?.parameters).toBeUndefined();
  });

  it("converts schema.body into a required application/json requestBody", () => {
    const bodySchema = { type: "object", properties: { name: { type: "string" } } };
    const document = buildOpenApiDocument([
      route({
        method: "POST",
        schema: { body: bodySchema, response: { 201: { type: "object" } } },
      }),
    ]);

    const operation = document.paths["/api/v1/widgets"]?.["post"];
    expect(operation?.requestBody).toEqual({
      required: true,
      content: { "application/json": { schema: bodySchema } },
    });
  });

  it("omits `requestBody` entirely when the route declares no body schema", () => {
    const document = buildOpenApiDocument([route()]);

    const operation = document.paths["/api/v1/widgets"]?.["get"];
    expect(operation?.requestBody).toBeUndefined();
  });

  it("converts every status code in schema.response into a keyed OpenAPI response, application/json content", () => {
    const okSchema = { type: "object", properties: { message: { type: "string" } } };
    const notFoundSchema = { type: "object", properties: { code: { type: "string" } } };
    const document = buildOpenApiDocument([
      route({
        schema: {
          querystring: { type: "object" },
          response: { 200: okSchema, 404: notFoundSchema },
        },
      }),
    ]);

    const operation = document.paths["/api/v1/widgets"]?.["get"];
    expect(operation?.responses).toEqual({
      "200": { description: "200 response", content: { "application/json": { schema: okSchema } } },
      "404": {
        description: "404 response",
        content: { "application/json": { schema: notFoundSchema } },
      },
    });
  });

  it("uses a response schema's own `description` keyword when present, instead of the generic fallback", () => {
    const document = buildOpenApiDocument([
      route({
        schema: {
          querystring: { type: "object" },
          response: { 200: { type: "object", description: "The requested widget." } },
        },
      }),
    ]);

    const operation = document.paths["/api/v1/widgets"]?.["get"];
    expect(operation?.responses["200"]?.description).toBe("The requested widget.");
  });

  it("sets each operation's summary to '<METHOD> <path>'", () => {
    const document = buildOpenApiDocument([route({ method: "GET", path: "/api/v1/widgets/:id" })]);

    const operation = document.paths["/api/v1/widgets/{id}"]?.["get"];
    expect(operation?.summary).toBe("GET /api/v1/widgets/:id");
  });

  it("lowercases the HTTP method as the path item's key", () => {
    const document = buildOpenApiDocument([
      route({ method: "DELETE", path: "/api/v1/widgets/:id" }),
    ]);

    expect(Object.keys(document.paths["/api/v1/widgets/{id}"] as object)).toEqual(["delete"]);
  });
});

describe("renderApiDocsHtml — feature #70, step 2 (minimal Swagger-UI-equivalent human-browsing page)", () => {
  it("renders a well-formed, self-contained HTML document with no <script> tags", () => {
    const document = buildOpenApiDocument([route()]);
    const html = renderApiDocsHtml(document, "/api/v1/openapi.json");

    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<html");
    expect(html).not.toContain("<script");
  });

  it("links to the given openapi.json path", () => {
    const document = buildOpenApiDocument([route()]);
    const html = renderApiDocsHtml(document, "/api/v1/openapi.json");

    expect(html).toContain('href="/api/v1/openapi.json"');
  });

  it("lists every route's method and path", () => {
    const document = buildOpenApiDocument([
      route({ method: "GET", path: "/api/v1/widgets" }),
      route({
        method: "POST",
        path: "/api/v1/widgets",
        schema: { body: { type: "object" }, response: { 201: { type: "object" } } },
      }),
    ]);
    const html = renderApiDocsHtml(document, "/api/v1/openapi.json");

    expect(html).toContain(">GET<");
    expect(html).toContain(">POST<");
    expect(html).toContain("/api/v1/widgets");
  });

  it("HTML-escapes a route summary that happens to contain HTML-significant characters", () => {
    const document = buildOpenApiDocument([
      route({
        path: "/api/v1/widgets/:id<script>",
        schema: { response: { 200: { type: "object" } } },
      }),
    ]);
    const html = renderApiDocsHtml(document, "/api/v1/openapi.json");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("includes the document's title and version in the page", () => {
    const document = buildOpenApiDocument([], { title: "Widgets API", version: "9.9.9" });
    const html = renderApiDocsHtml(document, "/api/v1/openapi.json");

    expect(html).toContain("Widgets API");
    expect(html).toContain("9.9.9");
  });
});

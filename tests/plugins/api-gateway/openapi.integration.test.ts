/**
 * Integration test for feature #70, step 3: "Write a test asserting the
 * generated document includes a route registered by a fixture plugin" —
 * driven through the *real* capability broker, the *real* loader
 * (`loadPlugins()`), and the *real* `api-gateway` plugin module, mirroring
 * `route-capability.integration.test.ts`'s established pattern: a fixture
 * plugin obtains `http:route` and calls `registerRoute()` from its own
 * `onEnable` (which runs *after* api-gateway's own `onEnable` — and
 * therefore after `GET /api/v1/openapi.json`/`GET /api/v1/docs` are already
 * registered), proving the generated document reflects routes registered
 * by plugins that load after api-gateway, not just api-gateway's own.
 */
import { describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isErr, isOk } from "../../../src/core/types.js";
import * as apiGatewayModule from "../../../src/plugins/api-gateway/index.js";
import type {
  HttpRouteCapability,
  OpenApiDocument,
} from "../../../src/plugins/api-gateway/index.js";

/** Mirrors route-capability.integration.test.ts's own manifest() fixture helper. */
function manifest(
  id: string,
  options: {
    dependsOn?: Record<string, string>;
    provides?: string[];
    requires?: string[];
  } = {},
): PluginManifest {
  return {
    id,
    version: "1.0.0",
    depends_on: options.dependsOn ?? {},
    capabilities: { provides: options.provides ?? [], requires: options.requires ?? [] },
    entry_point: "index.ts",
  };
}

const API_GATEWAY_MANIFEST = manifest("api-gateway", { provides: ["http:route"] });

function getHttpRoute(): HttpRouteCapability {
  return apiGatewayModule.provides?.["http:route"] as HttpRouteCapability;
}

/** A fixture plugin that registers exactly one route via http:route — the route the generated document must include. */
function widgetsFixturePlugin(): { manifest: PluginManifest; module: PluginModule } {
  const widgetsManifest = manifest("widgets-fixture", {
    dependsOn: { "api-gateway": "^1.0.0" },
    requires: ["http:route"],
  });

  const widgetsModule: PluginModule = {
    onEnable(context) {
      const obtained = context.capabilities.obtain<HttpRouteCapability>("http:route");
      if (isErr(obtained)) {
        throw obtained.error;
      }
      obtained.value.registerRoute({
        method: "GET",
        path: "/widgets/:id",
        schema: {
          params: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
          response: {
            200: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
          },
        },
        handler: async (request) => request.params,
      });
    },
  };

  return { manifest: widgetsManifest, module: widgetsModule };
}

describe("GET /api/v1/openapi.json — feature #70, steps 1 and 3", () => {
  it("includes a route registered by a fixture plugin, converted from that route's own JSON schema", async () => {
    const widgets = widgetsFixturePlugin();
    const definitions: PluginDefinition[] = [
      { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
      { manifest: widgets.manifest, module: widgets.module },
    ];

    const broker = createCapabilityBroker();
    const loadResult = await loadPlugins(definitions, broker);
    expect(isOk(loadResult)).toBe(true);
    if (!isOk(loadResult)) {
      return;
    }
    expect(loadResult.value.failed).toEqual([]);
    expect(loadResult.value.loaded.map((plugin) => plugin.id).sort()).toEqual([
      "api-gateway",
      "widgets-fixture",
    ]);

    const app = getHttpRoute().getApp();

    const res = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const document = res.json() as OpenApiDocument;
    expect(document.openapi).toMatch(/^3\./);

    // The fixture's route — GET /widgets/:id, mounted at
    // /api/v1/widgets/:id by registerRoute()'s own versioning (feature #62)
    // — must appear under OpenAPI's own {param} path syntax.
    const pathItem = document.paths["/api/v1/widgets/{id}"];
    expect(pathItem).toBeDefined();
    const operation = pathItem?.["get"];
    expect(operation).toBeDefined();

    // Derived from the fixture's own params schema (feature #70 step 1: "from
    // each route's JSON schema") — proves the document isn't a static stub.
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ]),
    );
    expect(operation?.responses["200"]).toBeDefined();

    await apiGatewayModule.onDisable();
  });

  it("reflects a route registered by a second fixture plugin that loads after the first", async () => {
    const first = widgetsFixturePlugin();

    const secondManifest = manifest("gadgets-fixture", {
      dependsOn: { "api-gateway": "^1.0.0" },
      requires: ["http:route"],
    });
    const secondModule: PluginModule = {
      onEnable(context) {
        const obtained = context.capabilities.obtain<HttpRouteCapability>("http:route");
        if (isErr(obtained)) {
          throw obtained.error;
        }
        obtained.value.registerRoute({
          method: "POST",
          path: "/gadgets",
          schema: {
            body: { type: "object", properties: { name: { type: "string" } } },
            response: { 201: { type: "object", properties: { id: { type: "string" } } } },
          },
          handler: async () => ({ id: "new-gadget" }),
        });
      },
    };

    const definitions: PluginDefinition[] = [
      { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
      { manifest: first.manifest, module: first.module },
      { manifest: secondManifest, module: secondModule },
    ];

    const broker = createCapabilityBroker();
    const loadResult = await loadPlugins(definitions, broker);
    expect(isOk(loadResult)).toBe(true);
    if (!isOk(loadResult)) {
      return;
    }
    expect(loadResult.value.failed).toEqual([]);

    const app = getHttpRoute().getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const document = res.json() as OpenApiDocument;

    expect(document.paths["/api/v1/widgets/{id}"]?.["get"]).toBeDefined();
    expect(document.paths["/api/v1/gadgets"]?.["post"]).toBeDefined();

    await apiGatewayModule.onDisable();
  });

  it("does not accumulate stale routes from a previous enable/disable cycle", async () => {
    // First cycle: only the widgets fixture.
    const widgets = widgetsFixturePlugin();
    const firstDefinitions: PluginDefinition[] = [
      { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
      { manifest: widgets.manifest, module: widgets.module },
    ];
    const firstBroker = createCapabilityBroker();
    const firstLoad = await loadPlugins(firstDefinitions, firstBroker);
    expect(isOk(firstLoad)).toBe(true);
    await apiGatewayModule.onDisable();

    // Second cycle: api-gateway alone, re-enabled fresh — the widgets
    // fixture's route from the first cycle's (now-closed) app must not
    // reappear in this new instance's document.
    const secondDefinitions: PluginDefinition[] = [
      { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
    ];
    const secondBroker = createCapabilityBroker();
    const secondLoad = await loadPlugins(secondDefinitions, secondBroker);
    expect(isOk(secondLoad)).toBe(true);

    const app = getHttpRoute().getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const document = res.json() as OpenApiDocument;

    expect(document.paths["/api/v1/widgets/{id}"]).toBeUndefined();
    // The openapi.json/docs routes this same api-gateway instance always
    // registers are still present — proving this is a fresh-but-populated
    // registry, not a broken/empty one.
    expect(document.paths["/api/v1/openapi.json"]).toBeDefined();

    await apiGatewayModule.onDisable();
  });
});

describe("GET /api/v1/docs — feature #70, step 2", () => {
  it("renders a minimal, human-browsable HTML page listing registered routes, including a fixture plugin's", async () => {
    const widgets = widgetsFixturePlugin();
    const definitions: PluginDefinition[] = [
      { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
      { manifest: widgets.manifest, module: widgets.module },
    ];

    const broker = createCapabilityBroker();
    const loadResult = await loadPlugins(definitions, broker);
    expect(isOk(loadResult)).toBe(true);

    const app = getHttpRoute().getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/docs" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("/api/v1/widgets/{id}");
    expect(res.body).toContain("/api/v1/openapi.json");

    await apiGatewayModule.onDisable();
  });
});

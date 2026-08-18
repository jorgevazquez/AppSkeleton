/**
 * Integration test for feature #59, step 3: "a fixture plugin registers a
 * route and it is reachable over HTTP" — driven through the *real*
 * capability broker, the *real* loader (`loadPlugins()`), and the *real*
 * `api-gateway` plugin module (not a hand-rolled fixture standing in for
 * it, unlike `tests/core/kernel.integration.test.ts`'s minimal
 * `FIXTURE_API_GATEWAY_INDEX`) — mirroring
 * `tests/plugins/api-gateway/index.test.ts`'s `loadRealApiGateway()`
 * pattern, extended with a second, fixture plugin that declares
 * `http:route` under `capabilities.requires`, obtains it in its own
 * `onEnable`, and calls `registerRoute()` to mount a brand-new endpoint —
 * proving `http:route`'s `registerRoute()` capability actually works for
 * *other* plugins, end-to-end, over a real HTTP request via
 * `app.inject()`.
 */
import { describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { PluginLoadError, ValidationError } from "../../../src/core/errors.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isErr, isOk } from "../../../src/core/types.js";
import * as apiGatewayModule from "../../../src/plugins/api-gateway/index.js";
import type { HttpRouteCapability } from "../../../src/plugins/api-gateway/index.js";

/** Build a minimal, schema-shaped manifest fixture without going through validateManifest() — mirrors loader.test.ts's own `manifest()` helper. */
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

describe("http:route registerRoute — integration (feature #59, step 3)", () => {
  it("a fixture plugin obtains http:route, registers its own route, and it answers a real HTTP request", async () => {
    const greeterManifest = manifest("greeter", {
      dependsOn: { "api-gateway": "^1.0.0" },
      requires: ["http:route"],
    });

    const greeterModule: PluginModule = {
      onEnable(context) {
        const obtained = context.capabilities.obtain<HttpRouteCapability>("http:route");
        if (isErr(obtained)) {
          throw obtained.error;
        }
        obtained.value.registerRoute({
          method: "GET",
          path: "/greet/:name",
          schema: {
            params: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
            response: {
              200: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
              },
            },
          },
          handler: async (request) => ({
            message: `hello, ${(request.params as { name: string }).name}`,
          }),
        });
      },
    };

    const definitions: PluginDefinition[] = [
      { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
      { manifest: greeterManifest, module: greeterModule },
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
      "greeter",
    ]);

    const app = getHttpRoute().getApp();

    const res = await app.inject({ method: "GET", url: "/api/v1/greet/world" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: "hello, world" });

    // The pre-existing, built-in /health route (feature #58) still works
    // side-by-side with the fixture-registered route — proving
    // registerRoute() adds to the same live instance rather than replacing
    // or shadowing it.
    const healthRes = await app.inject({ method: "GET", url: "/health" });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json()).toEqual({ status: "ok" });

    await apiGatewayModule.onDisable();
  });

  it("a request that violates the registered route's own param schema is rejected with 400, proving the declared schema is really enforced", async () => {
    const strictManifest = manifest("strict-consumer", {
      dependsOn: { "api-gateway": "^1.0.0" },
      requires: ["http:route"],
    });

    const strictModule: PluginModule = {
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
              properties: { id: { type: "integer" } },
              required: ["id"],
            },
            response: {
              200: {
                type: "object",
                properties: { id: { type: "integer" } },
                required: ["id"],
              },
            },
          },
          handler: async (request) => request.params,
        });
      },
    };

    const definitions: PluginDefinition[] = [
      { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
      { manifest: strictManifest, module: strictModule },
    ];

    const broker = createCapabilityBroker();
    const loadResult = await loadPlugins(definitions, broker);
    expect(isOk(loadResult)).toBe(true);
    if (!isOk(loadResult)) {
      return;
    }
    expect(loadResult.value.failed).toEqual([]);

    const app = getHttpRoute().getApp();

    const res = await app.inject({ method: "GET", url: "/api/v1/widgets/not-a-number" });
    expect(res.statusCode).toBe(400);

    await apiGatewayModule.onDisable();
  });

  it("a fixture plugin that tries to register a route with no response schema fails its own onEnable, isolating it without crashing api-gateway or unrelated plugins", async () => {
    const brokenManifest = manifest("broken-consumer", {
      dependsOn: { "api-gateway": "^1.0.0" },
      requires: ["http:route"],
    });

    const brokenModule: PluginModule = {
      onEnable(context) {
        const obtained = context.capabilities.obtain<HttpRouteCapability>("http:route");
        if (isErr(obtained)) {
          throw obtained.error;
        }
        obtained.value.registerRoute({
          method: "GET",
          path: "/no-schema",
          // @ts-expect-error — deliberately omitting the required "response" schema to prove enforcement.
          schema: { querystring: { type: "object" } },
          handler: async () => ({ ok: true }),
        });
      },
    };

    const unrelatedManifest = manifest("unrelated", {});
    const unrelatedModule: PluginModule = {};

    const definitions: PluginDefinition[] = [
      { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
      { manifest: brokenManifest, module: brokenModule },
      { manifest: unrelatedManifest, module: unrelatedModule },
    ];

    const broker = createCapabilityBroker();
    const loadResult = await loadPlugins(definitions, broker);
    expect(isOk(loadResult)).toBe(true);
    if (!isOk(loadResult)) {
      return;
    }

    expect(loadResult.value.loaded.map((plugin) => plugin.id).sort()).toEqual([
      "api-gateway",
      "unrelated",
    ]);
    expect(loadResult.value.failed.map((plugin) => plugin.id)).toEqual(["broken-consumer"]);
    // loadPlugins() normalizes any thrown onEnable error into a
    // PluginLoadError (see loader.ts's toPluginLoadError()), preserving the
    // original ValidationError as its `cause` — assert both layers so this
    // test proves the *right* thing failed (schema enforcement), not just
    // that *something* failed.
    const failure = loadResult.value.failed[0];
    expect(failure?.error).toBeInstanceOf(PluginLoadError);
    expect(failure?.error.cause).toBeInstanceOf(ValidationError);
    expect((failure?.error.cause as ValidationError).message).toContain("response");

    const app = getHttpRoute().getApp();
    const res = await app.inject({ method: "GET", url: "/no-schema" });
    expect(res.statusCode).toBe(404);

    await apiGatewayModule.onDisable();
  });
});

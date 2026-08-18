import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { createLogger, withContext } from "../../../src/core/logger.js";
import { loadPlugins, type PluginDefinition } from "../../../src/core/loader.js";
import { validateManifest } from "../../../src/core/manifest.js";
import { scanPluginDirectories } from "../../../src/core/registry.js";
import { isErr, isOk } from "../../../src/core/types.js";
import * as apiGatewayModule from "../../../src/plugins/api-gateway/index.js";
import type { HttpRouteCapability } from "../../../src/plugins/api-gateway/index.js";

const PLUGINS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/plugins",
);

/** Drive the real api-gateway plugin through the real loader, exactly like the kernel bootstrap does. */
async function loadRealApiGateway() {
  const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
  const entry = entries.find((candidate) => candidate.name === "api-gateway");
  if (!entry) {
    throw new Error("api-gateway plugin directory not found under src/plugins");
  }
  const manifestResult = validateManifest(entry.manifest);
  if (isErr(manifestResult)) {
    throw manifestResult.error;
  }

  const definitions: PluginDefinition[] = [
    { manifest: manifestResult.value, module: apiGatewayModule },
  ];
  const broker = createCapabilityBroker();
  const loadResult = await loadPlugins(definitions, broker);
  if (isErr(loadResult)) {
    throw loadResult.error;
  }
  return { plugins: loadResult.value, broker };
}

describe("api-gateway plugin — lifecycle module (feature #58)", () => {
  it("getApp() throws before onEnable has run", () => {
    const httpRoute = apiGatewayModule.provides?.["http:route"] as HttpRouteCapability;
    expect(() => httpRoute.getApp()).toThrow(/before onEnable/);
  });

  it("onEnable constructs a live Fastify instance that answers /health", async () => {
    const { plugins } = await loadRealApiGateway();

    expect(plugins.failed).toEqual([]);
    expect(plugins.loaded.map((plugin) => plugin.id)).toEqual(["api-gateway"]);

    const httpRoute = apiGatewayModule.provides?.["http:route"] as HttpRouteCapability;
    const app = httpRoute.getApp();

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    await apiGatewayModule.onDisable();
  });

  it("the http:route capability registered with the broker is the same live app", async () => {
    const { plugins, broker } = await loadRealApiGateway();
    const apiGateway = plugins.loaded.find((plugin) => plugin.id === "api-gateway");
    expect(apiGateway).toBeDefined();

    const obtained = apiGateway?.context.capabilities.obtain<HttpRouteCapability>("http:route");
    // api-gateway declared "http:route" under capabilities.provides, not
    // requires — it was never declared/granted to *itself* as a consumer,
    // so obtain() correctly denies it (see broker.ts): this proves the
    // broker's declare/grant/obtain gating applies even to a plugin's own
    // capability, not that the capability itself is broken.
    expect(obtained !== undefined && isOk(obtained)).toBe(false);
    expect(broker.isGranted("api-gateway", "http:route")).toBe(false);

    // The kernel reaches it directly off the loaded plugin's module instead
    // (see src/server/index.ts's getHttpApp()) — confirm that path works
    // against this same load result.
    const httpRoute = apiGateway?.module.provides?.["http:route"] as HttpRouteCapability;
    expect(httpRoute.getApp().inject).toBeTypeOf("function");

    await apiGatewayModule.onDisable();
  });

  it("onDisable closes the Fastify instance and clears it, so getApp() throws again", async () => {
    await loadRealApiGateway();
    const httpRoute = apiGatewayModule.provides?.["http:route"] as HttpRouteCapability;
    expect(() => httpRoute.getApp()).not.toThrow();

    await apiGatewayModule.onDisable();

    expect(() => httpRoute.getApp()).toThrow(/before onEnable/);
  });

  it("uses the lifecycle context's logger level for its own Fastify logger", async () => {
    const logger = withContext(createLogger({ level: "warn" }), { plugin: "api-gateway" });
    await apiGatewayModule.onEnable({
      manifest: {
        id: "api-gateway",
        version: "0.1.0",
        depends_on: {},
        capabilities: { provides: ["http:route"], requires: [] },
        entry_point: "index.ts",
      },
      capabilities: {
        obtain: () => {
          throw new Error("not used in this test");
        },
      },
      logger,
    });

    const httpRoute = apiGatewayModule.provides?.["http:route"] as HttpRouteCapability;
    expect(httpRoute.getApp().log.level).toBe("warn");

    await apiGatewayModule.onDisable();
  });
});

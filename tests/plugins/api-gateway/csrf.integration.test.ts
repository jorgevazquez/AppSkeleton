/**
 * Integration test for feature #64 ("CSRF protection for state-changing
 * routes"): drives the *real* api-gateway plugin through the *real*
 * capability broker + loader (mirroring
 * `error-handling.integration.test.ts`'s pattern) — proving CSRF protection
 * is actually wired into `buildApp()` (`../../../src/plugins/api-gateway/index.ts`),
 * not just present in `csrf.ts`'s own unit tests against a hand-built
 * standalone instance. This is the feature's explicit step 3 requirement: "a
 * state-changing request without a valid CSRF token is rejected" — asserted
 * here against the real, fully-loaded plugin.
 */
import { describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isErr, isOk } from "../../../src/core/types.js";
import * as apiGatewayModule from "../../../src/plugins/api-gateway/index.js";
import type { HttpRouteCapability } from "../../../src/plugins/api-gateway/index.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../../src/plugins/api-gateway/src/csrf.js";

function manifest(
  id: string,
  options: { dependsOn?: Record<string, string>; provides?: string[]; requires?: string[] } = {},
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

/** Loads the real api-gateway plugin plus one fixture consumer plugin registering an ordinary (non-exempt) state-changing route and a `csrfExempt` one. */
async function loadWithFixtureRoutes() {
  const fixtureManifest = manifest("csrf-fixture", {
    dependsOn: { "api-gateway": "^1.0.0" },
    requires: ["http:route"],
  });

  const fixtureModule: PluginModule = {
    onEnable(context) {
      const obtained = context.capabilities.obtain<HttpRouteCapability>("http:route");
      if (isErr(obtained)) {
        throw obtained.error;
      }
      const { registerRoute } = obtained.value;

      registerRoute({
        method: "POST",
        path: "/widgets",
        schema: {
          body: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          response: { 201: { type: "object", properties: { name: { type: "string" } } } },
        },
        handler: async (request, reply) => {
          reply.status(201);
          return request.body as { name: string };
        },
      });

      registerRoute({
        method: "POST",
        path: "/webhooks/exempt",
        schema: {
          body: { type: "object" },
          response: {
            200: {
              type: "object",
              properties: { received: { type: "boolean" } },
              required: ["received"],
            },
          },
        },
        handler: async () => ({ received: true }),
        csrfExempt: {
          reason: "pure JSON webhook receiver behind strict CORS, HMAC-signed payload, no cookies",
        },
      });
    },
  };

  const definitions: PluginDefinition[] = [
    { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
    { manifest: fixtureManifest, module: fixtureModule },
  ];

  const broker = createCapabilityBroker();
  const loadResult = await loadPlugins(definitions, broker);
  expect(isOk(loadResult)).toBe(true);
  if (!isOk(loadResult)) {
    throw new Error("fixture plugin load unexpectedly failed");
  }
  expect(loadResult.value.failed).toEqual([]);

  return getHttpRoute().getApp();
}

describe("api-gateway — CSRF protection wired end-to-end through the real plugin (feature #64)", () => {
  it("rejects a state-changing request with no CSRF token at all (step 3's explicit requirement)", async () => {
    const app = await loadWithFixtureRoutes();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/widgets",
      payload: { name: "gadget" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      code: "CSRF_ERROR",
      message: "CSRF token missing or invalid.",
    });

    await apiGatewayModule.onDisable();
  });

  it("rejects a state-changing request whose header doesn't match its cookie", async () => {
    const app = await loadWithFixtureRoutes();

    const issued = await app.inject({ method: "GET", url: "/health" });
    const raw = issued.headers["set-cookie"];
    const headers = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
    const cookiePair = headers.find(
      (value) => typeof value === "string" && value.startsWith(`${CSRF_COOKIE_NAME}=`),
    ) as string;

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/widgets",
      headers: { cookie: cookiePair.split(";")[0] as string, [CSRF_HEADER_NAME]: "forged-token" },
      payload: { name: "gadget" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "CSRF_ERROR" });

    await apiGatewayModule.onDisable();
  });

  it("accepts a state-changing request presenting a valid double-submit token", async () => {
    const app = await loadWithFixtureRoutes();

    const issued = await app.inject({ method: "GET", url: "/health" });
    const raw = issued.headers["set-cookie"];
    const headers = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
    const cookiePair = (
      headers.find(
        (value) => typeof value === "string" && value.startsWith(`${CSRF_COOKIE_NAME}=`),
      ) as string
    ).split(";")[0] as string;
    const token = cookiePair.slice(`${CSRF_COOKIE_NAME}=`.length);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/widgets",
      headers: { cookie: cookiePair, [CSRF_HEADER_NAME]: token },
      payload: { name: "gadget" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ name: "gadget" });

    await apiGatewayModule.onDisable();
  });

  it("an explicitly-exempt route accepts a state-changing request with no CSRF token at all", async () => {
    const app = await loadWithFixtureRoutes();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/exempt",
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });

    await apiGatewayModule.onDisable();
  });
});

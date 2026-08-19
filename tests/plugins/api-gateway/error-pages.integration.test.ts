/**
 * End-to-end integration suite for feature #116 ("End-to-end wired 404/500
 * error pages through html-renderer and api-gateway") — drives the *real*
 * `api-gateway` plugin together with the *real* `html-renderer` plugin,
 * through the *real* capability broker + loader (`loadPlugins()`), mirroring
 * `gateway.integration.test.ts`'s and
 * `render-capability.integration.test.ts`'s own "real plugins, real broker"
 * pattern — proving `error-handler.ts`'s `html:error-pages` obtain actually
 * reaches html-renderer's `renderNotFoundPage`/`renderServerErrorPage`
 * (feature #55) end-to-end, not just via a hand-rolled fixture standing in
 * for either plugin.
 *
 * Covers this feature's three steps:
 *   1. an unmatched route renders the styled 404 page (instead of the bare
 *      JSON envelope) for a browser-like request, and a handler's own
 *      unexpected throw renders the styled 500 page the same way.
 *   2. the exact same failures still get the uniform JSON envelope
 *      (feature #61) for an API-style `Accept: application/json` request, or
 *      when no `Accept` header is sent at all (the pre-#116 default, proving
 *      this feature only ever *adds* an HTML option, never removes the JSON
 *      guarantee).
 *   3. this file itself is the "unknown route -> styled 404 for a
 *      browser-like request, JSON envelope for an API request" test feature
 *      #116's step 3 asks for.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { loadPlugins, type PluginDefinition } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isOk } from "../../../src/core/types.js";
import * as apiGatewayModule from "../../../src/plugins/api-gateway/index.js";
import type { ApiGatewayApp, HttpRouteCapability } from "../../../src/plugins/api-gateway/index.js";
import * as htmlRendererModule from "../../../src/plugins/html-renderer/index.js";

/** Mirrors gateway.integration.test.ts's own manifest() fixture helper. */
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

/**
 * Deliberately narrower than the real, shipped api-gateway/plugin.json (no
 * `rbac:check`) — this suite registers no `requiredPermission`-protected
 * route, so `rbac:check` is never obtained either way (see
 * `rbac-protection.ts`'s own lazy-obtain docs); narrowing here keeps this
 * fixture focused on exactly what feature #116 added, the same way
 * `render-capability.integration.test.ts`'s own html-renderer fixture
 * narrows around what feature #52 needed.
 */
const API_GATEWAY_MANIFEST = manifest("api-gateway", {
  provides: ["http:route"],
  requires: ["html:error-pages"],
});
const HTML_RENDERER_MANIFEST = manifest("html-renderer", {
  provides: ["render:template", "html:error-pages"],
});

/** A typical full-navigation browser Accept header — ranks text/html above the trailing wildcard fallback (see error-handler.ts's `prefersHtml` docs). */
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8";

function getHttpRoute(): HttpRouteCapability {
  return apiGatewayModule.provides?.["http:route"] as HttpRouteCapability;
}

/** Loads the real api-gateway + html-renderer plugins through the real broker/loader. */
async function loadGateway(): Promise<ApiGatewayApp> {
  const definitions: PluginDefinition[] = [
    { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
    { manifest: HTML_RENDERER_MANIFEST, module: htmlRendererModule },
  ];
  const broker = createCapabilityBroker();
  const loadResult = await loadPlugins(definitions, broker);
  expect(isOk(loadResult)).toBe(true);
  if (!isOk(loadResult)) {
    throw new Error("fixture plugin load unexpectedly failed");
  }
  expect(loadResult.value.failed).toEqual([]);
  expect(loadResult.value.loaded.map((plugin) => plugin.id).sort()).toEqual([
    "api-gateway",
    "html-renderer",
  ]);
  return getHttpRoute().getApp();
}

describe("api-gateway 404/500 pages — end-to-end wiring through html-renderer (feature #116)", () => {
  afterEach(async () => {
    await apiGatewayModule.onDisable();
  });

  describe("unmatched route (step 1 & 3)", () => {
    it("renders the styled 404 HTML page for a browser-like Accept header", async () => {
      const app = await loadGateway();

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/does-not-exist",
        headers: { accept: BROWSER_ACCEPT },
      });

      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("text/html");
      // Comes from the shared error-page layout (feature #48/#55), not
      // something a hand-written fallback string could produce.
      expect(res.payload).toContain("<!doctype html>");
      expect(res.payload).toContain("<title>404 Not Found</title>");
      expect(res.payload).toContain("404");
      // Never the JSON envelope's shape.
      expect(res.payload).not.toContain('"code"');
      expect(() => res.json()).toThrow();
    });

    it("returns the uniform JSON envelope for an API-style Accept: application/json request (step 2)", async () => {
      const app = await loadGateway();

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/does-not-exist",
        headers: { accept: "application/json" },
      });

      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      const body = res.json() as Record<string, unknown>;
      expect(body["code"]).toBe("NOT_FOUND");
      expect(typeof body["message"]).toBe("string");
      expect(res.payload).not.toContain("<html");
    });

    it("still returns the JSON envelope when no Accept header is sent at all, matching pre-#116 behavior exactly", async () => {
      const app = await loadGateway();

      const res = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });

      expect(res.statusCode).toBe(404);
      const body = res.json() as Record<string, unknown>;
      expect(body["code"]).toBe("NOT_FOUND");
    });
  });

  describe("an unexpected error from a route handler (step 1 & 2)", () => {
    function registerBoomRoute(): void {
      getHttpRoute().registerRoute({
        method: "GET",
        path: "/boom",
        schema: {
          querystring: { type: "object", properties: {}, additionalProperties: false },
          response: { 200: { type: "object" } },
        },
        handler: async () => {
          throw new Error("something exploded internally");
        },
      });
    }

    it("renders the styled 500 HTML page for a browser-like request, never the raw error message", async () => {
      const app = await loadGateway();
      registerBoomRoute();

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/boom",
        headers: { accept: BROWSER_ACCEPT },
      });

      expect(res.statusCode).toBe(500);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.payload).toContain("<!doctype html>");
      expect(res.payload).toContain("<title>500 Internal Server Error</title>");
      expect(res.payload).toContain("500");
      expect(res.payload).not.toContain("something exploded internally");
    });

    it("returns the uniform JSON envelope for the same failure when Accept prefers JSON", async () => {
      const app = await loadGateway();
      registerBoomRoute();

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/boom",
        headers: { accept: "application/json" },
      });

      expect(res.statusCode).toBe(500);
      const body = res.json() as Record<string, unknown>;
      expect(body["code"]).toBe("INTERNAL_ERROR");
      // The response `message` field itself is always the generic
      // fallback — never the raw internal message — regardless of
      // environment; see error-handler.ts's own docs and
      // error-handler.test.ts's "the response `message` itself is ALWAYS
      // the generic fallback" test for the full explanation of why `stack`
      // (not asserted on here) is a different, deliberate story outside
      // production.
      expect(body["message"]).toBe("An unexpected error occurred.");
      expect(res.payload).not.toContain("<html");
    });
  });
});

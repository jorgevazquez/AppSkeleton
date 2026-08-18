/**
 * Integration test for feature #69, step 3: "a fixture list route covering
 * default, custom page size, and out-of-range page requests" — driven
 * through the *real* capability broker, the *real* loader (`loadPlugins()`),
 * and the *real* `api-gateway` plugin module, exactly like
 * `route-capability.integration.test.ts`'s own fixture-plugin pattern
 * (feature #59, step 3), extended here with a fixture "widgets" list route
 * that uses this feature's own `parseListQueryParams`/
 * `applyListQueryModifiers` helpers (`../../../src/plugins/api-gateway/src/pagination.ts`)
 * against a plain in-memory array — proving the helpers work end-to-end for
 * a plugin author the same way `route-capability.integration.test.ts` proves
 * `registerRoute()` does, without requiring a real MySQL connection (the
 * in-memory array stands in for whatever a real plugin's own `db:query`-backed
 * store would return after `applyListQueryModifiers()` — see
 * `pagination.test.ts` for that half, against a real (unconnected) Kysely
 * instance).
 */
import { describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isErr, isOk } from "../../../src/core/types.js";
import * as apiGatewayModule from "../../../src/plugins/api-gateway/index.js";
import type { HttpRouteCapability } from "../../../src/plugins/api-gateway/index.js";
import { parseListQueryParams } from "../../../src/plugins/api-gateway/src/pagination.js";

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

/** The fixture "widgets" table this route lists — 5 rows, enough to exercise a second and an out-of-range page at limit=2. */
const WIDGETS = [
  { id: 1, name: "alpha" },
  { id: 2, name: "bravo" },
  { id: 3, name: "charlie" },
  { id: 4, name: "delta" },
  { id: 5, name: "echo" },
];

describe("fixture list route using pagination.ts's parseListQueryParams (feature #69, step 3)", () => {
  it("registers /widgets and answers default, custom-page-size, and out-of-range-page requests", async () => {
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
          path: "/widgets",
          schema: {
            querystring: {
              type: "object",
              properties: {
                page: { type: "string" },
                limit: { type: "string" },
              },
            },
            response: {
              200: {
                type: "object",
                properties: {
                  data: { type: "array" },
                  meta: {
                    type: "object",
                    properties: {
                      page: { type: "integer" },
                      limit: { type: "integer" },
                      total: { type: "integer" },
                      totalPages: { type: "integer" },
                    },
                    required: ["page", "limit", "total", "totalPages"],
                  },
                },
                required: ["data", "meta"],
              },
            },
          },
          handler: async (request) => {
            const parsed = parseListQueryParams(request.query as Record<string, unknown>, {
              defaultLimit: 20,
            });
            const data = WIDGETS.slice(parsed.offset, parsed.offset + parsed.limit);
            const total = WIDGETS.length;
            return {
              data,
              meta: {
                page: parsed.page,
                limit: parsed.limit,
                total,
                totalPages: Math.max(1, Math.ceil(total / parsed.limit)),
              },
            };
          },
        });
      },
    };

    const definitions: PluginDefinition[] = [
      { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
      { manifest: widgetsManifest, module: widgetsModule },
    ];

    const broker = createCapabilityBroker();
    const loadResult = await loadPlugins(definitions, broker);
    expect(isOk(loadResult)).toBe(true);
    if (!isOk(loadResult)) {
      return;
    }
    expect(loadResult.value.failed).toEqual([]);

    const app = getHttpRoute().getApp();

    // Default: no page/limit supplied — page 1, the configured default
    // limit (20), which is >= all 5 fixture rows, so every row comes back.
    const defaultRes = await app.inject({ method: "GET", url: "/api/v1/widgets" });
    expect(defaultRes.statusCode).toBe(200);
    expect(defaultRes.json()).toEqual({
      data: WIDGETS,
      meta: { page: 1, limit: 20, total: 5, totalPages: 1 },
    });

    // Custom page size: limit=2, page=2 -> rows at offset 2..3 (0-based: charlie, delta).
    const customRes = await app.inject({ method: "GET", url: "/api/v1/widgets?limit=2&page=2" });
    expect(customRes.statusCode).toBe(200);
    expect(customRes.json()).toEqual({
      data: [WIDGETS[2], WIDGETS[3]],
      meta: { page: 2, limit: 2, total: 5, totalPages: 3 },
    });

    // Out-of-range page: limit=2, page=10 -> well past the last page (3) of
    // real data. Still a perfectly valid, well-formed request (page=10 is
    // far under MAX_PAGE) — it 200s with an empty `data` array rather than
    // erroring, exactly like pagination.ts's own doc comment describes.
    const outOfRangeRes = await app.inject({
      method: "GET",
      url: "/api/v1/widgets?limit=2&page=10",
    });
    expect(outOfRangeRes.statusCode).toBe(200);
    expect(outOfRangeRes.json()).toEqual({
      data: [],
      meta: { page: 10, limit: 2, total: 5, totalPages: 3 },
    });

    await apiGatewayModule.onDisable();
  });

  it("rejects a limit above the sane upper bound with a validation error envelope, proving step 1's bound is enforced end-to-end", async () => {
    const strictManifest = manifest("widgets-strict-fixture", {
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
          path: "/widgets-strict",
          schema: {
            querystring: { type: "object" },
            response: { 200: { type: "object" } },
          },
          handler: async (request) => {
            const parsed = parseListQueryParams(request.query as Record<string, unknown>);
            return { data: WIDGETS.slice(parsed.offset, parsed.offset + parsed.limit) };
          },
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
    const res = await app.inject({ method: "GET", url: "/api/v1/widgets-strict?limit=99999" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });

    await apiGatewayModule.onDisable();
  });
});

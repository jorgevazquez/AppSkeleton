/**
 * Integration test for feature #65 ("RBAC middleware integration: per-route
 * required permission"), step 3: "an integration test for allowed,
 * unauthenticated, and forbidden cases on a protected fixture route" —
 * driven through the *real* capability broker, the *real* loader
 * (`loadPlugins()`), the *real* `api-gateway` plugin, and the *real* `rbac`
 * plugin (mirroring `route-capability.integration.test.ts`'s and
 * `csrf.integration.test.ts`'s own "real plugins, real broker" pattern) —
 * proving `registerRoute()`'s `requiredPermission` option is actually wired
 * into `buildApp()` end-to-end, not just present in
 * `rbac-protection.ts`'s/`route-capability.ts`'s own unit tests.
 *
 * `SESSION_SECRET` is only ever read lazily, inside the RBAC `preHandler`
 * hook, for a request that actually matches a protected route
 * (`rbac-protection.ts`'s own module docs) — so this suite sets it on
 * `process.env` for the duration of each test (mirroring
 * `error-handler.test.ts`'s identical save/restore pattern for `NODE_ENV`)
 * rather than threading a config override through the full boot path, which
 * `buildApp()` doesn't expose a seam for.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isErr, isOk } from "../../../src/core/types.js";
import * as apiGatewayModule from "../../../src/plugins/api-gateway/index.js";
import {
  issueSessionCookie,
  loadSessionConfig,
  type HttpRouteCapability,
} from "../../../src/plugins/api-gateway/index.js";
import * as rbacModule from "../../../src/plugins/rbac/index.js";
import { policyStore, resetPolicyStoreForTests } from "../../../src/plugins/rbac/index.js";

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

const API_GATEWAY_MANIFEST = manifest("api-gateway", {
  provides: ["http:route"],
  requires: ["rbac:check"],
});
const RBAC_MANIFEST = manifest("rbac", {
  dependsOn: { "api-gateway": "^1.0.0" },
  provides: ["rbac:check", "rbac:manage"],
  requires: ["http:route"],
});

function getHttpRoute(): HttpRouteCapability {
  return apiGatewayModule.provides?.["http:route"] as HttpRouteCapability;
}

/**
 * Find the `Set-Cookie` header whose name is `cookieName` among a
 * response's (possibly several — `/login` also gets a CSRF cookie issued
 * by api-gateway's own CSRF preHandler hook, feature #64, on every request
 * that doesn't already carry one) `Set-Cookie` headers. Unlike
 * `session.test.ts`'s/`csrf.integration.test.ts`'s own single-cookie
 * `firstSetCookie` helpers, this response always carries more than one, so
 * picking the first unconditionally would silently grab the wrong cookie.
 */
function findSetCookie(res: { headers: Record<string, unknown> }, cookieName: string): string {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  const match = headers.find(
    (value): value is string => typeof value === "string" && value.startsWith(`${cookieName}=`),
  );
  if (match === undefined) {
    throw new Error(`expected a Set-Cookie header named "${cookieName}" in the response`);
  }
  return match;
}

/**
 * Loads the real `api-gateway` + `rbac` plugins plus one fixture consumer
 * plugin registering:
 *   - `GET /login` — public (no `requiredPermission`), issues a session
 *     cookie and hands back the bare session id as `userId` so a test can
 *     seed `rbac`'s policy store for exactly that identity.
 *   - `GET /widgets` — protected by `requiredPermission: "widgets:read"`.
 */
async function loadWithProtectedFixtureRoute() {
  const fixtureManifest = manifest("rbac-fixture", {
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
        method: "GET",
        path: "/login",
        schema: {
          querystring: { type: "object" },
          response: {
            200: {
              type: "object",
              properties: { userId: { type: "string" } },
              required: ["userId"],
            },
          },
        },
        handler: async (_request, reply) => ({
          userId: issueSessionCookie(reply, loadSessionConfig()),
        }),
      });

      registerRoute({
        method: "GET",
        path: "/widgets",
        schema: {
          querystring: { type: "object" },
          response: {
            200: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          },
        },
        handler: async () => ({ ok: true }),
        requiredPermission: "widgets:read",
      });
    },
  };

  const definitions: PluginDefinition[] = [
    { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
    { manifest: RBAC_MANIFEST, module: rbacModule },
    { manifest: fixtureManifest, module: fixtureModule },
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
    "rbac",
    "rbac-fixture",
  ]);

  return getHttpRoute().getApp();
}

const SESSION_SECRET = "a-sufficiently-long-test-secret-for-rbac-protection-integration";

describe("api-gateway — RBAC per-route required permission wired end-to-end (feature #65)", () => {
  const previousSecret = process.env["SESSION_SECRET"];

  beforeEach(() => {
    process.env["SESSION_SECRET"] = SESSION_SECRET;
    resetPolicyStoreForTests();
  });

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env["SESSION_SECRET"];
    } else {
      process.env["SESSION_SECRET"] = previousSecret;
    }
    resetPolicyStoreForTests();
  });

  it("allowed: a request from a user whose role grants the required permission reaches the handler", async () => {
    const app = await loadWithProtectedFixtureRoute();

    const login = await app.inject({ method: "GET", url: "/api/v1/login" });
    expect(login.statusCode).toBe(200);
    const userId = (login.json() as { userId: string }).userId;
    const cookiePair = findSetCookie(login, "sid").split(";")[0] as string;

    policyStore.userRoles.push({ userId, roleId: "widget-reader" });
    policyStore.rolePermissions.push({ roleId: "widget-reader", permissionId: "widgets:read" });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/widgets",
      headers: { cookie: cookiePair },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    await apiGatewayModule.onDisable();
  });

  it("unauthenticated: a request with no session cookie at all is rejected with 401, never reaching the handler", async () => {
    const app = await loadWithProtectedFixtureRoute();

    const res = await app.inject({ method: "GET", url: "/api/v1/widgets" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Authentication is required to access this resource.",
    });

    await apiGatewayModule.onDisable();
  });

  it("unauthenticated: a tampered/forged session cookie is rejected with 401, exactly like no cookie at all", async () => {
    const app = await loadWithProtectedFixtureRoute();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/widgets",
      headers: { cookie: "sid=not-a-real-signed-session-value" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Authentication is required to access this resource.",
    });

    await apiGatewayModule.onDisable();
  });

  it("forbidden: an authenticated request whose user holds no matching role/permission is rejected with 403, never reaching the handler", async () => {
    const app = await loadWithProtectedFixtureRoute();

    const login = await app.inject({ method: "GET", url: "/api/v1/login" });
    const cookiePair = findSetCookie(login, "sid").split(";")[0] as string;
    // Deliberately no role/permission seeded for this user — policyStore was
    // reset to empty in beforeEach.

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/widgets",
      headers: { cookie: cookiePair },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      code: "FORBIDDEN",
      message: "You do not have permission to perform this action.",
    });

    await apiGatewayModule.onDisable();
  });

  it("forbidden: a user whose only role grants a different permission is still rejected with 403", async () => {
    const app = await loadWithProtectedFixtureRoute();

    const login = await app.inject({ method: "GET", url: "/api/v1/login" });
    const userId = (login.json() as { userId: string }).userId;
    const cookiePair = findSetCookie(login, "sid").split(";")[0] as string;

    policyStore.userRoles.push({ userId, roleId: "widget-writer" });
    policyStore.rolePermissions.push({ roleId: "widget-writer", permissionId: "widgets:write" });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/widgets",
      headers: { cookie: cookiePair },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" });

    await apiGatewayModule.onDisable();
  });

  it("the pre-existing, unprotected /health route is unaffected — no session required", async () => {
    const app = await loadWithProtectedFixtureRoute();

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    await apiGatewayModule.onDisable();
  });
});

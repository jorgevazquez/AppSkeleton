/**
 * Integration test suite for feature #44 ("RBAC admin HTTP routes
 * (list/create/update roles, assign/revoke permissions)"), step 3: "Write
 * an integration test hitting the routes as an admin (allowed) and as a
 * viewer (403 denied)".
 *
 * Drives the *real* `api-gateway` and `rbac` plugins through the *real*
 * capability broker + loader (`loadPlugins()`), mirroring
 * `tests/plugins/api-gateway/rbac-protection.integration.test.ts`'s and
 * `tests/plugins/wiki/http-routes.integration.test.ts`'s own "real plugins,
 * real broker, real `app.inject()` HTTP dispatch" pattern. No MySQL
 * involved: `rbac:manage`'s in-memory adapter (`../../../src/plugins/rbac/
 * index.ts`'s `createInMemoryManagementStore`) is all these routes read or
 * write, exactly like `manage-capability.test.ts`'s own wiring-level
 * coverage.
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
/** A tiny same-shape stand-in for `rbac-protection.integration.test.ts`'s own `/login` fixture — mints a session cookie for a caller identity this suite's tests then grant roles to. */
const LOGIN_FIXTURE_MANIFEST = manifest("login-fixture", {
  dependsOn: { "api-gateway": "^1.0.0" },
  requires: ["http:route"],
});

function getHttpRoute(): HttpRouteCapability {
  return apiGatewayModule.provides?.["http:route"] as HttpRouteCapability;
}

function loginFixtureModule(): PluginModule {
  return {
    onEnable(context) {
      const obtained = context.capabilities.obtain<HttpRouteCapability>("http:route");
      if (isErr(obtained)) {
        throw obtained.error;
      }
      obtained.value.registerRoute({
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
    },
  };
}

/** Find the `Set-Cookie` header whose name is `cookieName` among (possibly several) `Set-Cookie` headers. */
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

const SESSION_SECRET = "a-sufficiently-long-test-secret-for-rbac-http-routes-integration";

describe("rbac admin HTTP routes — end-to-end over real HTTP (feature #44)", () => {
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

  async function loadServer() {
    const definitions: PluginDefinition[] = [
      { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
      { manifest: RBAC_MANIFEST, module: rbacModule },
      { manifest: LOGIN_FIXTURE_MANIFEST, module: loginFixtureModule() },
    ];

    const broker = createCapabilityBroker();
    const loadResult = await loadPlugins(definitions, broker);
    expect(isOk(loadResult)).toBe(true);
    if (!isOk(loadResult)) {
      throw new Error("fixture plugin load unexpectedly failed");
    }
    expect(loadResult.value.failed).toEqual([]);
    expect(loadResult.value.loaded.map((plugin) => plugin.id).sort()).toEqual(
      ["api-gateway", "login-fixture", "rbac"].sort(),
    );

    return getHttpRoute().getApp();
  }

  /** Log in as a caller and, if `roleId` is given, assign it (already granted `rbac:manage` in `beforeEach`'s seeding, or left ungranted for a "viewer" probe). Returns the caller's `sid` cookie pair. */
  async function loginAs(
    app: Awaited<ReturnType<typeof loadServer>>,
    roleId?: string,
  ): Promise<{ userId: string; sidCookie: string }> {
    const login = await app.inject({ method: "GET", url: "/api/v1/login" });
    expect(login.statusCode).toBe(200);
    const userId = (login.json() as { userId: string }).userId;
    const sidCookie = findSetCookie(login, "sid").split(";")[0] as string;
    if (roleId !== undefined) {
      policyStore.userRoles.push({ userId, roleId });
    }
    return { userId, sidCookie };
  }

  /** Grant `roleId` the global `rbac:manage` permission — the exact permission `requiredPermission: "rbac:manage"` (api-gateway's own per-route gate, feature #65) and `./src/manage.ts`'s own self-referential `assertCanManage` both check. */
  function grantRbacManage(roleId: string): void {
    rbacModule.policyStore.rolePermissions.push({ roleId, permissionId: "rbac:manage" });
  }

  /** Obtain a `csrf_token` cookie (issued on any request lacking one) and the raw token value to present via the `x-csrf-token` header for a state-changing request. */
  async function obtainCsrf(
    app: Awaited<ReturnType<typeof loadServer>>,
    sidCookie: string,
  ): Promise<{ cookie: string; token: string }> {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/rbac/roles",
      headers: { cookie: sidCookie },
    });
    const csrfCookiePair = findSetCookie(res, "csrf_token").split(";")[0] as string;
    const token = csrfCookiePair.slice("csrf_token=".length);
    return { cookie: `${sidCookie}; ${csrfCookiePair}`, token };
  }

  it("admin: can list, create, update roles, and assign/revoke a permission end-to-end", async () => {
    const app = await loadServer();
    grantRbacManage("rbac-admin");
    const { sidCookie } = await loginAs(app, "rbac-admin");
    const { cookie, token } = await obtainCsrf(app, sidCookie);
    rbacModule.permissionCatalog.set("wiki:edit", {
      id: "wiki:edit",
      resource: "wiki",
      action: "edit",
    });

    const initialList = await app.inject({
      method: "GET",
      url: "/api/v1/rbac/roles",
      headers: { cookie: sidCookie },
    });
    expect(initialList.statusCode).toBe(200);
    expect(initialList.json()).toMatchObject({ roles: expect.any(Array) });

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/rbac/roles",
      headers: { cookie, "x-csrf-token": token },
      payload: { id: "wiki-editor", name: "Wiki Editor", description: "Can edit wiki pages" },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toEqual({
      id: "wiki-editor",
      name: "Wiki Editor",
      description: "Can edit wiki pages",
    });

    const listAfterCreate = await app.inject({
      method: "GET",
      url: "/api/v1/rbac/roles",
      headers: { cookie: sidCookie },
    });
    const { roles } = listAfterCreate.json() as { roles: { id: string }[] };
    expect(roles.map((role) => role.id)).toContain("wiki-editor");

    const update = await app.inject({
      method: "PATCH",
      url: "/api/v1/rbac/roles/wiki-editor",
      headers: { cookie, "x-csrf-token": token },
      payload: { name: "Senior Wiki Editor" },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toEqual({
      id: "wiki-editor",
      name: "Senior Wiki Editor",
      description: "Can edit wiki pages",
    });

    const assign = await app.inject({
      method: "POST",
      url: "/api/v1/rbac/roles/wiki-editor/permissions",
      headers: { cookie, "x-csrf-token": token },
      payload: { permissionId: "wiki:edit" },
    });
    expect(assign.statusCode).toBe(201);
    expect(assign.json()).toEqual({
      roleId: "wiki-editor",
      permissionId: "wiki:edit",
      assigned: true,
    });
    expect(
      rbacModule.policyStore.rolePermissions.some(
        (grant) => grant.roleId === "wiki-editor" && grant.permissionId === "wiki:edit",
      ),
    ).toBe(true);

    const revoke = await app.inject({
      method: "DELETE",
      url: "/api/v1/rbac/roles/wiki-editor/permissions/wiki:edit",
      headers: { cookie, "x-csrf-token": token },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({
      roleId: "wiki-editor",
      permissionId: "wiki:edit",
      revoked: true,
    });
    expect(
      rbacModule.policyStore.rolePermissions.some(
        (grant) => grant.roleId === "wiki-editor" && grant.permissionId === "wiki:edit",
      ),
    ).toBe(false);

    await apiGatewayModule.onDisable();
  });

  it("viewer: every route is rejected with 403 — never reaching rbac:manage", async () => {
    const app = await loadServer();
    // A "viewer" role that holds no rbac:manage grant at all — deliberately
    // not seeded with the permission, unlike the admin case above.
    const { sidCookie } = await loginAs(app, "viewer");
    const { cookie, token } = await obtainCsrf(app, sidCookie);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/rbac/roles",
      headers: { cookie: sidCookie },
    });
    expect(list.statusCode).toBe(403);
    expect(list.json()).toMatchObject({ code: "FORBIDDEN" });

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/rbac/roles",
      headers: { cookie, "x-csrf-token": token },
      payload: { id: "wiki-editor", name: "Wiki Editor" },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json()).toMatchObject({ code: "FORBIDDEN" });

    const update = await app.inject({
      method: "PATCH",
      url: "/api/v1/rbac/roles/wiki-editor",
      headers: { cookie, "x-csrf-token": token },
      payload: { name: "Nope" },
    });
    expect(update.statusCode).toBe(403);
    expect(update.json()).toMatchObject({ code: "FORBIDDEN" });

    const assign = await app.inject({
      method: "POST",
      url: "/api/v1/rbac/roles/wiki-editor/permissions",
      headers: { cookie, "x-csrf-token": token },
      payload: { permissionId: "wiki:edit" },
    });
    expect(assign.statusCode).toBe(403);
    expect(assign.json()).toMatchObject({ code: "FORBIDDEN" });

    const revoke = await app.inject({
      method: "DELETE",
      url: "/api/v1/rbac/roles/wiki-editor/permissions/wiki:edit",
      headers: { cookie, "x-csrf-token": token },
    });
    expect(revoke.statusCode).toBe(403);
    expect(revoke.json()).toMatchObject({ code: "FORBIDDEN" });

    await apiGatewayModule.onDisable();
  });

  it("unauthenticated: an anonymous request is rejected with 401, never reaching the handler", async () => {
    const app = await loadServer();

    const res = await app.inject({ method: "GET", url: "/api/v1/rbac/roles" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "UNAUTHENTICATED" });

    await apiGatewayModule.onDisable();
  });

  it("create: a state-changing request with no CSRF token is rejected with 403 (feature #64 still applies to rbac admin routes)", async () => {
    const app = await loadServer();
    grantRbacManage("rbac-admin");
    const { sidCookie } = await loginAs(app, "rbac-admin");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rbac/roles",
      headers: { cookie: sidCookie },
      payload: { id: "no-csrf-role", name: "No CSRF" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "CSRF_ERROR" });

    await apiGatewayModule.onDisable();
  });

  it("create: an admin request missing a required field is rejected with 400 (step 2 — request schema validation)", async () => {
    const app = await loadServer();
    grantRbacManage("rbac-admin");
    const { sidCookie } = await loginAs(app, "rbac-admin");
    const { cookie, token } = await obtainCsrf(app, sidCookie);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rbac/roles",
      headers: { cookie, "x-csrf-token": token },
      payload: { id: "missing-name-role" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });

    await apiGatewayModule.onDisable();
  });

  it("every rbac admin route is reachable only under /api/v1 (feature #62 — API versioning)", async () => {
    const app = await loadServer();
    grantRbacManage("rbac-admin");
    const { sidCookie } = await loginAs(app, "rbac-admin");

    const versioned = await app.inject({
      method: "GET",
      url: "/api/v1/rbac/roles",
      headers: { cookie: sidCookie },
    });
    const unversioned = await app.inject({
      method: "GET",
      url: "/rbac/roles",
      headers: { cookie: sidCookie },
    });

    expect(versioned.statusCode).toBe(200);
    expect(unversioned.statusCode).toBe(404);

    await apiGatewayModule.onDisable();
  });
});

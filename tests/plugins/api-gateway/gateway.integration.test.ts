/**
 * End-to-end integration suite for feature #72 ("api-gateway integration
 * test suite (routing, validation, RBAC gating, rate limiting, CSRF, error
 * envelope)"): drives the *real* api-gateway plugin, through the *real*
 * capability broker + loader (`loadPlugins()`), together with the *real*
 * `rbac` plugin — mirroring `rbac-protection.integration.test.ts`'s,
 * `csrf.integration.test.ts`'s, and `error-handling.integration.test.ts`'s
 * own "real plugins, real broker" pattern — but as one cohesive fixture (a
 * tiny "todos" API) rather than one concern per file, so this feature's six
 * pillars are proven to compose correctly with each other on the *same*
 * live, loader-constructed gateway instance, not only in isolation the way
 * each of those single-concern integration suites already does:
 *
 *   1. routing        — fixture routes are reachable under the versioned
 *                        `/api/v1` prefix, alongside the built-in `/health`
 *                        route, and an unmatched route still gets the
 *                        uniform envelope.
 *   2. validation      — a request that violates a route's declared JSON
 *                        schema is rejected with the uniform envelope,
 *                        never reaching the handler; a handler's own
 *                        domain-level "not found" also goes through the
 *                        same envelope machinery.
 *   3. RBAC gating     — `requiredPermission` is enforced end-to-end:
 *                        unauthenticated (401), forbidden (403), allowed
 *                        (2xx).
 *   4. rate limiting   — a route's per-route `rateLimit` override is
 *                        enforced by the *real*, loader-constructed
 *                        instance (unlike `rate-limit.test.ts`, which only
 *                        ever drives a hand-built standalone Fastify app),
 *                        alongside the global default.
 *   5. CSRF            — a state-changing route rejects a request with no
 *                        (or a mismatched) double-submit token, and accepts
 *                        a valid one.
 *   6. error envelope  — every failure mode above collapses to the same
 *                        `{code, message[, details]}` shape, never
 *                        Fastify's own default `{statusCode, error,
 *                        message}` body.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { NotFoundError } from "../../../src/core/errors.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isErr, isOk } from "../../../src/core/types.js";
import * as apiGatewayModule from "../../../src/plugins/api-gateway/index.js";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  issueSessionCookie,
  loadSessionConfig,
  type ApiGatewayApp,
  type HttpRouteCapability,
} from "../../../src/plugins/api-gateway/index.js";
import * as rbacModule from "../../../src/plugins/rbac/index.js";
import { policyStore, resetPolicyStoreForTests } from "../../../src/plugins/rbac/index.js";

/** Mirrors route-capability.integration.test.ts's own manifest() fixture helper. */
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

interface Todo {
  readonly id: number;
  readonly title: string;
}

/**
 * Loads the real `api-gateway` + `rbac` plugins plus one fixture "todos"
 * API exercising every pillar this suite tests:
 *   - `GET /login` — public, issues a session cookie, hands back the bare
 *     session id (mirrors `rbac-protection.integration.test.ts`'s own
 *     fixture route).
 *   - `GET /todos` — public, lists every stored todo.
 *   - `GET /todos/:id` — public; validates `:id` is an integer (validation
 *     pillar) and throws {@link NotFoundError} for an unknown id (error
 *     envelope pillar).
 *   - `POST /todos` — protected by `requiredPermission: "todos:write"`
 *     (RBAC pillar), state-changing so CSRF-protected by default (CSRF
 *     pillar), and schema-validates its body (validation pillar).
 *   - `DELETE /todos/:id` — protected by `requiredPermission:
 *     "todos:delete"`, CSRF-protected, and carries a strict per-route
 *     `rateLimit` override (rate-limiting pillar).
 *
 * Each call gets a fresh in-memory todo store and a fresh Fastify instance
 * (rate-limit counters included), so tests never bleed into each other.
 */
async function loadTodosFixture() {
  const todos = new Map<number, Todo>();
  let nextId = 1;

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
        path: "/todos",
        schema: {
          querystring: { type: "object" },
          response: {
            200: {
              type: "object",
              properties: { todos: { type: "array" } },
              required: ["todos"],
            },
          },
        },
        handler: async () => ({ todos: Array.from(todos.values()) }),
      });

      registerRoute({
        method: "GET",
        path: "/todos/:id",
        schema: {
          params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
          response: {
            200: {
              type: "object",
              properties: { id: { type: "integer" }, title: { type: "string" } },
              required: ["id", "title"],
            },
          },
        },
        handler: async (request) => {
          const { id } = request.params as { id: number };
          const todo = todos.get(id);
          if (!todo) {
            const message = `Todo ${id} does not exist.`;
            throw new NotFoundError(message, { publicMessage: message, details: { id } });
          }
          return todo;
        },
      });

      registerRoute({
        method: "POST",
        path: "/todos",
        schema: {
          body: {
            type: "object",
            properties: { title: { type: "string", minLength: 1 } },
            required: ["title"],
          },
          response: {
            201: {
              type: "object",
              properties: { id: { type: "integer" }, title: { type: "string" } },
              required: ["id", "title"],
            },
          },
        },
        handler: async (request, reply) => {
          const { title } = request.body as { title: string };
          const todo: Todo = { id: nextId++, title };
          todos.set(todo.id, todo);
          reply.status(201);
          return todo;
        },
        requiredPermission: "todos:write",
      });

      registerRoute({
        method: "DELETE",
        path: "/todos/:id",
        schema: {
          params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
          response: {
            200: {
              type: "object",
              properties: { deleted: { type: "boolean" } },
              required: ["deleted"],
            },
          },
        },
        handler: async (request) => {
          const { id } = request.params as { id: number };
          todos.delete(id);
          return { deleted: true };
        },
        requiredPermission: "todos:delete",
        // Strict per-route override (feature #66) — deliberately stricter
        // than the global default so this suite proves it's actually
        // enforced by the real, loader-constructed instance, not just a
        // hand-built standalone one (see rate-limit.test.ts).
        rateLimit: { max: 1, timeWindow: 60_000 },
      });
    },
  };

  const fixtureManifest = manifest("todos-fixture", {
    dependsOn: { "api-gateway": "^1.0.0", rbac: "^1.0.0" },
    requires: ["http:route"],
  });

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
    "todos-fixture",
  ]);

  return getHttpRoute().getApp();
}

/**
 * Find the `Set-Cookie` header whose name is `cookieName` among a
 * response's (possibly several) `Set-Cookie` headers — mirrors
 * `rbac-protection.integration.test.ts`'s own helper of the same name.
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

/** Logs in against the fixture's `/login` route, returning the session id (for seeding rbac's policy store) and the `sid` cookie pair to send back. */
async function login(app: ApiGatewayApp): Promise<{ userId: string; cookie: string }> {
  const res = await app.inject({ method: "GET", url: "/api/v1/login" });
  const userId = (res.json() as { userId: string }).userId;
  const cookie = findSetCookie(res, "sid").split(";")[0] as string;
  return { userId, cookie };
}

/** Fetches a fresh double-submit CSRF cookie/token pair off any GET response — mirrors `error-handling.integration.test.ts`'s own `fetchCsrfToken` helper. */
async function fetchCsrfToken(app: ApiGatewayApp): Promise<{ cookie: string; token: string }> {
  const res = await app.inject({ method: "GET", url: "/health" });
  const cookie = findSetCookie(res, CSRF_COOKIE_NAME).split(";")[0] as string;
  const token = cookie.slice(`${CSRF_COOKIE_NAME}=`.length);
  return { cookie, token };
}

/** Seeds rbac's policy store so `userId` holds `permissionId` via a fresh single-permission role. */
function grant(userId: string, roleId: string, permissionId: string): void {
  policyStore.userRoles.push({ userId, roleId });
  policyStore.rolePermissions.push({ roleId, permissionId });
}

const SESSION_SECRET = "a-sufficiently-long-test-secret-for-gateway-integration-suite";

describe("api-gateway — end-to-end integration across routing, validation, RBAC, rate limiting, CSRF, and the error envelope (feature #72)", () => {
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

  describe("routing", () => {
    it("every fixture route is reachable under the versioned /api/v1 prefix, alongside the built-in /health route", async () => {
      const app = await loadTodosFixture();

      const list = await app.inject({ method: "GET", url: "/api/v1/todos" });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({ todos: [] });

      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: "ok" });

      // The unversioned path is never reachable — feature #62's policy.
      const unversioned = await app.inject({ method: "GET", url: "/todos" });
      expect(unversioned.statusCode).toBe(404);

      await apiGatewayModule.onDisable();
    });

    it("an unmatched route gets the uniform 404 envelope instead of Fastify's default not-found body", async () => {
      const app = await loadTodosFixture();

      const res = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });

      expect(res.statusCode).toBe(404);
      const body = res.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["code", "message"]);
      expect(body["code"]).toBe("NOT_FOUND");

      await apiGatewayModule.onDisable();
    });
  });

  describe("validation", () => {
    it("creating a todo with no title is rejected 400 VALIDATION_ERROR, never reaching the handler", async () => {
      const app = await loadTodosFixture();
      const { userId, cookie: sidCookie } = await login(app);
      grant(userId, "todo-writer", "todos:write");
      const { cookie: csrfCookie, token } = await fetchCsrfToken(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/todos",
        headers: { cookie: `${sidCookie}; ${csrfCookie}`, [CSRF_HEADER_NAME]: token },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = res.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["code", "details", "message"]);
      expect(body["code"]).toBe("VALIDATION_ERROR");

      // Never reached the handler — nothing was stored.
      const list = await app.inject({ method: "GET", url: "/api/v1/todos" });
      expect(list.json()).toEqual({ todos: [] });

      await apiGatewayModule.onDisable();
    });

    it("fetching a todo by a non-integer id is rejected 400, never reaching the handler", async () => {
      const app = await loadTodosFixture();

      const res = await app.inject({ method: "GET", url: "/api/v1/todos/not-a-number" });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });

      await apiGatewayModule.onDisable();
    });

    it("fetching a todo id that doesn't exist surfaces the handler's own NotFoundError through the uniform envelope", async () => {
      const app = await loadTodosFixture();

      const res = await app.inject({ method: "GET", url: "/api/v1/todos/999" });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        code: "NOT_FOUND",
        message: "Todo 999 does not exist.",
        details: { id: 999 },
      });

      await apiGatewayModule.onDisable();
    });
  });

  describe("RBAC gating", () => {
    it("unauthenticated: creating a todo with no session at all is rejected 401, never reaching the handler", async () => {
      const app = await loadTodosFixture();
      const { cookie, token } = await fetchCsrfToken(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/todos",
        headers: { cookie, [CSRF_HEADER_NAME]: token },
        payload: { title: "milk" },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        code: "UNAUTHENTICATED",
        message: "Authentication is required to access this resource.",
      });

      const list = await app.inject({ method: "GET", url: "/api/v1/todos" });
      expect(list.json()).toEqual({ todos: [] });

      await apiGatewayModule.onDisable();
    });

    it("forbidden: an authenticated user with no matching permission is rejected 403, never reaching the handler", async () => {
      const app = await loadTodosFixture();
      const { cookie: sidCookie } = await login(app);
      // Deliberately no role/permission seeded — policyStore was reset to
      // empty in beforeEach.
      const { cookie: csrfCookie, token } = await fetchCsrfToken(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/todos",
        headers: { cookie: `${sidCookie}; ${csrfCookie}`, [CSRF_HEADER_NAME]: token },
        payload: { title: "milk" },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        code: "FORBIDDEN",
        message: "You do not have permission to perform this action.",
      });

      await apiGatewayModule.onDisable();
    });

    it("allowed: an authenticated user whose role grants the required permission reaches the handler", async () => {
      const app = await loadTodosFixture();
      const { userId, cookie: sidCookie } = await login(app);
      grant(userId, "todo-writer", "todos:write");
      const { cookie: csrfCookie, token } = await fetchCsrfToken(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/todos",
        headers: { cookie: `${sidCookie}; ${csrfCookie}`, [CSRF_HEADER_NAME]: token },
        payload: { title: "milk" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ id: 1, title: "milk" });

      const list = await app.inject({ method: "GET", url: "/api/v1/todos" });
      expect(list.json()).toEqual({ todos: [{ id: 1, title: "milk" }] });

      await apiGatewayModule.onDisable();
    });
  });

  describe("CSRF", () => {
    it("creating a todo with no CSRF token at all is rejected 403, even for an otherwise-authorized user", async () => {
      const app = await loadTodosFixture();
      const { userId, cookie } = await login(app);
      grant(userId, "todo-writer", "todos:write");

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/todos",
        headers: { cookie },
        payload: { title: "milk" },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        code: "CSRF_ERROR",
        message: "CSRF token missing or invalid.",
      });

      await apiGatewayModule.onDisable();
    });

    it("a header that doesn't match the CSRF cookie is rejected 403 too, even for an otherwise-authorized user", async () => {
      const app = await loadTodosFixture();
      const { userId, cookie: sidCookie } = await login(app);
      grant(userId, "todo-writer", "todos:write");
      const { cookie: csrfCookie } = await fetchCsrfToken(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/todos",
        headers: { cookie: `${sidCookie}; ${csrfCookie}`, [CSRF_HEADER_NAME]: "forged-token" },
        payload: { title: "milk" },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "CSRF_ERROR" });

      await apiGatewayModule.onDisable();
    });

    it("a valid double-submit token lets an otherwise-authorized, otherwise-valid request through", async () => {
      const app = await loadTodosFixture();
      const { userId, cookie: sidCookie } = await login(app);
      grant(userId, "todo-writer", "todos:write");
      const { cookie: csrfCookie, token } = await fetchCsrfToken(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/todos",
        headers: { cookie: `${sidCookie}; ${csrfCookie}`, [CSRF_HEADER_NAME]: token },
        payload: { title: "bread" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ id: 1, title: "bread" });

      await apiGatewayModule.onDisable();
    });
  });

  describe("rate limiting", () => {
    it("a route's per-route rateLimit override is enforced by the real, loader-constructed instance, with the uniform 429 envelope and a Retry-After header", async () => {
      const app = await loadTodosFixture();
      const { userId, cookie: sidCookie } = await login(app);
      grant(userId, "todo-deleter", "todos:delete");
      const { cookie: csrfCookie, token } = await fetchCsrfToken(app);
      const headers = { cookie: `${sidCookie}; ${csrfCookie}`, [CSRF_HEADER_NAME]: token };

      const first = await app.inject({ method: "DELETE", url: "/api/v1/todos/1", headers });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ deleted: true });

      const second = await app.inject({ method: "DELETE", url: "/api/v1/todos/1", headers });
      expect(second.statusCode).toBe(429);
      expect(second.json()).toMatchObject({
        code: "RATE_LIMIT_EXCEEDED",
        message: expect.any(String),
      });
      expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);

      await apiGatewayModule.onDisable();
    });

    it("the global rate-limit default still applies to a route with no per-route override, independent of the stricter DELETE override above", async () => {
      const previousMax = process.env["RATE_LIMIT_MAX"];
      const previousWindow = process.env["RATE_LIMIT_WINDOW_MS"];
      process.env["RATE_LIMIT_MAX"] = "1";
      process.env["RATE_LIMIT_WINDOW_MS"] = "60000";

      try {
        const app = await loadTodosFixture();

        const first = await app.inject({ method: "GET", url: "/api/v1/todos" });
        expect(first.statusCode).toBe(200);

        const second = await app.inject({ method: "GET", url: "/api/v1/todos" });
        expect(second.statusCode).toBe(429);
        expect(second.json()).toMatchObject({ code: "RATE_LIMIT_EXCEEDED" });

        await apiGatewayModule.onDisable();
      } finally {
        if (previousMax === undefined) {
          delete process.env["RATE_LIMIT_MAX"];
        } else {
          process.env["RATE_LIMIT_MAX"] = previousMax;
        }
        if (previousWindow === undefined) {
          delete process.env["RATE_LIMIT_WINDOW_MS"];
        } else {
          process.env["RATE_LIMIT_WINDOW_MS"] = previousWindow;
        }
      }
    });
  });

  describe("error envelope uniformity", () => {
    it("every failure mode above collapses to the same {code, message[, details]} shape, never Fastify's default {statusCode, error, message} body", async () => {
      const app = await loadTodosFixture();

      const notFoundRoute = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
      const badParam = await app.inject({ method: "GET", url: "/api/v1/todos/not-a-number" });
      const missingTodo = await app.inject({ method: "GET", url: "/api/v1/todos/999" });
      const rejectedWrite = await app.inject({
        method: "POST",
        url: "/api/v1/todos",
        payload: { title: "x" },
      });

      for (const res of [notFoundRoute, badParam, missingTodo, rejectedWrite]) {
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        const body = res.json() as Record<string, unknown>;
        expect(typeof body["code"]).toBe("string");
        expect(typeof body["message"]).toBe("string");
        expect(body).not.toHaveProperty("statusCode");
        expect(body).not.toHaveProperty("error");
      }

      await apiGatewayModule.onDisable();
    });
  });
});

/**
 * Integration test for feature #60 ("Request validation and a consistent
 * 4xx error envelope"): drives the *real* api-gateway plugin through the
 * *real* capability broker + loader (mirroring
 * `route-capability.integration.test.ts`'s pattern), then posts genuinely
 * invalid HTTP requests at it and asserts the exact `{code, message,
 * details}` envelope shape every failure mode collapses to — Fastify's own
 * ajv schema-validation rejection (step 1/2), an AppError a handler throws,
 * malformed request bodies Fastify itself rejects before a handler ever
 * runs, and an unmatched route.
 */
import { describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { CapabilityDeniedError } from "../../../src/core/errors.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isErr, isOk } from "../../../src/core/types.js";
import * as apiGatewayModule from "../../../src/plugins/api-gateway/index.js";
import type { HttpRouteCapability } from "../../../src/plugins/api-gateway/index.js";

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

/** Loads the real api-gateway plugin plus one fixture consumer plugin that registers routes exercising every failure mode this test asserts on. */
async function loadWithFixtureRoutes() {
  const fixtureManifest = manifest("error-envelope-fixture", {
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
          body: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
          response: {
            201: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        },
        handler: async (request, reply) => {
          reply.status(201);
          return request.body as { name: string };
        },
      });

      registerRoute({
        method: "GET",
        path: "/secret",
        schema: {
          querystring: { type: "object" },
          response: {
            200: { type: "object" },
          },
        },
        handler: async () => {
          throw new CapabilityDeniedError(
            "plugin 'error-envelope-fixture' requested a capability it lacks",
            {
              details: { capability: "secret:read" },
            },
          );
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

/**
 * These `/widgets` POST requests exercise feature #60's error envelope, not
 * feature #64's CSRF protection — but since feature #64, every
 * state-changing route on the real api-gateway app requires a valid
 * double-submit-cookie CSRF token by default (see
 * `../../../src/plugins/api-gateway/src/csrf.ts`), `/widgets` included.
 * This fetches a real token the same way a legitimate same-origin client
 * would (a GET request first, then echoing the issued cookie back as the
 * `x-csrf-token` header) so these tests keep exercising the envelope shape
 * itself, not incidentally tripping over CSRF. See `csrf.test.ts` for the
 * dedicated CSRF coverage, including the "no token at all" rejection case
 * this helper deliberately avoids.
 */
async function fetchCsrfToken(app: Awaited<ReturnType<typeof loadWithFixtureRoutes>>): Promise<{
  readonly cookie: string;
  readonly token: string;
}> {
  const res = await app.inject({ method: "GET", url: "/health" });
  const raw = res.headers["set-cookie"];
  const header = (Array.isArray(raw) ? raw : [raw]).find(
    (value): value is string => typeof value === "string" && value.startsWith("csrf_token="),
  );
  if (!header) {
    throw new Error("expected a csrf_token Set-Cookie header in the response");
  }
  const cookie = header.split(";")[0] as string;
  const token = cookie.slice("csrf_token=".length);
  return { cookie, token };
}

describe("api-gateway — uniform 4xx/5xx error envelope (feature #60)", () => {
  it("a request that fails Fastify's own schema validation gets the exact {code, message, details} envelope, not Fastify's default shape", async () => {
    const app = await loadWithFixtureRoutes();
    const { cookie, token } = await fetchCsrfToken(app);

    // Missing the required "name" field — fails the declared body schema.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/widgets",
      headers: { cookie, "x-csrf-token": token },
      payload: {},
    });

    expect(res.statusCode).toBe(400);

    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["code", "details", "message"]);
    expect(body["code"]).toBe("VALIDATION_ERROR");
    expect(typeof body["message"]).toBe("string");
    expect((body["message"] as string).length).toBeGreaterThan(0);

    // Fastify's own default error shape (`statusCode`/`error` keys) must be
    // gone entirely — this is the whole point of the uniform envelope.
    expect(body).not.toHaveProperty("statusCode");
    expect(body).not.toHaveProperty("error");

    const details = body["details"] as Record<string, unknown>;
    expect(Array.isArray(details["validation"])).toBe(true);
    expect((details["validation"] as unknown[]).length).toBeGreaterThan(0);

    await apiGatewayModule.onDisable();
  });

  it("a wrong-type field violation is also rejected through the same uniform envelope", async () => {
    const app = await loadWithFixtureRoutes();
    const { cookie, token } = await fetchCsrfToken(app);

    // "name" declared as a string; sending a nested object can't be
    // coerced to a string (unlike a bare number, which ajv's default
    // coerceTypes would happily stringify), so this genuinely fails the
    // declared body schema.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/widgets",
      headers: { cookie, "x-csrf-token": token },
      payload: { name: { nested: true } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });

    await apiGatewayModule.onDisable();
  });

  it("a valid request still passes straight through untouched by the error handler", async () => {
    const app = await loadWithFixtureRoutes();
    const { cookie, token } = await fetchCsrfToken(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/widgets",
      headers: { cookie, "x-csrf-token": token },
      payload: { name: "gadget" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ name: "gadget" });

    await apiGatewayModule.onDisable();
  });

  it("an AppError a route handler throws (e.g. CapabilityDeniedError) is serialized via its own toJSON(), with the matching status code", async () => {
    const app = await loadWithFixtureRoutes();

    const res = await app.inject({ method: "GET", url: "/api/v1/secret" });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      code: "CAPABILITY_DENIED",
      message: "You do not have permission to perform this action.",
      details: { capability: "secret:read" },
    });

    await apiGatewayModule.onDisable();
  });

  it("an unmatched route (404) gets the same uniform envelope instead of Fastify's default not-found body", async () => {
    const app = await loadWithFixtureRoutes();

    const res = await app.inject({ method: "GET", url: "/this-route-does-not-exist" });

    expect(res.statusCode).toBe(404);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["code", "message"]);
    expect(body["code"]).toBe("NOT_FOUND");
    expect(body["message"]).toContain("GET /this-route-does-not-exist");

    await apiGatewayModule.onDisable();
  });

  it("a malformed JSON request body (rejected by Fastify before any handler runs) still gets a {code, message} envelope, not Fastify's default", async () => {
    const app = await loadWithFixtureRoutes();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/widgets",
      headers: { "content-type": "application/json" },
      payload: "{ this is not valid json",
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["code", "message"]);
    expect(typeof body["code"]).toBe("string");
    expect(typeof body["message"]).toBe("string");
    expect(body).not.toHaveProperty("statusCode");
    expect(body).not.toHaveProperty("error");

    await apiGatewayModule.onDisable();
  });
});

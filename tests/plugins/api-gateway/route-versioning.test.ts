/**
 * Unit tests for feature #62 ("API versioning convention (/api/v1/...)"),
 * step 3: "a registered route is reachable at the versioned path" — plus
 * coverage for the two other steps' behavior (default-to-v1 prefixing and
 * an explicit, non-default version segment), driven directly against
 * `createRouteRegistrar()` the same way `route-capability.test.ts` does.
 */
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { ValidationError } from "../../../src/core/errors.js";
import {
  createRouteRegistrar,
  DEFAULT_API_VERSION,
} from "../../../src/plugins/api-gateway/src/route-capability.js";
import type {
  ApiGatewayApp,
  RegisterRouteOptions,
} from "../../../src/plugins/api-gateway/index.js";

const RESPONSE_SCHEMA = {
  200: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
} as const;

function baseOptions(overrides: Partial<RegisterRouteOptions> = {}): RegisterRouteOptions {
  return {
    method: "GET",
    path: "/widgets",
    schema: {
      querystring: { type: "object", properties: {}, additionalProperties: false },
      response: RESPONSE_SCHEMA,
    },
    handler: async () => ({ message: "ok" }),
    ...overrides,
  };
}

describe("registerRoute — API versioning convention (feature #62)", () => {
  it("defaults to v1: a route registered with path \"/widgets\" is reachable at /api/v1/widgets", async () => {
    const app = Fastify() as unknown as ApiGatewayApp;
    const { registerRoute } = createRouteRegistrar(() => app);

    registerRoute(baseOptions());

    const res = await app.inject({ method: "GET", url: "/api/v1/widgets" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: "ok" });

    await app.close();
  });

  it("does not also mount the route at the bare, unversioned path", async () => {
    const app = Fastify() as unknown as ApiGatewayApp;
    const { registerRoute } = createRouteRegistrar(() => app);

    registerRoute(baseOptions());

    const res = await app.inject({ method: "GET", url: "/widgets" });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it("DEFAULT_API_VERSION is \"v1\", matching the default prefix actually applied", () => {
    expect(DEFAULT_API_VERSION).toBe("v1");
  });

  it("honors an explicit, non-default version segment", async () => {
    const app = Fastify() as unknown as ApiGatewayApp;
    const { registerRoute } = createRouteRegistrar(() => app);

    registerRoute(baseOptions({ version: "v2" }));

    const v2Res = await app.inject({ method: "GET", url: "/api/v2/widgets" });
    expect(v2Res.statusCode).toBe(200);

    const v1Res = await app.inject({ method: "GET", url: "/api/v1/widgets" });
    expect(v1Res.statusCode).toBe(404);

    await app.close();
  });

  it("a path already carrying a leading slash is not double-slashed", async () => {
    const app = Fastify() as unknown as ApiGatewayApp;
    const { registerRoute } = createRouteRegistrar(() => app);

    registerRoute(baseOptions({ path: "/greet/:name" }));

    const res = await app.inject({ method: "GET", url: "/api/v1/greet/world" });
    // Route mounts fine (200 would require a matching handler contract; here
    // we only assert it is NOT a 404, proving the path was joined cleanly
    // as "/api/v1/greet/:name" and not "/api/v1//greet/:name").
    expect(res.statusCode).not.toBe(404);

    await app.close();
  });

  it("rejects a malformed version segment with a ValidationError, without mounting the route", () => {
    const app = Fastify() as unknown as ApiGatewayApp;
    const routeSpy = vi.spyOn(app, "route");
    const { registerRoute } = createRouteRegistrar(() => app);

    expect(() => registerRoute(baseOptions({ version: "2" }))).toThrow(ValidationError);
    expect(routeSpy).not.toHaveBeenCalled();
  });
});

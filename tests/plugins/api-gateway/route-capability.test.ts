import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { ValidationError } from "../../../src/core/errors.js";
import { createRouteRegistrar } from "../../../src/plugins/api-gateway/src/route-capability.js";
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

describe("createRouteRegistrar — schema enforcement (feature #59, step 2)", () => {
  it("throws ValidationError when no request-shape schema (body/querystring/params/headers) is declared", () => {
    const app = Fastify() as unknown as ApiGatewayApp;
    const { registerRoute } = createRouteRegistrar(() => app);

    expect(() =>
      registerRoute(
        baseOptions({
          schema: { response: RESPONSE_SCHEMA },
        }),
      ),
    ).toThrow(ValidationError);
  });

  it("throws ValidationError when schema.response is missing", () => {
    const app = Fastify() as unknown as ApiGatewayApp;
    const { registerRoute } = createRouteRegistrar(() => app);

    expect(() =>
      registerRoute(
        baseOptions({
          // @ts-expect-error — deliberately constructing an invalid schema to prove the runtime backstop fires.
          schema: { querystring: { type: "object" } },
        }),
      ),
    ).toThrow(ValidationError);
  });

  it("throws ValidationError when schema.response is an empty object", () => {
    const app = Fastify() as unknown as ApiGatewayApp;
    const { registerRoute } = createRouteRegistrar(() => app);

    expect(() =>
      registerRoute(
        baseOptions({
          schema: { querystring: { type: "object" }, response: {} },
        }),
      ),
    ).toThrow(ValidationError);
  });

  it("does not register the route with Fastify when schema validation fails", () => {
    const app = Fastify() as unknown as ApiGatewayApp;
    const routeSpy = vi.spyOn(app, "route");
    const { registerRoute } = createRouteRegistrar(() => app);

    expect(() => registerRoute(baseOptions({ schema: { response: {} } }))).toThrow();
    expect(routeSpy).not.toHaveBeenCalled();
  });

  it("accepts a schema declaring only body (no querystring/params/headers) for a write route", () => {
    const app = Fastify() as unknown as ApiGatewayApp;
    const { registerRoute } = createRouteRegistrar(() => app);

    expect(() =>
      registerRoute(
        baseOptions({
          method: "POST",
          schema: {
            body: { type: "object", properties: { name: { type: "string" } } },
            response: RESPONSE_SCHEMA,
          },
        }),
      ),
    ).not.toThrow();
  });

  it("wraps Fastify's route() API: a valid registerRoute() call is reachable over HTTP via app.inject()", async () => {
    const app = Fastify() as unknown as ApiGatewayApp;
    const { registerRoute } = createRouteRegistrar(() => app);

    registerRoute(
      baseOptions({
        method: "GET",
        path: "/widgets/:id",
        schema: {
          params: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
          response: RESPONSE_SCHEMA,
        },
        handler: async (request) => ({
          message: `widget-${(request.params as { id: string }).id}`,
        }),
      }),
    );

    const res = await app.inject({ method: "GET", url: "/api/v1/widgets/42" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: "widget-42" });

    await app.close();
  });

  it("a response payload violating the declared response schema is rejected by Fastify's own serializer, proving the schema is really enforced (not just declared)", async () => {
    const app = Fastify() as unknown as ApiGatewayApp;
    const { registerRoute } = createRouteRegistrar(() => app);

    registerRoute(
      baseOptions({
        method: "GET",
        path: "/broken",
        schema: {
          querystring: { type: "object" },
          response: RESPONSE_SCHEMA,
        },
        // Handler returns a shape that violates the declared response schema
        // (missing the required "message" property) — Fastify's serializer
        // should reject/strip this rather than silently letting it through.
        handler: async () => ({ notMessage: "oops" }) as unknown,
      }),
    );

    const res = await app.inject({ method: "GET", url: "/api/v1/broken" });
    // fast-json-stringify silently drops properties not declared in the
    // response schema rather than erroring — so "message" is absent, proving
    // the declared schema (not the handler's raw return value) governs the
    // wire response.
    expect(res.json()).not.toHaveProperty("notMessage");

    await app.close();
  });

  it("getApp is only invoked when registerRoute is actually called, not at createRouteRegistrar() construction time", () => {
    const getApp = vi.fn(() => {
      throw new Error("getApp should not be called yet");
    });

    expect(() => createRouteRegistrar(getApp)).not.toThrow();
    expect(getApp).not.toHaveBeenCalled();
  });
});

describe("createRouteRegistrar — requiredPermission validation (feature #65, step 1)", () => {
  it("accepts a well-formed 'resource:action' requiredPermission and threads it through to the route config", () => {
    const app = Fastify() as unknown as ApiGatewayApp;
    const routeSpy = vi.spyOn(app, "route");
    const { registerRoute } = createRouteRegistrar(() => app);

    expect(() => registerRoute(baseOptions({ requiredPermission: "widgets:read" }))).not.toThrow();

    expect(routeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          requiredPermission: { resource: "widgets", action: "read" },
        }),
      }),
    );
  });

  it("omits requiredPermission from the route config entirely when not set — the overwhelming majority of routes", () => {
    const app = Fastify() as unknown as ApiGatewayApp;
    const routeSpy = vi.spyOn(app, "route");
    const { registerRoute } = createRouteRegistrar(() => app);

    registerRoute(baseOptions());

    const call = routeSpy.mock.calls[0]?.[0] as { config?: Record<string, unknown> } | undefined;
    expect(call?.config?.["requiredPermission"]).toBeUndefined();
  });

  it.each([
    ["missing colon", "widgets"],
    ["empty resource", ":read"],
    ["empty action", "widgets:"],
    ["more than one colon", "widgets:read:extra"],
    ["uppercase segment", "Widgets:read"],
    ["empty string", ""],
  ])("throws ValidationError for a malformed requiredPermission (%s: %j)", (_label, malformed) => {
    const app = Fastify() as unknown as ApiGatewayApp;
    const { registerRoute } = createRouteRegistrar(() => app);

    expect(() => registerRoute(baseOptions({ requiredPermission: malformed }))).toThrow(
      ValidationError,
    );
  });

  it("does not register the route with Fastify when requiredPermission is malformed", () => {
    const app = Fastify() as unknown as ApiGatewayApp;
    const routeSpy = vi.spyOn(app, "route");
    const { registerRoute } = createRouteRegistrar(() => app);

    expect(() => registerRoute(baseOptions({ requiredPermission: "not-valid" }))).toThrow();
    expect(routeSpy).not.toHaveBeenCalled();
  });
});

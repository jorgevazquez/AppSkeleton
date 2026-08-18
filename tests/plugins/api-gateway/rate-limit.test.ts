/**
 * Tests for feature #66 ("Configurable rate limiting (global and
 * per-route)"), mirroring `csrf.test.ts`'s pattern of driving a standalone
 * Fastify instance directly (`Fastify() as unknown as ApiGatewayApp`) rather
 * than the full plugin loader — this feature only depends on #58 (Fastify
 * instance ownership), so it's verified at this module's own boundary.
 *
 * Three groups, matching the feature's steps:
 *   1. Global defaults — every route is rate-limited per `RateLimitConfig`
 *      once `RATE_LIMIT_MAX` requests land within `RATE_LIMIT_WINDOW_MS`
 *      (step 1, first half).
 *   2. The 429 response itself — a rate-limited response carries the
 *      uniform `{code: "RATE_LIMIT_EXCEEDED", message}` envelope and a
 *      `Retry-After` header (step 2), which is also this group's exceeded
 *      -> 429 test (step 3's explicit requirement).
 *   3. Per-route overrides — `registerRoute()`'s `rateLimit` option lets a
 *      specific route apply a stricter limit than the global default, or
 *      disable rate limiting entirely (step 1, second half).
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { ApiGatewayApp } from "../../../src/plugins/api-gateway/index.js";
import { registerErrorHandling } from "../../../src/plugins/api-gateway/src/error-handler.js";
import { loadRateLimitConfig } from "../../../src/plugins/api-gateway/src/rate-limit-config.js";
import { registerRateLimiting } from "../../../src/plugins/api-gateway/src/rate-limit.js";
import { createRouteRegistrar } from "../../../src/plugins/api-gateway/src/route-capability.js";

const OK_RESPONSE_SCHEMA = { 200: { type: "object" } } as const;

/** A bare Fastify instance with the uniform error envelope (feature #60/#61) and rate limiting (feature #66) wired on, given `env` overrides for RATE_LIMIT_MAX/RATE_LIMIT_WINDOW_MS — the same order `../../../src/plugins/api-gateway/index.ts`'s `buildApp()` uses. */
async function buildTestApp(env: Record<string, string>): Promise<ApiGatewayApp> {
  const app = Fastify() as unknown as ApiGatewayApp;
  registerErrorHandling(app, { nodeEnv: "test" });
  await registerRateLimiting(app, loadRateLimitConfig({ env }));
  return app;
}

describe("registerRateLimiting — global defaults (feature #66 step 1, half 1)", () => {
  it("allows requests up to RATE_LIMIT_MAX within the window", async () => {
    const app = await buildTestApp({ RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW_MS: "60000" });
    app.get("/widgets", async () => ({ ok: true }));

    const first = await app.inject({ method: "GET", url: "/widgets" });
    const second = await app.inject({ method: "GET", url: "/widgets" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  it("applies the global default to every route, /health included, with no per-route opt-in", async () => {
    const app = await buildTestApp({ RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_MS: "60000" });
    app.get("/health", async () => ({ status: "ok" }));

    const first = await app.inject({ method: "GET", url: "/health" });
    const second = await app.inject({ method: "GET", url: "/health" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
  });
});

describe("registerRateLimiting — 429 on limit exceeded (feature #66 steps 2 & 3)", () => {
  it("a request beyond RATE_LIMIT_MAX gets a 429 response", async () => {
    const app = await buildTestApp({ RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_MS: "60000" });
    app.get("/widgets", async () => ({ ok: true }));

    await app.inject({ method: "GET", url: "/widgets" });
    const exceeded = await app.inject({ method: "GET", url: "/widgets" });

    expect(exceeded.statusCode).toBe(429);
  });

  it("the 429 response carries a Retry-After header", async () => {
    const app = await buildTestApp({ RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_MS: "60000" });
    app.get("/widgets", async () => ({ ok: true }));

    await app.inject({ method: "GET", url: "/widgets" });
    const exceeded = await app.inject({ method: "GET", url: "/widgets" });

    expect(exceeded.headers["retry-after"]).toBeDefined();
    expect(Number(exceeded.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("the 429 body uses the uniform AppError envelope with a rate-limit-specific code", async () => {
    const app = await buildTestApp({ RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_MS: "60000" });
    app.get("/widgets", async () => ({ ok: true }));

    await app.inject({ method: "GET", url: "/widgets" });
    const exceeded = await app.inject({ method: "GET", url: "/widgets" });

    expect(exceeded.json()).toMatchObject({
      code: "RATE_LIMIT_EXCEEDED",
      message: expect.any(String),
    });
    // Never Fastify's own default { statusCode, error, message } shape, and
    // never the generic BAD_REQUEST code the pre-#66 fallback would have
    // produced (error-handler.ts's toGenericClientErrorEnvelope).
    expect(exceeded.json().code).not.toBe("BAD_REQUEST");
    expect(exceeded.json()).not.toHaveProperty("statusCode");
    expect(exceeded.json()).not.toHaveProperty("error");
  });

  it("does not rate-limit again once the client is back under the max in a fresh window", async () => {
    const app = await buildTestApp({ RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_MS: "50" });
    app.get("/widgets", async () => ({ ok: true }));

    await app.inject({ method: "GET", url: "/widgets" });
    const exceeded = await app.inject({ method: "GET", url: "/widgets" });
    expect(exceeded.statusCode).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 75));

    const afterWindow = await app.inject({ method: "GET", url: "/widgets" });
    expect(afterWindow.statusCode).toBe(200);
  });
});

describe("registerRoute — per-route rateLimit override (feature #66 step 1, half 2)", () => {
  it("a stricter per-route max is enforced independently of the (more generous) global default", async () => {
    const app = await buildTestApp({ RATE_LIMIT_MAX: "100", RATE_LIMIT_WINDOW_MS: "60000" });
    const { registerRoute } = createRouteRegistrar(() => app);

    registerRoute({
      method: "GET",
      path: "/login",
      schema: { querystring: { type: "object" }, response: OK_RESPONSE_SCHEMA },
      handler: async () => ({ ok: true }),
      rateLimit: { max: 1, timeWindow: 60000 },
    });
    registerRoute({
      method: "GET",
      path: "/widgets",
      schema: { querystring: { type: "object" }, response: OK_RESPONSE_SCHEMA },
      handler: async () => ({ ok: true }),
    });

    const firstLogin = await app.inject({ method: "GET", url: "/api/v1/login" });
    const secondLogin = await app.inject({ method: "GET", url: "/api/v1/login" });
    expect(firstLogin.statusCode).toBe(200);
    expect(secondLogin.statusCode).toBe(429);

    // The plain route is still on the generous global default (max 100),
    // proving the stricter override above didn't leak onto every route.
    const widgets = await app.inject({ method: "GET", url: "/api/v1/widgets" });
    expect(widgets.statusCode).toBe(200);
  });

  it("rateLimit: false disables rate limiting entirely for that route", async () => {
    const app = await buildTestApp({ RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_MS: "60000" });
    const { registerRoute } = createRouteRegistrar(() => app);

    registerRoute({
      method: "GET",
      path: "/unthrottled",
      schema: { querystring: { type: "object" }, response: OK_RESPONSE_SCHEMA },
      handler: async () => ({ ok: true }),
      rateLimit: false,
    });

    const first = await app.inject({ method: "GET", url: "/api/v1/unthrottled" });
    const second = await app.inject({ method: "GET", url: "/api/v1/unthrottled" });
    const third = await app.inject({ method: "GET", url: "/api/v1/unthrottled" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(200);
  });
});

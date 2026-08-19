/**
 * Tests for feature #71 ("Request size limits and timeout configuration"),
 * mirroring `rate-limit.test.ts`'s pattern of driving a standalone Fastify
 * instance directly, constructed with the same `bodyLimit`/`requestTimeout`
 * options `../../../src/plugins/api-gateway/index.ts`'s `buildApp()` passes
 * to `Fastify(...)` — this feature only depends on #58 (Fastify instance
 * ownership), so it's verified at this module's own boundary.
 *
 * Two groups, matching the feature's steps:
 *   1. Config wiring — REQUEST_BODY_LIMIT_BYTES/REQUEST_TIMEOUT_MS actually
 *      reach the constructed Fastify instance's own `initialConfig` (step 1).
 *   2. Oversized payload rejection — a request body larger than
 *      REQUEST_BODY_LIMIT_BYTES gets a 413 with the uniform error envelope,
 *      and — the feature's explicit step 2 requirement — the route handler
 *      itself is never invoked (rejected before reaching the handler).
 */
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ApiGatewayApp } from "../../../src/plugins/api-gateway/index.js";
import { registerErrorHandling } from "../../../src/plugins/api-gateway/src/error-handler.js";
import { loadRequestLimitsConfig } from "../../../src/plugins/api-gateway/src/request-limits-config.js";

/** A bare Fastify instance built with the same bodyLimit/requestTimeout wiring `../../../src/plugins/api-gateway/index.ts`'s `buildApp()` uses, given `env` overrides for REQUEST_BODY_LIMIT_BYTES/REQUEST_TIMEOUT_MS, plus the uniform error envelope (feature #60/#61) so a rejection is asserted against this kernel's own error shape, not Fastify's default. */
function buildTestApp(env: Record<string, string>): ApiGatewayApp {
  const config = loadRequestLimitsConfig({ env });
  const app = Fastify({
    bodyLimit: config.REQUEST_BODY_LIMIT_BYTES,
    requestTimeout: config.REQUEST_TIMEOUT_MS,
  }) as unknown as ApiGatewayApp;
  registerErrorHandling(app, { nodeEnv: "test" });
  return app;
}

describe("api-gateway request limits — config wiring (feature #71 step 1)", () => {
  it("REQUEST_BODY_LIMIT_BYTES reaches the Fastify instance's own bodyLimit", () => {
    const app = buildTestApp({ REQUEST_BODY_LIMIT_BYTES: "2048", REQUEST_TIMEOUT_MS: "5000" });
    expect(app.initialConfig.bodyLimit).toBe(2048);
  });

  it("REQUEST_TIMEOUT_MS reaches the underlying Node HTTP server's own requestTimeout", () => {
    // Fastify's own `initialConfig` typings omit `requestTimeout` (a typing
    // gap, not a runtime one — it forwards the option straight to Node's
    // `http.createServer`), so this asserts against the underlying
    // `http.Server` instance itself, which Node types accurately.
    const app = buildTestApp({ REQUEST_BODY_LIMIT_BYTES: "2048", REQUEST_TIMEOUT_MS: "5000" });
    expect(app.server.requestTimeout).toBe(5000);
  });

  it("defaults to a 1 MiB bodyLimit and a 30s requestTimeout when unconfigured", () => {
    const app = buildTestApp({});
    expect(app.initialConfig.bodyLimit).toBe(1048576);
    expect(app.server.requestTimeout).toBe(30000);
  });
});

describe("api-gateway request limits — oversized payload rejection (feature #71 step 2)", () => {
  it("rejects a request body larger than REQUEST_BODY_LIMIT_BYTES with 413, before the handler runs", async () => {
    const app = buildTestApp({ REQUEST_BODY_LIMIT_BYTES: "1024", REQUEST_TIMEOUT_MS: "30000" });
    const handler = vi.fn(async () => ({ ok: true }));
    app.post("/widgets", handler);

    const oversizedPayload = "x".repeat(2048);
    const res = await app.inject({
      method: "POST",
      url: "/widgets",
      headers: { "content-type": "text/plain" },
      payload: oversizedPayload,
    });

    expect(res.statusCode).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it("the 413 response uses the uniform error envelope, not Fastify's raw error shape", async () => {
    const app = buildTestApp({ REQUEST_BODY_LIMIT_BYTES: "1024", REQUEST_TIMEOUT_MS: "30000" });
    app.post("/widgets", async () => ({ ok: true }));

    const res = await app.inject({
      method: "POST",
      url: "/widgets",
      headers: { "content-type": "text/plain" },
      payload: "x".repeat(2048),
    });

    expect(res.json()).toMatchObject({ code: expect.any(String), message: expect.any(String) });
    expect(res.json()).not.toHaveProperty("statusCode");
    expect(res.json()).not.toHaveProperty("error");
  });

  it("accepts a request body at or under REQUEST_BODY_LIMIT_BYTES and reaches the handler", async () => {
    const app = buildTestApp({ REQUEST_BODY_LIMIT_BYTES: "1024", REQUEST_TIMEOUT_MS: "30000" });
    const handler = vi.fn(async () => ({ ok: true }));
    app.post("/widgets", handler);

    const res = await app.inject({
      method: "POST",
      url: "/widgets",
      headers: { "content-type": "text/plain" },
      payload: "x".repeat(100),
    });

    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

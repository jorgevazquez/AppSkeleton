/**
 * Tests for feature #68 ("Configurable CORS allow-list"), mirroring
 * `security-headers.test.ts`'s pattern of driving a standalone Fastify
 * instance directly (`Fastify() as unknown as ApiGatewayApp`) rather than
 * the full plugin loader — this feature only depends on #58 (Fastify
 * instance ownership), so it's verified at this module's own boundary.
 *
 * Step 2's explicit requirement: assert an allowed origin gets CORS headers
 * and a disallowed origin does not.
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { ApiGatewayApp } from "../../../src/plugins/api-gateway/index.js";
import {
  loadCorsConfig,
  type CorsConfig,
} from "../../../src/plugins/api-gateway/src/cors-config.js";
import { registerCors } from "../../../src/plugins/api-gateway/src/cors.js";
import { registerErrorHandling } from "../../../src/plugins/api-gateway/src/error-handler.js";

const ALLOWED_ORIGIN = "https://allowed.example.com";
const DISALLOWED_ORIGIN = "https://disallowed.example.com";

/** A bare Fastify instance with the uniform error envelope (feature #60/#61) and CORS (feature #68) wired on, given an explicit `CorsConfig` — the same order `../../../src/plugins/api-gateway/index.ts`'s `buildApp()` uses. */
async function buildTestApp(
  config: CorsConfig = loadCorsConfig({ env: { CORS_ORIGIN: ALLOWED_ORIGIN } }),
): Promise<ApiGatewayApp> {
  const app = Fastify() as unknown as ApiGatewayApp;
  registerErrorHandling(app, { nodeEnv: "test" });
  await registerCors(app, config);
  app.get("/widgets", async () => ({ ok: true }));
  return app;
}

describe("registerCors — allow-listed origin (feature #68 step 1 & 2)", () => {
  it("reflects an allow-listed Origin back via Access-Control-Allow-Origin", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/widgets",
      headers: { origin: ALLOWED_ORIGIN },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
  });

  it("answers an allow-listed preflight OPTIONS request with CORS headers", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/widgets",
      headers: {
        origin: ALLOWED_ORIGIN,
        "access-control-request-method": "GET",
      },
    });

    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
  });

  it("applies the same allow-list to every route, /health included", async () => {
    const app = await buildTestApp();
    app.get("/health", async () => ({ status: "ok" }));

    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
  });
});

describe("registerCors — deny by default for unlisted origins (feature #68 step 1 & 2)", () => {
  it("does not set Access-Control-Allow-Origin for a disallowed origin", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/widgets",
      headers: { origin: DISALLOWED_ORIGIN },
    });

    // The route still handles the request — CORS is enforced by the
    // browser, not the server — but no header is present to let a browser
    // treat the response as readable cross-origin.
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("denies every origin when CORS_ORIGIN is left at its empty default", async () => {
    const app = await buildTestApp(loadCorsConfig({ env: {} }));
    const res = await app.inject({
      method: "GET",
      url: "/widgets",
      headers: { origin: ALLOWED_ORIGIN },
    });

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows a request with no Origin header at all (same-origin/non-browser callers)", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/widgets" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

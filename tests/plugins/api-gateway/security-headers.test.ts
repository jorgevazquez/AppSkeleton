/**
 * Tests for feature #67 ("Security headers (CSP, HSTS, X-Frame-Options,
 * etc.) via helmet"), mirroring `rate-limit.test.ts`'s pattern of driving a
 * standalone Fastify instance directly (`Fastify() as unknown as
 * ApiGatewayApp`) rather than the full plugin loader — this feature only
 * depends on #58 (Fastify instance ownership), so it's verified at this
 * module's own boundary.
 *
 * Two groups, matching the feature's steps:
 *   1. Sensible defaults — every response carries CSP, HSTS,
 *      X-Frame-Options, and the rest of helmet's default header set,
 *      applied globally (`/health` and any consumer-registered route
 *      alike), step 2's explicit "assert the expected security headers are
 *      present" requirement.
 *   2. Configurable per-deployment — `SecurityHeadersConfig`'s toggles
 *      (`HELMET_ENABLED`, `HELMET_CSP_ENABLED`, `HELMET_HSTS_ENABLED`,
 *      `HELMET_HSTS_MAX_AGE`) each independently change the resulting
 *      headers, step 1's "configurable per-deployment" requirement.
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { ApiGatewayApp } from "../../../src/plugins/api-gateway/index.js";
import { registerErrorHandling } from "../../../src/plugins/api-gateway/src/error-handler.js";
import {
  loadSecurityHeadersConfig,
  type SecurityHeadersConfig,
} from "../../../src/plugins/api-gateway/src/security-headers-config.js";
import { registerSecurityHeaders } from "../../../src/plugins/api-gateway/src/security-headers.js";

/** A bare Fastify instance with the uniform error envelope (feature #60/#61) and security headers (feature #67) wired on, given an explicit `SecurityHeadersConfig` — the same order `../../../src/plugins/api-gateway/index.ts`'s `buildApp()` uses. */
async function buildTestApp(
  config: SecurityHeadersConfig = loadSecurityHeadersConfig({ env: {} }),
): Promise<ApiGatewayApp> {
  const app = Fastify() as unknown as ApiGatewayApp;
  registerErrorHandling(app, { nodeEnv: "test" });
  await registerSecurityHeaders(app, config);
  app.get("/widgets", async () => ({ ok: true }));
  return app;
}

describe("registerSecurityHeaders — sensible defaults (feature #67 step 1, half 1 & step 2)", () => {
  it("sets a Content-Security-Policy header", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/widgets" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toBeDefined();
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("sets a Strict-Transport-Security header with the configured max-age", async () => {
    const app = await buildTestApp(
      loadSecurityHeadersConfig({ env: { HELMET_HSTS_MAX_AGE: "12345" } }),
    );
    const res = await app.inject({ method: "GET", url: "/widgets" });

    expect(res.headers["strict-transport-security"]).toContain("max-age=12345");
    expect(res.headers["strict-transport-security"]).toContain("includeSubDomains");
  });

  it("sets X-Frame-Options: SAMEORIGIN", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/widgets" });

    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("sets X-Content-Type-Options: nosniff", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/widgets" });

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("applies the same headers to every route, /health included, with no per-route opt-in", async () => {
    const app = await buildTestApp();
    app.get("/health", async () => ({ status: "ok" }));

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["content-security-policy"]).toBeDefined();
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});

describe("registerSecurityHeaders — configurable per-deployment (feature #67 step 1, half 2)", () => {
  it("HELMET_ENABLED: false disables every header this module sets", async () => {
    const app = await buildTestApp(loadSecurityHeadersConfig({ env: { HELMET_ENABLED: "false" } }));
    const res = await app.inject({ method: "GET", url: "/widgets" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    expect(res.headers["x-frame-options"]).toBeUndefined();
  });

  it("HELMET_CSP_ENABLED: false drops only the Content-Security-Policy header", async () => {
    const app = await buildTestApp(
      loadSecurityHeadersConfig({ env: { HELMET_CSP_ENABLED: "false" } }),
    );
    const res = await app.inject({ method: "GET", url: "/widgets" });

    expect(res.headers["content-security-policy"]).toBeUndefined();
    // The rest of helmet's default headers are unaffected by the CSP toggle.
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["strict-transport-security"]).toBeDefined();
  });

  it("HELMET_HSTS_ENABLED: false drops only the Strict-Transport-Security header", async () => {
    const app = await buildTestApp(
      loadSecurityHeadersConfig({ env: { HELMET_HSTS_ENABLED: "false" } }),
    );
    const res = await app.inject({ method: "GET", url: "/widgets" });

    expect(res.headers["strict-transport-security"]).toBeUndefined();
    // The rest of helmet's default headers are unaffected by the HSTS toggle.
    expect(res.headers["content-security-policy"]).toBeDefined();
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});

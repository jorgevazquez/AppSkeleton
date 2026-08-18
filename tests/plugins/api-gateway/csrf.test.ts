/**
 * Tests for feature #64 ("CSRF protection for state-changing routes"),
 * mirroring `session.test.ts`'s pattern of driving a standalone Fastify
 * instance directly (`Fastify() as unknown as ApiGatewayApp`) rather than
 * the full plugin loader — this feature only depends on #58 (Fastify
 * instance ownership) and #63 (cookie handling), so it's verified at this
 * module's own boundary, the same way `session.test.ts`/`error-handler.test.ts`
 * verify their own modules.
 *
 * Four groups, matching the feature's steps plus the registration-time
 * enforcement of its opt-out:
 *   1. Issuance — every request gets a `csrf_token` cookie if it doesn't
 *      already have one, and it's never `HttpOnly`.
 *   2. Verification — step 1's "reject a state-changing request without a
 *      valid token", step 3's explicit test requirement, plus the
 *      safe-method carve-out.
 *   3. Opt-out — `csrfExempt` route config bypasses protection entirely
 *      (step 2's "safe by construction" escape hatch, at the `csrf.ts` hook
 *      level).
 *   4. `registerRoute()`'s `csrfExempt` option — the audited half of step 2:
 *      requires a real reason, wires the route config the hook reads, and
 *      logs the opt-out.
 */
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { CsrfError } from "../../../src/core/errors.js";
import type { ApiGatewayApp } from "../../../src/plugins/api-gateway/index.js";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  registerCsrfProtection,
} from "../../../src/plugins/api-gateway/src/csrf.js";
import { registerErrorHandling } from "../../../src/plugins/api-gateway/src/error-handler.js";
import {
  createRouteRegistrar,
  MIN_CSRF_EXEMPT_REASON_LENGTH,
} from "../../../src/plugins/api-gateway/src/route-capability.js";
import { registerSessionCookies } from "../../../src/plugins/api-gateway/src/session.js";

const OK_RESPONSE_SCHEMA = { 200: { type: "object" } } as const;

/** A bare Fastify instance with the uniform error envelope (feature #60/#61), cookie parsing (feature #63), and CSRF protection (feature #64) wired on — the same order `../../../src/plugins/api-gateway/index.ts`'s `buildApp()` uses — plus a tiny mutating route to exercise verification through real HTTP round-trips. */
function buildTestApp(): ApiGatewayApp {
  const app = Fastify() as unknown as ApiGatewayApp;
  registerErrorHandling(app, { nodeEnv: "test" });
  registerSessionCookies(app, { COOKIE_SECURE: false });
  registerCsrfProtection(app);

  app.get("/get", async () => ({ ok: true }));
  app.post("/mutate", async () => ({ mutated: true }));
  app.post("/mutate-exempt", { config: { csrfExempt: true } }, async () => ({ mutated: true }));

  return app;
}

/** Extract a named cookie's `name=value` pair from a response's `Set-Cookie` header(s). */
function findSetCookie(
  res: { headers: Record<string, unknown> },
  name: string,
): string | undefined {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  const header = headers.find((value) => typeof value === "string" && value.startsWith(`${name}=`));
  return typeof header === "string" ? (header.split(";")[0] as string) : undefined;
}

describe("registerCsrfProtection — issuance (feature #64 step 1, half 1)", () => {
  it("issues a csrf_token cookie on a GET request that doesn't already have one", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/get" });

    expect(res.statusCode).toBe(200);
    expect(findSetCookie(res, CSRF_COOKIE_NAME)).toMatch(new RegExp(`^${CSRF_COOKIE_NAME}=`));
  });

  it("the issued csrf_token cookie is never HttpOnly — same-origin JS must be able to read it", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/get" });

    const raw = res.headers["set-cookie"];
    const headers = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
    const cookieHeader = headers.find(
      (value) => typeof value === "string" && value.startsWith(`${CSRF_COOKIE_NAME}=`),
    ) as string;

    expect(cookieHeader).not.toMatch(/HttpOnly/i);
  });

  it("does not re-issue a cookie when a valid one is already present on the request", async () => {
    const app = buildTestApp();
    const issued = await app.inject({ method: "GET", url: "/get" });
    const cookiePair = findSetCookie(issued, CSRF_COOKIE_NAME) as string;

    const second = await app.inject({
      method: "GET",
      url: "/get",
      headers: { cookie: cookiePair },
    });
    expect(findSetCookie(second, CSRF_COOKIE_NAME)).toBeUndefined();
  });
});

describe("registerCsrfProtection — verification (feature #64 steps 1 & 3)", () => {
  it("rejects a state-changing request with no csrf_token cookie and no header at all", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "POST", url: "/mutate" });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "CSRF_ERROR" });
  });

  it("rejects a state-changing request that presents a csrf_token cookie but no x-csrf-token header", async () => {
    const app = buildTestApp();
    const issued = await app.inject({ method: "GET", url: "/get" });
    const cookiePair = findSetCookie(issued, CSRF_COOKIE_NAME) as string;

    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: { cookie: cookiePair },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "CSRF_ERROR" });
  });

  it("rejects a state-changing request whose x-csrf-token header doesn't match the cookie", async () => {
    const app = buildTestApp();
    const issued = await app.inject({ method: "GET", url: "/get" });
    const cookiePair = findSetCookie(issued, CSRF_COOKIE_NAME) as string;

    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: { cookie: cookiePair, [CSRF_HEADER_NAME]: "a-completely-different-token-value" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "CSRF_ERROR" });
  });

  it("accepts a state-changing request whose x-csrf-token header matches the csrf_token cookie", async () => {
    const app = buildTestApp();
    const issued = await app.inject({ method: "GET", url: "/get" });
    const cookiePair = findSetCookie(issued, CSRF_COOKIE_NAME) as string;
    const token = cookiePair.slice(`${CSRF_COOKIE_NAME}=`.length);

    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: { cookie: cookiePair, [CSRF_HEADER_NAME]: token },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mutated: true });
  });

  it("throws CsrfError, so a rejection carries the standard AppError taxonomy (403, safe publicMessage)", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "POST", url: "/mutate" });

    const error = new CsrfError("test");
    expect(res.statusCode).toBe(error.statusCode);
    expect(res.json()).toEqual({ code: error.code, message: error.publicMessage });
  });

  it("does not require a token for safe methods (GET/HEAD) even with no cookie present", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/get" });
    expect(res.statusCode).toBe(200);
  });
});

describe("registerCsrfProtection — csrfExempt route config bypasses protection entirely (feature #64 step 2)", () => {
  it("a state-changing request to an exempt route succeeds with no cookie or header at all", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "POST", url: "/mutate-exempt" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mutated: true });
  });

  it("an exempt route is never issued a csrf_token cookie either", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "POST", url: "/mutate-exempt" });
    expect(findSetCookie(res, CSRF_COOKIE_NAME)).toBeUndefined();
  });
});

describe("registerRoute()'s csrfExempt option — the audited opt-out (feature #64 step 2)", () => {
  function testApp() {
    const app = Fastify() as unknown as ApiGatewayApp;
    registerSessionCookies(app, { COOKIE_SECURE: false });
    registerCsrfProtection(app);
    return app;
  }

  const VALID_REASON = "pure JSON API behind strict CORS, bearer-token auth only, no cookies";

  it("throws ValidationError when csrfExempt is present but reason is missing", () => {
    const app = testApp();
    const { registerRoute } = createRouteRegistrar(() => app);

    expect(() =>
      registerRoute({
        method: "POST",
        path: "/widgets",
        schema: { body: { type: "object" }, response: OK_RESPONSE_SCHEMA },
        handler: async () => ({}),
        // @ts-expect-error — deliberately omitting the required `reason` to prove the runtime backstop fires.
        csrfExempt: {},
      }),
    ).toThrow(/csrfExempt\.reason/);
  });

  it(`throws ValidationError when reason is shorter than ${MIN_CSRF_EXEMPT_REASON_LENGTH} characters`, () => {
    const app = testApp();
    const { registerRoute } = createRouteRegistrar(() => app);

    expect(() =>
      registerRoute({
        method: "POST",
        path: "/widgets",
        schema: { body: { type: "object" }, response: OK_RESPONSE_SCHEMA },
        handler: async () => ({}),
        csrfExempt: { reason: "too short" },
      }),
    ).toThrow(/csrfExempt\.reason/);
  });

  it("registers successfully with a sufficiently long reason, and the route is actually exempt end-to-end", async () => {
    const app = testApp();
    const { registerRoute } = createRouteRegistrar(() => app);

    registerRoute({
      method: "POST",
      path: "/widgets",
      schema: { body: { type: "object" }, response: OK_RESPONSE_SCHEMA },
      handler: async () => ({ ok: true }),
      csrfExempt: { reason: VALID_REASON },
    });

    const res = await app.inject({ method: "POST", url: "/api/v1/widgets", payload: {} });
    expect(res.statusCode).toBe(200);
  });

  it("logs a warn-level audit line recording the route and the stated reason", () => {
    const app = testApp();
    const warnSpy = vi.spyOn(app.log, "warn");
    const { registerRoute } = createRouteRegistrar(() => app);

    registerRoute({
      method: "POST",
      path: "/widgets",
      schema: { body: { type: "object" }, response: OK_RESPONSE_SCHEMA },
      handler: async () => ({}),
      csrfExempt: { reason: VALID_REASON },
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [details, message] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(details).toMatchObject({
      method: "POST",
      path: "/api/v1/widgets",
      reason: VALID_REASON,
    });
    expect(message).toContain("CSRF protection explicitly disabled");
  });

  it("does not log anything for an ordinary (non-exempt) route", () => {
    const app = testApp();
    const warnSpy = vi.spyOn(app.log, "warn");
    const { registerRoute } = createRouteRegistrar(() => app);

    registerRoute({
      method: "POST",
      path: "/widgets",
      schema: { body: { type: "object" }, response: OK_RESPONSE_SCHEMA },
      handler: async () => ({}),
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("an ordinary (non-exempt) route registered through registerRoute() is still protected end-to-end", async () => {
    const app = testApp();
    const { registerRoute } = createRouteRegistrar(() => app);

    registerRoute({
      method: "POST",
      path: "/widgets",
      schema: { body: { type: "object" }, response: OK_RESPONSE_SCHEMA },
      handler: async () => ({}),
    });

    const res = await app.inject({ method: "POST", url: "/api/v1/widgets", payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "CSRF_ERROR" });
  });
});

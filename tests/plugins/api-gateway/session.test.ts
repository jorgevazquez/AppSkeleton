/**
 * Tests for feature #63 ("Session/cookie handling with secure defaults"),
 * driven directly against a standalone Fastify instance (mirroring
 * `error-handler.test.ts`'s `Fastify() as unknown as ApiGatewayApp`
 * pattern) rather than the full plugin loader — this feature depends only
 * on #58 (Fastify instance ownership), so it's verified at this module's
 * own boundary directly, the same way `error-handler.test.ts` verifies
 * `registerErrorHandling()`.
 *
 * Three groups, matching this feature's three steps:
 *   1. `issueSessionId`/`verifySessionId` — the signed session-identifier
 *      helper, tested in complete isolation from Fastify/cookies entirely.
 *   2. `registerSessionCookies`/`issueSessionCookie` — proves the actual
 *      `Set-Cookie` header carries `HttpOnly`, `Secure` (config-driven off
 *      `COOKIE_SECURE`), and `SameSite=Lax`.
 *   3. `readSessionId` — proves a session cookie issued by this module
 *      round-trips to the same id, while a tampered cookie value (or one
 *      signed under a different secret) is rejected outright.
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { ApiGatewayApp } from "../../../src/plugins/api-gateway/index.js";
import type { SessionConfig } from "../../../src/plugins/api-gateway/src/session-config.js";
import {
  issueSessionCookie,
  issueSessionId,
  readSessionId,
  registerSessionCookies,
  verifySessionId,
} from "../../../src/plugins/api-gateway/src/session.js";

const SECRET = "a-sufficiently-long-test-secret-value";

function testSessionConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    SESSION_SECRET: SECRET,
    COOKIE_SECURE: true,
    SESSION_COOKIE_NAME: "sid",
    ...overrides,
  };
}

/** A bare Fastify instance with session cookies wired on, plus two tiny routes to exercise issuance/verification through real HTTP round-trips. */
function buildTestApp(config: SessionConfig): ApiGatewayApp {
  const app = Fastify() as unknown as ApiGatewayApp;
  registerSessionCookies(app, config);

  app.get("/issue", async (_request, reply) => ({ id: issueSessionCookie(reply, config) }));
  app.get("/whoami", async (request) => ({ id: readSessionId(request, config) ?? null }));

  return app;
}

/** Flip the last character of a base64url string to a different valid base64url character — simulates a tampered cookie value without producing an invalid-format string. */
function flipLastChar(value: string): string {
  const last = value.at(-1);
  const replacement = last === "0" ? "1" : "0";
  return `${value.slice(0, -1)}${replacement}`;
}

function firstSetCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string") {
    throw new Error("expected a Set-Cookie header in the response");
  }
  return header;
}

describe("issueSessionId / verifySessionId — signed session identifier helper (feature #63 step 2)", () => {
  it("verifies a session id issued with the same secret, returning its bare id", () => {
    const signed = issueSessionId(SECRET);
    expect(verifySessionId(signed, SECRET)).toBeDefined();
  });

  it("verification is deterministic — the same signed value always resolves to the same bare id", () => {
    const signed = issueSessionId(SECRET);
    const first = verifySessionId(signed, SECRET);
    const second = verifySessionId(signed, SECRET);
    expect(first).toBe(second);
  });

  it("produces a different id on every call", () => {
    expect(issueSessionId(SECRET)).not.toBe(issueSessionId(SECRET));
  });

  it("rejects a value signed under a different secret", () => {
    const signed = issueSessionId(SECRET);
    expect(verifySessionId(signed, "a-totally-different-secret-value")).toBeUndefined();
  });

  it("rejects a tampered signature portion", () => {
    const signed = issueSessionId(SECRET);
    const separatorIndex = signed.lastIndexOf(".");
    const id = signed.slice(0, separatorIndex);
    const signature = signed.slice(separatorIndex + 1);
    expect(verifySessionId(`${id}.${flipLastChar(signature)}`, SECRET)).toBeUndefined();
  });

  it("rejects a tampered id portion (signature no longer matches the altered id)", () => {
    const signed = issueSessionId(SECRET);
    const separatorIndex = signed.lastIndexOf(".");
    const id = signed.slice(0, separatorIndex);
    const signature = signed.slice(separatorIndex + 1);
    expect(verifySessionId(`${flipLastChar(id)}.${signature}`, SECRET)).toBeUndefined();
  });

  it("rejects malformed values with no separator", () => {
    expect(verifySessionId("not-a-signed-value", SECRET)).toBeUndefined();
  });

  it("rejects a value with an empty id or empty signature", () => {
    expect(verifySessionId(".signature-only", SECRET)).toBeUndefined();
    expect(verifySessionId("id-only.", SECRET)).toBeUndefined();
  });
});

describe("registerSessionCookies / issueSessionCookie — secure cookie defaults (feature #63 step 1)", () => {
  it("issues a Set-Cookie with HttpOnly, Secure, and SameSite=Lax when COOKIE_SECURE=true", async () => {
    const app = buildTestApp(testSessionConfig({ COOKIE_SECURE: true }));
    const res = await app.inject({ method: "GET", url: "/issue" });

    const cookieHeader = firstSetCookie(res);
    expect(cookieHeader).toMatch(/^sid=/);
    expect(cookieHeader).toMatch(/(^|;\s*)HttpOnly(;|$)/i);
    expect(cookieHeader).toMatch(/(^|;\s*)Secure(;|$)/i);
    expect(cookieHeader).toMatch(/SameSite=Lax/i);
  });

  it("omits Secure when COOKIE_SECURE=false — the Secure flag is config-driven, not hard-coded", async () => {
    const app = buildTestApp(testSessionConfig({ COOKIE_SECURE: false }));
    const res = await app.inject({ method: "GET", url: "/issue" });

    const cookieHeader = firstSetCookie(res);
    expect(cookieHeader).toMatch(/(^|;\s*)HttpOnly(;|$)/i);
    expect(cookieHeader).not.toMatch(/(^|;\s*)Secure(;|$)/i);
    expect(cookieHeader).toMatch(/SameSite=Lax/i);
  });

  it("uses the configured cookie name", async () => {
    const app = buildTestApp(testSessionConfig({ SESSION_COOKIE_NAME: "my_session" }));
    const res = await app.inject({ method: "GET", url: "/issue" });
    expect(firstSetCookie(res)).toMatch(/^my_session=/);
  });
});

describe("readSessionId — accepting a real session, rejecting a tampered one (feature #63 step 3)", () => {
  it("accepts a session cookie it just issued, resolving to the same bare id", async () => {
    const app = buildTestApp(testSessionConfig());

    const issued = await app.inject({ method: "GET", url: "/issue" });
    const cookiePair = firstSetCookie(issued).split(";")[0] as string;

    const whoami = await app.inject({
      method: "GET",
      url: "/whoami",
      headers: { cookie: cookiePair },
    });

    expect(whoami.json()).toEqual({ id: (issued.json() as { id: string }).id });
  });

  it("rejects a tampered cookie value instead of trusting a forged session id", async () => {
    const app = buildTestApp(testSessionConfig());

    const issued = await app.inject({ method: "GET", url: "/issue" });
    const [name, value] = (firstSetCookie(issued).split(";")[0] as string).split("=");
    const tamperedValue = flipLastChar(value as string);

    const whoami = await app.inject({
      method: "GET",
      url: "/whoami",
      headers: { cookie: `${name}=${tamperedValue}` },
    });

    expect(whoami.json()).toEqual({ id: null });
  });

  it("rejects a cookie signed under a different secret than the one verifying it", async () => {
    const issuingApp = buildTestApp(testSessionConfig({ SESSION_SECRET: SECRET }));
    const verifyingApp = buildTestApp(
      testSessionConfig({ SESSION_SECRET: "a-different-secret-value-entirely" }),
    );

    const issued = await issuingApp.inject({ method: "GET", url: "/issue" });
    const cookiePair = firstSetCookie(issued).split(";")[0] as string;

    const whoami = await verifyingApp.inject({
      method: "GET",
      url: "/whoami",
      headers: { cookie: cookiePair },
    });

    expect(whoami.json()).toEqual({ id: null });
  });

  it("returns null when no session cookie is present at all", async () => {
    const app = buildTestApp(testSessionConfig());
    const whoami = await app.inject({ method: "GET", url: "/whoami" });
    expect(whoami.json()).toEqual({ id: null });
  });
});

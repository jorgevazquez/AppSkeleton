/**
 * Tests for `src/plugins/wiki/src/session-identity.ts` (feature #94's
 * session-identity resolution, duplicated from `api-gateway/src/session.ts`
 * per `docs/plugin-conventions.md` section 5 — see that module's own doc
 * comment for the full rationale).
 *
 * Two groups:
 *   1. `resolveUserId`/`verifySignedSessionId` exercised standalone —
 *      round-trips a self-issued signed value, and rejects a missing
 *      cookie, a malformed value, a tampered signature, and a value signed
 *      under a different secret.
 *   2. The property the entire design depends on: this module's
 *      verification algorithm must be byte-for-byte equivalent to
 *      `api-gateway/src/session.ts`'s own — a session a real login flow
 *      issued (via `issueSessionId`) must verify identically here, so a
 *      role assigned (via `rbac:manage`) to the userId a real login
 *      produced is recognized by wiki's own routes too. This is the one
 *      deliberate cross-plugin import in this suite (`api-gateway/src/
 *      session.ts`) — the "kernel-integration test crosses into another
 *      plugin's internals directly" carve-out `pages-store.integration.
 *      test.ts`'s own module doc already establishes, used here to prove
 *      the two independently-maintained implementations actually agree,
 *      not to let production code depend on it.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueSessionId, verifySessionId } from "../../../src/plugins/api-gateway/src/session.js";
import {
  resolveUserId,
  verifySignedSessionId,
} from "../../../src/plugins/wiki/src/session-identity.js";

const SECRET = "a-sufficiently-long-test-secret-value-for-wiki";

describe("verifySignedSessionId", () => {
  it("round-trips a value it signs itself via the same HMAC-SHA256 scheme", () => {
    const id = "some-random-session-id";
    const signature = createHmac("sha256", SECRET).update(id).digest("base64url");
    const signedValue = `${id}.${signature}`;

    expect(verifySignedSessionId(signedValue, SECRET)).toBe(id);
  });

  it("rejects a value with no separator", () => {
    expect(verifySignedSessionId("not-a-signed-value", SECRET)).toBeUndefined();
  });

  it("rejects a value with an empty id (separator at index 0)", () => {
    expect(verifySignedSessionId(".signature", SECRET)).toBeUndefined();
  });

  it("rejects a value with an empty signature (trailing separator)", () => {
    expect(verifySignedSessionId("some-id.", SECRET)).toBeUndefined();
  });

  it("rejects a tampered signature", () => {
    const id = "some-random-session-id";
    const signature = createHmac("sha256", SECRET).update(id).digest("base64url");
    const tampered = `${id}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;

    expect(verifySignedSessionId(tampered, SECRET)).toBeUndefined();
  });

  it("rejects a value signed under a different secret", () => {
    const id = "some-random-session-id";
    const signature = createHmac("sha256", SECRET).update(id).digest("base64url");
    const signedValue = `${id}.${signature}`;

    expect(
      verifySignedSessionId(signedValue, "a-completely-different-secret-value"),
    ).toBeUndefined();
  });
});

describe("resolveUserId", () => {
  const config = { SESSION_SECRET: SECRET, SESSION_COOKIE_NAME: "sid" };

  it("resolves the bare session id from a request carrying a valid signed cookie", () => {
    const id = "resolved-user-id";
    const signature = createHmac("sha256", SECRET).update(id).digest("base64url");
    const request = { cookies: { sid: `${id}.${signature}` } };

    expect(resolveUserId(request, config)).toBe(id);
  });

  it("returns undefined when the request carries no cookies at all", () => {
    expect(resolveUserId({}, config)).toBeUndefined();
  });

  it("returns undefined when the configured cookie name is absent", () => {
    expect(resolveUserId({ cookies: { other: "value" } }, config)).toBeUndefined();
  });

  it("returns undefined for a tampered cookie value", () => {
    const request = { cookies: { sid: "forged.signature" } };
    expect(resolveUserId(request, config)).toBeUndefined();
  });
});

describe("cross-plugin equivalence with api-gateway/src/session.ts (the property this module's design depends on)", () => {
  it("verifies a value issued by api-gateway's real issueSessionId, recovering the exact same id", () => {
    const signedValue = issueSessionId(SECRET);
    // api-gateway's own verifySessionId can decode it (sanity check the
    // fixture itself is well-formed)...
    const expectedId = verifySessionId(signedValue, SECRET);
    expect(expectedId).toBeDefined();

    // ...and wiki's independently-implemented verifySignedSessionId
    // recovers the exact same id from the exact same value.
    expect(verifySignedSessionId(signedValue, SECRET)).toBe(expectedId);
  });

  it("agrees with api-gateway's own verifySessionId on a tampered value too — both reject it", () => {
    const signedValue = issueSessionId(SECRET);
    const tampered = `${signedValue.slice(0, -1)}${signedValue.endsWith("A") ? "B" : "A"}`;

    expect(verifySessionId(tampered, SECRET)).toBeUndefined();
    expect(verifySignedSessionId(tampered, SECRET)).toBeUndefined();
  });
});

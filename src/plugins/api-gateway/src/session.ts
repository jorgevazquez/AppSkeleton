/**
 * Session/cookie handling with secure defaults (feature #63).
 *
 * spec.md's Security Baseline: "CSRF protection on state-changing routes,
 * secure session cookies (`HttpOnly`, `Secure`, `SameSite=Lax` by
 * default)." This module delivers the session-cookie half of that
 * sentence (CSRF itself is feature #64):
 *
 *   1. {@link registerSessionCookies} wires `@fastify/cookie` onto the
 *      api-gateway-owned Fastify instance with `parseOptions` — httpOnly,
 *      secure (config-driven via `SessionConfig.COOKIE_SECURE`), sameSite
 *      "lax" — so every `reply.setCookie()` call gets those three flags
 *      *by default*, without every call site having to repeat them. A call
 *      site may still override any individual flag explicitly (e.g. a
 *      route that genuinely needs a non-HttpOnly cookie), but the *default*
 *      is secure, matching this codebase's "secure by default, explicit
 *      opt-out" convention (see `session-config.ts`'s docs on
 *      `COOKIE_SECURE`, and `database-mysql/src/config.ts`'s
 *      `DB_SSL_REJECT_UNAUTHORIZED` for the same pattern elsewhere).
 *
 *   2. {@link issueSessionId} / {@link verifySessionId} are a standalone,
 *      signed session-identifier issuance/verification helper, independent
 *      of any particular cookie call site — see their own docs for why this
 *      is a small hand-rolled HMAC rather than `@fastify/cookie`'s built-in
 *      `signed: true` option.
 *
 *   3. {@link issueSessionCookie} / {@link readSessionId} glue (1) and (2)
 *      together: set a signed session id as a cookie with the secure
 *      defaults, and read/verify one back off an incoming request,
 *      rejecting (returning `undefined` for) anything that fails signature
 *      verification — a tampered cookie is never treated as a valid
 *      session.
 *
 * ## Why a hand-rolled signed session id, not `@fastify/cookie`'s `secret`/`signed` option
 *
 * `@fastify/cookie` supports signing cookie values itself (a `secret` passed
 * at registration, then `signed: true` per `setCookie()`/`unsignCookie()`
 * call) via the `cookie-signature` package. That would work too, but this
 * feature's step 2 explicitly asks for "a signed session identifier
 * issuance/verification helper" as its own unit — a small, dependency-free
 * `node:crypto` HMAC-SHA256 implementation here is trivially unit-testable
 * in isolation (no Fastify instance required, see
 * `tests/plugins/api-gateway/session.test.ts`), keeps the exact signature
 * format (`<id>.<base64url signature>`) explicit and owned by this
 * codebase rather than an implementation detail of a dependency, and uses
 * `node:crypto`'s `timingSafeEqual` explicitly to guard against
 * timing-based signature-guessing attacks — worth calling out directly
 * rather than trusting it's how the dependency happens to be implemented
 * internally.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import cookiePlugin from "@fastify/cookie";
import type { ApiGatewayApp } from "../index.js";
import type { CookieConfig, SessionConfig } from "./session-config.js";

/** Number of random bytes in a freshly issued session id (before signing). 256 bits — well beyond brute-force range. */
const SESSION_ID_BYTES = 32;

function sign(id: string, secret: string): string {
  return createHmac("sha256", secret).update(id).digest("base64url");
}

/**
 * Constant-time comparison of two signatures. Returns `false` (never
 * throws) if the inputs aren't even the same length — `timingSafeEqual`
 * itself throws on a length mismatch, which would otherwise leak length
 * information via which code path threw.
 */
function signaturesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

/** A freshly generated session id alongside its signed cookie-ready form — see {@link generateSignedSessionId}. */
interface SignedSessionId {
  /** The bare, unsigned session id — the value to key server-side session state by. */
  readonly id: string;
  /** `<id>.<signature>` — the value that actually goes in the cookie. */
  readonly signedValue: string;
}

/** Generate a fresh, cryptographically random session id and sign it with `secret`. Shared by {@link issueSessionId} and {@link issueSessionCookie} so the id-generation + signing logic exists in exactly one place. */
function generateSignedSessionId(secret: string): SignedSessionId {
  const id = randomBytes(SESSION_ID_BYTES).toString("base64url");
  return { id, signedValue: `${id}.${sign(id, secret)}` };
}

/**
 * Issue a fresh, cryptographically random session id, signed with `secret`.
 * The returned string is what actually gets stored in the cookie —
 * `<random id>.<hmac-sha256 signature, base64url>` — never the bare
 * unsigned id.
 */
export function issueSessionId(secret: string): string {
  return generateSignedSessionId(secret).signedValue;
}

/**
 * Verify a signed session id previously produced by {@link issueSessionId}.
 * Returns the bare (unsigned) session id on success, or `undefined` if
 * `signedValue` is malformed or its signature doesn't match — i.e. a
 * tampered, forged, or corrupted cookie value is always rejected, never
 * silently accepted with a wrong/partial id.
 */
export function verifySessionId(signedValue: string, secret: string): string | undefined {
  const separatorIndex = signedValue.lastIndexOf(".");
  if (separatorIndex <= 0 || separatorIndex === signedValue.length - 1) {
    return undefined;
  }

  const id = signedValue.slice(0, separatorIndex);
  const signature = signedValue.slice(separatorIndex + 1);
  const expectedSignature = sign(id, secret);

  return signaturesMatch(signature, expectedSignature) ? id : undefined;
}

/**
 * Wire `@fastify/cookie` onto `app` with secure-by-default `parseOptions`
 * (step 1): `httpOnly: true`, `secure: config.COOKIE_SECURE`, `sameSite:
 * "lax"`. `@fastify/cookie` merges `parseOptions` in as the *default*
 * options object for every `reply.setCookie()` call that doesn't override a
 * given key (see its own `index.js`: `Object.assign({}, options.parseOptions,
 * cookieOptions)`) — so `issueSessionCookie` below (and any future call
 * site) gets these three flags for free without repeating them, while still
 * being able to override any individual one explicitly if a route genuinely
 * needs to.
 *
 * Must be called once, before any route that reads `request.cookies` or
 * calls `reply.setCookie()` is registered — mirrors `../index.ts`'s own
 * `registerErrorHandling(built)` being wired before `/health`. Deliberately
 * synchronous (not awaited): Fastify's own plugin registration is queued
 * internally (via avvio) and only actually runs once the instance boots
 * (`.ready()`/`.listen()`/`.inject()`), so `buildApp()` in `../index.ts` can
 * call this the same way it calls the rest of its own synchronous setup,
 * exactly like `app.register()` is documented to be chainable/fire-and-forget
 * at registration time.
 *
 * Takes only {@link CookieConfig} (just `COOKIE_SECURE`), not the full
 * {@link SessionConfig} — see `session-config.ts`'s module docs on why
 * `buildApp()` can wire this in unconditionally at boot without requiring
 * `SESSION_SECRET` to be configured yet. A full `SessionConfig` satisfies
 * this parameter too (structurally a superset), so a caller that already
 * has one on hand (e.g. this module's own tests) can pass it directly.
 */
export function registerSessionCookies(app: ApiGatewayApp, config: CookieConfig): void {
  void app.register(cookiePlugin, {
    parseOptions: {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: "lax",
    },
  });
}

/**
 * Issue a brand-new signed session id and set it as the session cookie on
 * `reply`, using `config.SESSION_COOKIE_NAME` and the secure defaults
 * {@link registerSessionCookies} already wired in as `parseOptions`.
 * Returns the bare (unsigned) session id — the value a caller should
 * actually use to key server-side session state, since the signed cookie
 * value itself is an implementation detail of the cookie's tamper-evidence,
 * not a meaningful session key on its own.
 */
export function issueSessionCookie(
  reply: { setCookie: (name: string, value: string, options?: Record<string, unknown>) => void },
  config: SessionConfig,
): string {
  const { id, signedValue } = generateSignedSessionId(config.SESSION_SECRET);
  reply.setCookie(config.SESSION_COOKIE_NAME, signedValue);
  return id;
}

/**
 * Read and verify the session cookie off an incoming request (relies on
 * `@fastify/cookie`'s `onRequest` hook having already populated
 * `request.cookies` — see {@link registerSessionCookies}'s docs on
 * registration order). Returns the bare session id on success, or
 * `undefined` if the cookie is absent, malformed, or its signature doesn't
 * match `config.SESSION_SECRET` (i.e. it was tampered with or signed under
 * a different secret) — a tampered cookie is always rejected, never treated
 * as identifying a valid session.
 */
export function readSessionId(
  request: { cookies?: Record<string, string | undefined> },
  config: SessionConfig,
): string | undefined {
  const raw = request.cookies?.[config.SESSION_COOKIE_NAME];
  if (raw === undefined) {
    return undefined;
  }
  return verifySessionId(raw, config.SESSION_SECRET);
}

/**
 * CSRF protection for state-changing routes (feature #64), completing
 * spec.md's Security Baseline sentence feature #63 started: "CSRF
 * protection on state-changing routes, secure session cookies (HttpOnly,
 * Secure, SameSite=Lax by default)."
 *
 * ## Scheme: double-submit cookie
 *
 * {@link registerCsrfProtection} wires a single `preHandler` hook onto the
 * api-gateway-owned Fastify instance implementing the classic
 * double-submit-cookie pattern:
 *
 *   1. **Issue** — on every request that doesn't already carry one, a
 *      random `csrf_token` cookie is set. Unlike the session cookie
 *      (`./session.ts`, `httpOnly: true`), this cookie is deliberately
 *      **not** `HttpOnly` — same-origin JavaScript must be able to read it
 *      (`document.cookie`) in order to echo it back.
 *   2. **Verify** — on a state-changing request (anything outside
 *      {@link CSRF_SAFE_METHODS}), the `x-csrf-token` request header must be
 *      present and match the `csrf_token` cookie value, compared in
 *      constant time. A cross-origin attacker can neither read the victim's
 *      `csrf_token` cookie (Same-Origin Policy) nor set an arbitrary custom
 *      header on a cross-origin form/navigation-driven request, so a forged
 *      request can never present a header that matches — while a same-origin
 *      client that legitimately read the cookie always can.
 *
 * A mismatched or missing token throws {@link CsrfError} (403), which the
 * uniform error envelope (`./error-handler.ts`, feature #60/#61) already
 * serializes to the standard `{code, message, details}` shape — no special
 * handling needed here beyond throwing the right `AppError` subclass.
 *
 * ## Why a `preHandler` hook, not `onRequest`
 *
 * `@fastify/cookie` (wired by `./session.ts`'s `registerSessionCookies`)
 * populates `request.cookies` via its own `onRequest` hook. Fastify's hook
 * lifecycle guarantees every `onRequest` hook across the whole instance
 * completes before any `preHandler` hook starts — regardless of which of
 * the two (`registerSessionCookies`'s `app.register(cookiePlugin, ...)` vs.
 * this module's `app.addHook(...)`) was called first in `../index.ts`'s
 * `buildApp()`. Using `preHandler` here sidesteps having to reason about
 * `register()`'s deferred (avvio-queued) execution order relative to a
 * directly-added hook at all.
 *
 * `preHandler` also runs only for a request that actually matched a route
 * (after routing, unlike `onRequest`), which is exactly when
 * `request.routeOptions.config` — how a route opts out, see below — is
 * populated and available to read.
 *
 * ## Opt-out (step 2)
 *
 * A route registered via `registerRoute()` (`./route-capability.ts`) with a
 * `csrfExempt` option is skipped by this hook entirely — no cookie is
 * issued and no token is verified — for routes that are safe by
 * construction regardless of CSRF (spec.md's example: "pure JSON APIs with
 * strict CORS + no cookies", i.e. nothing an ambient browser credential
 * could ride along on). `route-capability.ts` requires a real, audited
 * `reason` string before it will register such a route at all, and logs a
 * warn-level line recording the opt-out — see that module's docs.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { CsrfError } from "../../../core/errors.js";
import type { ApiGatewayApp } from "../index.js";

/**
 * Extends Fastify's own route-config extension point (the same one
 * `@fastify/cookie` and every other first-party Fastify plugin uses to add
 * typed fields to `request.routeOptions.config`) so `csrfExempt` is properly
 * typed wherever a route's config is read or written, without a manual cast
 * at either call site (`./route-capability.ts` writing it,
 * {@link registerCsrfProtection}'s hook reading it).
 */
declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * Set (only ever to `true`) by `registerRoute()`'s `csrfExempt` option
     * — see `./route-capability.ts`. When present, {@link registerCsrfProtection}'s
     * hook skips this route entirely: no `csrf_token` cookie is issued on
     * its behalf and no token is verified, regardless of HTTP method.
     */
    csrfExempt?: boolean;
  }
}

/** The cookie {@link registerCsrfProtection} issues and reads. Deliberately not `HttpOnly` — same-origin JS must be able to read it to echo it back as a header. */
export const CSRF_COOKIE_NAME = "csrf_token";

/** The request header a state-changing request must echo the {@link CSRF_COOKIE_NAME} cookie's value back in. Always read lower-case, matching Node's own header-name normalization. */
export const CSRF_HEADER_NAME = "x-csrf-token";

/** Number of random bytes in a freshly generated CSRF token (before base64url-encoding). 256 bits — well beyond brute-force/guessing range. */
const CSRF_TOKEN_BYTES = 32;

/**
 * HTTP methods considered "safe" (never state-changing) per RFC 9110 §9.2.1
 * — exempt from the *verification* half of double-submit-cookie by
 * construction (they still get a {@link CSRF_COOKIE_NAME} cookie issued if
 * missing, so a client has a token on hand before it ever needs one).
 */
const CSRF_SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** Generate a fresh, cryptographically random CSRF token. Exported so tests (and, if ever needed, a route that wants to hand out a token explicitly) don't have to duplicate the byte length / encoding choice. */
export function generateCsrfToken(): string {
  return randomBytes(CSRF_TOKEN_BYTES).toString("base64url");
}

/**
 * Constant-time comparison of two token strings. Returns `false` (never
 * throws) on a length mismatch — `timingSafeEqual` itself throws in that
 * case, which would otherwise leak length information via which code path
 * threw. Mirrors `./session.ts`'s identical `signaturesMatch` helper.
 */
function tokensMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

/** Read a single header value off `request.headers`, collapsing Fastify/Node's `string | string[] | undefined` shape (a header may legally be repeated) down to its first occurrence. */
function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Wire double-submit-cookie CSRF protection onto `app` (step 1 — applied to
 * every route by default). Must be called once, before any route that
 * should be protected is registered — mirrors `../index.ts`'s own ordering
 * for `registerErrorHandling`/`registerSessionCookies` — though see this
 * module's docs on why relative-to-`registerSessionCookies` ordering
 * specifically does not matter here (`preHandler` vs. `onRequest`).
 */
export function registerCsrfProtection(app: ApiGatewayApp): void {
  app.addHook("preHandler", async (request, reply) => {
    if (request.routeOptions.config?.csrfExempt === true) {
      return;
    }

    const existingToken = request.cookies?.[CSRF_COOKIE_NAME];
    const token = existingToken ?? generateCsrfToken();
    if (existingToken === undefined) {
      // Not HttpOnly — this is the one cookie in this codebase same-origin
      // JS is expected to read (see module docs). `secure`/`sameSite` still
      // inherit the secure defaults `registerSessionCookies` wired as this
      // instance's `parseOptions` (feature #63).
      reply.setCookie(CSRF_COOKIE_NAME, token, { httpOnly: false });
    }

    if (CSRF_SAFE_METHODS.has(request.method.toUpperCase())) {
      return;
    }

    const presentedToken = firstHeaderValue(request.headers[CSRF_HEADER_NAME]);

    if (presentedToken === undefined || !tokensMatch(presentedToken, token)) {
      throw new CsrfError(
        `CSRF validation failed for ${request.method} ${request.url}: ` +
          (presentedToken === undefined
            ? `no "${CSRF_HEADER_NAME}" request header was presented.`
            : `the "${CSRF_HEADER_NAME}" request header did not match the "${CSRF_COOKIE_NAME}" cookie.`),
      );
    }
  });
}

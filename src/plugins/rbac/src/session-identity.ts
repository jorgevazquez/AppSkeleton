/**
 * Resolve a caller's identity (the `callerId` `rbac:manage`'s operations
 * expect — see `./manage.ts`'s `RbacManagementApi`) from the session cookie
 * api-gateway's own `session.ts` (feature #63) issues at login — needed by
 * feature #44's HTTP routes, which must know *who* is asking before
 * delegating to the already-self-referentially-authorized `rbac:manage`
 * capability (`./manage.ts`'s own `assertCanManage`).
 *
 * ## Why this duplicates api-gateway's `session.ts`/`session-config.ts`
 * instead of importing them
 *
 * `docs/plugin-conventions.md` section 5: "No plugin imports another
 * plugin's internals directly — only via kernel-brokered capabilities."
 * Reading/verifying a session cookie is not itself exposed as a broker
 * capability (only `rbac:check`/`db:query`/`render:template`/`http:route`
 * are) — session-identity resolution is a small enough, self-contained
 * piece of logic that this codebase's established convention is to
 * duplicate it locally with a doc comment explaining why, rather than reach
 * across the plugin boundary — exactly the same tradeoff the `wiki` plugin's
 * own `src/session-identity.ts` (feature #94) already made and documented,
 * this module is a byte-for-byte sibling of that one, scoped to this
 * plugin's own HTTP routes instead. The two plugins deliberately agree only
 * on the *format* — an HMAC-SHA256-signed `<id>.<signature>` cookie value
 * keyed by `SESSION_SECRET` — never on shared runtime code; this module's
 * {@link verifySignedSessionId} must therefore compute byte-identical output
 * to `session.ts`'s own `verifySessionId` for the exact same input, so that
 * a role assigned (via `rbac:manage`) to the `userId` a real login flow
 * issued is recognized here too.
 *
 * `SESSION_SECRET`/`SESSION_COOKIE_NAME` are loaded independently here via
 * the shared kernel `loadConfig()` engine (`core/config.ts` — kernel code,
 * not another plugin's internals, so importing it is fine per section 5) —
 * the same "each plugin loads its own config off the same shared engine"
 * pattern `rate-limit-config.ts`/`security-headers-config.ts`/`session-
 * config.ts`/wiki's own `session-identity.ts` themselves already establish;
 * every plugin reads the exact same `SESSION_SECRET`/`SESSION_COOKIE_NAME`
 * environment variables, so they all agree on a running deployment's actual
 * session cookie without any of them importing another's internals.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { loadConfig, type LoadConfigOptions } from "../../../core/config.js";

/** The subset of api-gateway's own `SessionConfig` (`session-config.ts`) this module needs to verify (not issue) a session cookie: no `COOKIE_SECURE`, since this module never sets one. */
export const SessionIdentityConfigSchema = z.object({
  SESSION_SECRET: z
    .string()
    .min(16, "must be at least 16 characters — use a long random string, not a guessable value"),
  SESSION_COOKIE_NAME: z.string().min(1, "must not be empty").default("sid"),
});

export type SessionIdentityConfig = z.infer<typeof SessionIdentityConfigSchema>;

/** Load and validate this module's session-identity config. Mirrors `session-config.ts`'s `loadSessionConfig` — called on demand by whichever route handler actually needs to resolve a caller's identity, never unconditionally at plugin-enable time (a deployment that registers no rbac management route never needs `SESSION_SECRET` configured at all). */
export function loadSessionIdentityConfig(
  options: Omit<LoadConfigOptions<typeof SessionIdentityConfigSchema.shape>, "schema"> = {},
): SessionIdentityConfig {
  return loadConfig({ schema: SessionIdentityConfigSchema, ...options });
}

/** HMAC-SHA256 of `id` under `secret`, base64url-encoded — must match `api-gateway/src/session.ts`'s own `sign()` exactly (see this module's docs). */
function sign(id: string, secret: string): string {
  return createHmac("sha256", secret).update(id).digest("base64url");
}

/** Constant-time signature comparison — see `session.ts`'s identical `signaturesMatch` for why (`timingSafeEqual` itself throws on a length mismatch, which would otherwise leak length information via which code path threw). */
function signaturesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

/**
 * Verify a `<id>.<signature>` session cookie value previously issued by
 * `api-gateway/src/session.ts`'s `issueSessionId`/`issueSessionCookie`.
 * Returns the bare (unsigned) session id on success, or `undefined` if
 * `signedValue` is malformed or its signature doesn't match — a tampered,
 * forged, or corrupted cookie value is always rejected, never silently
 * accepted with a wrong/partial id. Byte-for-byte equivalent to
 * `session.ts`'s own `verifySessionId` — see this module's docs.
 */
export function verifySignedSessionId(signedValue: string, secret: string): string | undefined {
  const separatorIndex = signedValue.lastIndexOf(".");
  if (separatorIndex <= 0 || separatorIndex === signedValue.length - 1) {
    return undefined;
  }

  const id = signedValue.slice(0, separatorIndex);
  const signature = signedValue.slice(separatorIndex + 1);
  const expectedSignature = sign(id, secret);

  return signaturesMatch(signature, expectedSignature) ? id : undefined;
}

/** A `{ cookies }`-shaped request — enough to resolve identity, satisfied structurally by a real Fastify request (`@fastify/cookie`'s `onRequest` hook, wired by api-gateway's own `registerSessionCookies`, populates `request.cookies` before any route handler runs). */
export interface RequestWithCookies {
  readonly cookies?: Record<string, string | undefined>;
}

/**
 * Resolve the calling user's identity from `request`'s session cookie —
 * `undefined` means "no valid session" (absent, malformed, or a signature
 * that doesn't match `config.SESSION_SECRET`). Byte-for-byte equivalent to
 * `session.ts`'s own `readSessionId` — see this module's docs.
 */
export function resolveUserId(
  request: RequestWithCookies,
  config: SessionIdentityConfig,
): string | undefined {
  const raw = request.cookies?.[config.SESSION_COOKIE_NAME];
  if (raw === undefined) {
    return undefined;
  }
  return verifySignedSessionId(raw, config.SESSION_SECRET);
}

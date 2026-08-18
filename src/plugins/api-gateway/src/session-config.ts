/**
 * Zod-validated configuration for api-gateway's session/cookie handling
 * (feature #63 — "Session/cookie handling with secure defaults").
 *
 * Reuses the kernel's generic layered engine (`src/core/config.ts`'s
 * `loadConfig()`: defaults -> env -> optional operator override file), the
 * same way `database-mysql`'s `src/config.ts` does — see that module's docs
 * for the full precedence explanation.
 *
 * Fields:
 *   - `SESSION_SECRET` — the HMAC key `session.ts` signs/verifies session
 *     identifiers with (see its module docs). Deliberately has NO default —
 *     per spec.md's security baseline ("secrets only from environment/.env,
 *     never hard-coded"), a missing secret must fail fast rather than
 *     silently signing every session with a guessable, checked-in value.
 *     Required to be at least 16 characters so a trivially short secret
 *     (e.g. "x") can't slip through validation, though operators should use
 *     a much longer random string in practice — see `.env.example`'s own
 *     "change-me-to-a-long-random-string" placeholder.
 *   - `COOKIE_SECURE` — whether the session cookie's `Secure` attribute is
 *     set (spec.md: "secure session cookies (HttpOnly, Secure, SameSite=Lax
 *     by default)"). Config-driven rather than hard-coded `true` because a
 *     `Secure` cookie is silently dropped by browsers over plain HTTP —
 *     which local development typically is — so operators need an explicit
 *     escape hatch (`.env.example` ships `COOKIE_SECURE=false` for exactly
 *     that reason) while still defaulting to the secure `true` value in any
 *     environment that doesn't override it, matching "secure by default,
 *     explicit opt-out" everywhere else in this codebase (see
 *     `database-mysql/src/config.ts`'s `DB_SSL_REJECT_UNAUTHORIZED`).
 *   - `SESSION_COOKIE_NAME` — the cookie name the session id is stored
 *     under. Defaults to `sid`.
 *
 * Two schemas, two call sites:
 *   - {@link CookieConfigSchema}/{@link loadCookieConfig} cover only
 *     `COOKIE_SECURE`, which has a safe default and is never a secret —
 *     `../index.ts`'s `buildApp()` loads this unconditionally at boot to
 *     wire `@fastify/cookie`'s defaults (step 1), so mounting the Fastify
 *     instance never depends on an operator having configured
 *     `SESSION_SECRET` yet.
 *   - {@link SessionConfigSchema}/{@link loadSessionConfig} cover the full
 *     set, including the required `SESSION_SECRET` — loaded on demand by
 *     whichever route handler actually needs to issue or verify a signed
 *     session id (`session.ts`'s `issueSessionCookie()`/`readSessionId()`),
 *     not at boot. This keeps "the server can start" independent from "an
 *     operator has configured a session secret", the same way
 *     `database-mysql`'s `DB_*` config is only ever loaded by that plugin's
 *     own `onEnable`, never by the kernel bootstrap itself.
 */
import { z } from "zod";
import { loadConfig, type LoadConfigOptions } from "../../../core/config.js";

/**
 * Accepts a real boolean (e.g. from a defaults object or JSON override
 * file) or the literal strings "true"/"false" (env vars are always
 * strings). Deliberately NOT `z.coerce.boolean()`, whose `Boolean(value)`
 * coercion would treat the string "false" as truthy — mirrors
 * `database-mysql/src/config.ts`'s identical `booleanFromEnv` helper.
 */
const booleanFromEnv = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => (typeof value === "boolean" ? value : value === "true"));

export const CookieConfigSchema = z.object({
  COOKIE_SECURE: booleanFromEnv.default(true),
});

export type CookieConfig = z.infer<typeof CookieConfigSchema>;

/**
 * Load and validate just the cookie-serialization half of api-gateway's
 * config — safe to call unconditionally at boot (see module docs): with no
 * `COOKIE_SECURE` set at all, this resolves to the secure `true` default
 * rather than throwing.
 */
export function loadCookieConfig(
  options: Omit<LoadConfigOptions<typeof CookieConfigSchema.shape>, "schema"> = {},
): CookieConfig {
  return loadConfig({ schema: CookieConfigSchema, ...options });
}

export const SessionConfigSchema = z.object({
  SESSION_SECRET: z
    .string()
    .min(16, "must be at least 16 characters — use a long random string, not a guessable value"),
  COOKIE_SECURE: booleanFromEnv.default(true),
  SESSION_COOKIE_NAME: z.string().min(1, "must not be empty").default("sid"),
});

export type SessionConfig = z.infer<typeof SessionConfigSchema>;

/**
 * Load and validate api-gateway's full session config. Throws a
 * {@link ConfigError} (via `loadConfig()`) with a human-readable message
 * naming the offending field(s) when `SESSION_SECRET` is missing/too short
 * or `COOKIE_SECURE`/`SESSION_COOKIE_NAME` are malformed. Call this only
 * where a session id is actually about to be issued/verified — never
 * unconditionally at boot (see module docs).
 */
export function loadSessionConfig(
  options: Omit<LoadConfigOptions<typeof SessionConfigSchema.shape>, "schema"> = {},
): SessionConfig {
  return loadConfig({ schema: SessionConfigSchema, ...options });
}

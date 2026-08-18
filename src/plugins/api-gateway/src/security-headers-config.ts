/**
 * Zod-validated configuration for api-gateway's security headers (feature
 * #67 — "Security headers (CSP, HSTS, X-Frame-Options, etc.) via helmet").
 *
 * Reuses the kernel's generic layered engine (`src/core/config.ts`'s
 * `loadConfig()`: defaults -> env -> optional operator override file), the
 * same way `rate-limit-config.ts`/`session-config.ts` do — see those
 * modules' docs for the full precedence explanation.
 *
 * Fields:
 *   - `HELMET_ENABLED` — master on/off switch for the whole
 *     `@fastify/helmet` registration (`security-headers.ts`'s
 *     `registerSecurityHeaders()`). Defaults to `true`; the escape hatch
 *     exists for a deployment that terminates TLS and sets its own security
 *     headers at a reverse proxy/CDN layer in front of this process, where
 *     duplicate headers would be noise rather than useful — mirrors
 *     `session-config.ts`'s `COOKIE_SECURE` "secure by default, explicit
 *     opt-out" posture.
 *   - `HELMET_CSP_ENABLED` — whether the Content-Security-Policy header is
 *     set. Defaults to `true` (helmet's own sensible default directives —
 *     `default-src 'self'` etc.). Separately toggleable from the rest of
 *     helmet's headers because a strict default CSP is the header most
 *     likely to break a specific deployment's inline scripts/styles or
 *     third-party embeds before that deployment has had a chance to tune
 *     its own directives — an operator can turn CSP off without losing
 *     HSTS/X-Frame-Options/nosniff/etc.
 *   - `HELMET_HSTS_ENABLED` — whether Strict-Transport-Security is set.
 *     Defaults to `true`. HSTS only makes sense once a deployment actually
 *     terminates TLS; local development over plain HTTP is the main reason
 *     an operator would need this off (browsers ignore the header over
 *     plain HTTP in practice, but sending it at all is misleading during
 *     local debugging) — mirrors `COOKIE_SECURE`'s same dev-vs-prod
 *     rationale.
 *   - `HELMET_HSTS_MAX_AGE` — the `max-age` (in seconds) HSTS advertises.
 *     Defaults to 15552000 (180 days), matching both `helmet`'s own default
 *     and `.env.example`.
 *
 * All four are safe to load unconditionally at boot (like
 * `RateLimitConfigSchema`, unlike `SessionConfigSchema`'s required
 * `SESSION_SECRET`) — a deployment with none of these vars set still boots
 * with a secure-by-default header policy rather than failing fast.
 */
import { z } from "zod";
import { loadConfig, type LoadConfigOptions } from "../../../core/config.js";

/**
 * Accepts a real boolean (e.g. from a defaults object or JSON override
 * file) or the literal strings "true"/"false" (env vars are always
 * strings). Deliberately NOT `z.coerce.boolean()`, whose `Boolean(value)`
 * coercion would treat the string "false" as truthy — mirrors
 * `session-config.ts`'s identical `booleanFromEnv` helper.
 */
const booleanFromEnv = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => (typeof value === "boolean" ? value : value === "true"));

export const SecurityHeadersConfigSchema = z.object({
  HELMET_ENABLED: booleanFromEnv.default(true),
  HELMET_CSP_ENABLED: booleanFromEnv.default(true),
  HELMET_HSTS_ENABLED: booleanFromEnv.default(true),
  HELMET_HSTS_MAX_AGE: z.coerce
    .number()
    .int("must be an integer")
    .nonnegative("must be a non-negative number of seconds")
    .default(15552000),
});

export type SecurityHeadersConfig = z.infer<typeof SecurityHeadersConfigSchema>;

/**
 * Load and validate api-gateway's security-headers config. Throws a
 * {@link ConfigError} (via `loadConfig()`) with a human-readable message
 * naming the offending field(s) when any of these are set but malformed.
 * Call this once at boot, before `registerSecurityHeaders()` — mirrors
 * `loadRateLimitConfig()`'s call site in `../index.ts`'s `buildApp()`.
 */
export function loadSecurityHeadersConfig(
  options: Omit<LoadConfigOptions<typeof SecurityHeadersConfigSchema.shape>, "schema"> = {},
): SecurityHeadersConfig {
  return loadConfig({ schema: SecurityHeadersConfigSchema, ...options });
}

/**
 * Zod-validated configuration for api-gateway's global rate-limit defaults
 * (feature #66 — "Configurable rate limiting (global and per-route)").
 *
 * Reuses the kernel's generic layered engine (`src/core/config.ts`'s
 * `loadConfig()`: defaults -> env -> optional operator override file), the
 * same way `session-config.ts`'s `loadCookieConfig`/`loadSessionConfig` do —
 * see that module's docs for the full precedence explanation.
 *
 * Fields:
 *   - `RATE_LIMIT_MAX` — the global maximum number of requests a single
 *     client (keyed by `req.ip` — `@fastify/rate-limit`'s own default
 *     `keyGenerator`) may make within `RATE_LIMIT_WINDOW_MS`, before every
 *     route that doesn't declare its own stricter `rateLimit` override
 *     (see `route-capability.ts`'s `RegisterRouteOptions.rateLimit`).
 *     Defaults to 100, matching `.env.example`.
 *   - `RATE_LIMIT_WINDOW_MS` — the global sliding time window, in
 *     milliseconds, `RATE_LIMIT_MAX` applies over. Defaults to 60000 (one
 *     minute), matching `.env.example`.
 *
 * Both are safe to load unconditionally at boot (like `CookieConfigSchema`,
 * unlike `SessionConfigSchema`'s required `SESSION_SECRET`) — a deployment
 * with neither var set still boots with sane, documented defaults rather
 * than failing fast, since rate limiting is a defense-in-depth control, not
 * a correctness requirement the way a signed session secret is.
 */
import { z } from "zod";
import { loadConfig, type LoadConfigOptions } from "../../../core/config.js";

export const RateLimitConfigSchema = z.object({
  RATE_LIMIT_MAX: z.coerce
    .number()
    .int("must be an integer")
    .positive("must be a positive number of requests")
    .default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int("must be an integer")
    .positive("must be a positive number of milliseconds")
    .default(60000),
});

export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;

/**
 * Load and validate api-gateway's global rate-limit config. Throws a
 * {@link ConfigError} (via `loadConfig()`) with a human-readable message
 * naming the offending field(s) when `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`
 * are set but malformed (non-numeric, zero, or negative). Call this once
 * at boot, before `registerRateLimiting()` — mirrors `loadCookieConfig()`'s
 * call site in `../index.ts`'s `buildApp()`.
 */
export function loadRateLimitConfig(
  options: Omit<LoadConfigOptions<typeof RateLimitConfigSchema.shape>, "schema"> = {},
): RateLimitConfig {
  return loadConfig({ schema: RateLimitConfigSchema, ...options });
}

/**
 * Zod-validated configuration for api-gateway's request size limit and
 * timeout defaults (feature #71 — "Request size limits and timeout
 * configuration").
 *
 * Reuses the kernel's generic layered engine (`src/core/config.ts`'s
 * `loadConfig()`: defaults -> env -> optional operator override file), the
 * same way `rate-limit-config.ts`/`security-headers-config.ts` do — see
 * those modules' docs for the full precedence explanation.
 *
 * Fields:
 *   - `REQUEST_BODY_LIMIT_BYTES` — the maximum size, in bytes, of an
 *     incoming request body Fastify will buffer before rejecting the
 *     request with a 413 (`FST_ERR_CTP_BODY_TOO_LARGE`) — see
 *     `../index.ts`'s `buildApp()`, which passes this straight through as
 *     Fastify's own `bodyLimit` constructor option. Defaults to 1048576 (1
 *     MiB), matching Fastify's own built-in default, so an unconfigured
 *     deployment behaves exactly as it would have before this feature
 *     existed.
 *   - `REQUEST_TIMEOUT_MS` — the maximum time, in milliseconds, Fastify's
 *     underlying Node HTTP server will wait to receive a complete request
 *     before destroying the socket (Node's own `server.requestTimeout`,
 *     surfaced by Fastify as the `requestTimeout` constructor option).
 *     Defaults to 30000 (30 seconds) — deliberately *not* Fastify's own
 *     upstream default of `0` (disabled), the same "secure by default,
 *     explicit opt-out" posture `cors-config.ts`'s empty-allow-list-by-
 *     default and `security-headers-config.ts`'s `HELMET_ENABLED: true`
 *     already take: an unconfigured deployment should not be trivially
 *     exposed to a slow-request (slowloris-style) resource exhaustion
 *     attack just because Fastify's upstream default happens to be "wait
 *     forever".
 *
 * Both are safe to load unconditionally at boot (like `RateLimitConfigSchema`,
 * unlike `SessionConfigSchema`'s required `SESSION_SECRET`) — a deployment
 * with neither var set still boots with sane, documented defaults rather
 * than failing fast.
 */
import { z } from "zod";
import { loadConfig, type LoadConfigOptions } from "../../../core/config.js";

export const RequestLimitsConfigSchema = z.object({
  REQUEST_BODY_LIMIT_BYTES: z.coerce
    .number()
    .int("must be an integer")
    .positive("must be a positive number of bytes")
    .default(1048576),
  REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int("must be an integer")
    .positive("must be a positive number of milliseconds")
    .default(30000),
});

export type RequestLimitsConfig = z.infer<typeof RequestLimitsConfigSchema>;

/**
 * Load and validate api-gateway's request size limit / timeout config.
 * Throws a {@link ConfigError} (via `loadConfig()`) with a human-readable
 * message naming the offending field(s) when
 * `REQUEST_BODY_LIMIT_BYTES`/`REQUEST_TIMEOUT_MS` are set but malformed
 * (non-numeric, zero, or negative). Call this once at boot, before
 * `Fastify(...)` is constructed — unlike every other `load*Config()` in this
 * plugin, these two values must be known *before* the instance is built
 * (`bodyLimit`/`requestTimeout` are Fastify constructor options, not
 * something a `register*()` call can apply after the fact) — see
 * `../index.ts`'s `buildApp()`.
 */
export function loadRequestLimitsConfig(
  options: Omit<LoadConfigOptions<typeof RequestLimitsConfigSchema.shape>, "schema"> = {},
): RequestLimitsConfig {
  return loadConfig({ schema: RequestLimitsConfigSchema, ...options });
}

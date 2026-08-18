/**
 * Zod-validated configuration for api-gateway's CORS allow-list (feature #68
 * — "Configurable CORS allow-list").
 *
 * Reuses the kernel's generic layered engine (`src/core/config.ts`'s
 * `loadConfig()`: defaults -> env -> optional operator override file), the
 * same way `rate-limit-config.ts`/`security-headers-config.ts` do — see
 * those modules' docs for the full precedence explanation.
 *
 * Fields:
 *   - `CORS_ORIGIN` — a comma-separated list of the exact origins (scheme +
 *     host + port, e.g. `https://app.example.com`) allowed to make
 *     cross-origin requests against this API. Defaults to the empty string,
 *     i.e. an empty allow-list: with nothing configured, every cross-origin
 *     request is unlisted and therefore denied (see `./cors.ts`'s
 *     `registerCors()`) — "deny by default", matching this feature's step
 *     1, rather than `@fastify/cors`'s own upstream default of reflecting
 *     every origin (`origin: true`), which would be an accidental
 *     allow-everything posture for any deployment that forgets to set this.
 *     Same-origin requests and requests with no `Origin` header at all
 *     (curl, server-to-server calls, this project's own `/health` checks)
 *     are unaffected either way — the allow-list only governs the
 *     `Access-Control-Allow-Origin` response header a *browser* consults.
 */
import { z } from "zod";
import { loadConfig, type LoadConfigOptions } from "../../../core/config.js";

/**
 * `CORS_ORIGIN=https://a.example.com,https://b.example.com` (or unset, or
 * empty) -> `["https://a.example.com", "https://b.example.com"]` (or `[]`).
 * Whitespace around a comma and any empty entries (a trailing comma, or the
 * env var left blank) are dropped so a deployment can't accidentally end up
 * with a permissive empty-string / whitespace-only "origin" in the list.
 */
const originAllowList = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  );

export const CorsConfigSchema = z.object({
  CORS_ORIGIN: originAllowList,
});

export type CorsConfig = z.infer<typeof CorsConfigSchema>;

/**
 * Load and validate api-gateway's CORS config. Call this once at boot,
 * before `registerCors()` — mirrors `loadSecurityHeadersConfig()`'s call
 * site in `../index.ts`'s `buildApp()`.
 */
export function loadCorsConfig(
  options: Omit<LoadConfigOptions<typeof CorsConfigSchema.shape>, "schema"> = {},
): CorsConfig {
  return loadConfig({ schema: CorsConfigSchema, ...options });
}

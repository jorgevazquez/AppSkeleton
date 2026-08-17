/**
 * Zod-validated configuration for the database-mysql plugin's MySQL
 * connection pool, sourced from `DB_*` environment variables.
 *
 * Reuses the kernel's generic layered engine (`src/core/config.ts`'s
 * `loadConfig()`: defaults -> env -> optional operator override file) so
 * this plugin gets the same "fail fast with a clear ConfigError, never a
 * raw ZodError" guarantee as `CoreConfigSchema` — see spec.md's "layered
 * config ... validated per-plugin against a zod schema the plugin exports"
 * and its "fail fast, safe defaults everywhere" baseline.
 *
 * Fields:
 *   - `DB_HOST`/`DB_PORT`   — safe to default (127.0.0.1:3306, matching
 *                             docker-compose.yml's local MySQL).
 *   - `DB_USER`/`DB_PASSWORD`/`DB_NAME` — credentials/target database.
 *                             Deliberately have NO default: per spec.md's
 *                             security baseline ("secrets only from
 *                             environment/.env, never hard-coded"), a
 *                             missing credential must fail fast rather
 *                             than silently boot against a guessed value.
 *   - `DB_CONNECTION_LIMIT` — pool size, defaults to 10.
 *   - `DB_SSL`              — "disabled" (default) or "enabled". TLS is
 *                             opt-in: most local/dev setups (including this
 *                             repo's docker-compose MySQL without an
 *                             operator-supplied CA) don't need it.
 *   - `DB_SSL_CA`           — optional PEM-encoded CA certificate content
 *                             to trust, used only when `DB_SSL=enabled`.
 *   - `DB_SSL_REJECT_UNAUTHORIZED` — whether to verify the server's
 *                             certificate against a CA when TLS is
 *                             enabled. Defaults to `true` (secure by
 *                             default); an operator connecting to a
 *                             self-signed server without supplying
 *                             `DB_SSL_CA` must explicitly opt out.
 */
import { z } from "zod";
import { loadConfig, type LoadConfigOptions } from "../../../core/config.js";

/**
 * Accepts a real boolean (e.g. from a defaults object or JSON override
 * file) or the literal strings "true"/"false" (env vars are always
 * strings). Deliberately NOT `z.coerce.boolean()`, whose `Boolean(value)`
 * coercion would treat the string "false" as truthy.
 */
const booleanFromEnv = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => (typeof value === "boolean" ? value : value === "true"));

export const DbConfigSchema = z.object({
  DB_HOST: z.string().min(1, "must not be empty").default("127.0.0.1"),
  DB_PORT: z.coerce.number().int("must be an integer").min(1).max(65535).default(3306),
  DB_USER: z.string().min(1, "must not be empty"),
  DB_PASSWORD: z.string().min(1, "must not be empty"),
  DB_NAME: z.string().min(1, "must not be empty"),
  DB_CONNECTION_LIMIT: z.coerce.number().int("must be an integer").min(1).max(1000).default(10),
  DB_SSL: z.enum(["disabled", "enabled"]).default("disabled"),
  DB_SSL_CA: z.string().min(1, "must not be empty").optional(),
  DB_SSL_REJECT_UNAUTHORIZED: booleanFromEnv.default(true),
});

export type DbConfig = z.infer<typeof DbConfigSchema>;

/**
 * Load and validate the database-mysql plugin's config. Throws a
 * {@link ConfigError} (via `loadConfig()`) with a human-readable message
 * naming the offending field(s) when a required `DB_*` var is missing or
 * malformed — never boots with an incomplete/invalid config.
 */
export function loadDbConfig(
  options: Omit<LoadConfigOptions<typeof DbConfigSchema.shape>, "schema"> = {},
): DbConfig {
  return loadConfig({ schema: DbConfigSchema, ...options });
}

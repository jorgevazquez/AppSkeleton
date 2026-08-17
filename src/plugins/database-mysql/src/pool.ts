/**
 * MySQL connection pool construction for the database-mysql plugin.
 *
 * `createDbPool()` wraps `mysql2/promise`'s `createPool()` (per spec.md's
 * "Database: MySQL 8, accessed via mysql2 (connection pooling, prepared
 * statements)") over an already-validated {@link DbConfig}, with TLS wired
 * in only when `DB_SSL=enabled`. `createDbPoolFromEnv()` is the fail-fast
 * entry point future lifecycle wiring (this plugin's `index.ts`, landing
 * with features #19-21) should call at startup: it validates config via
 * `loadDbConfig()` *before* ever touching mysql2, so a missing/malformed
 * `DB_*` var throws a clear `ConfigError` synchronously instead of the
 * failure surfacing later as an opaque connection error on first query.
 *
 * `mysql2`'s `createPool()` itself never opens a TCP connection eagerly —
 * connections are established lazily on first use — so constructing a pool
 * here does not by itself prove connectivity; that's what an integration
 * test against the docker-compose MySQL instance is for.
 */
import mysql, { type Pool } from "mysql2/promise";
import { loadDbConfig, type DbConfig, type DbConfigSchema } from "./config.js";
import type { LoadConfigOptions } from "../../../core/config.js";

/** Build mysql2's `ssl` pool option from a validated config. `undefined` (no TLS) when disabled. */
function buildSslOptions(config: DbConfig): mysql.PoolOptions["ssl"] {
  if (config.DB_SSL === "disabled") {
    return undefined;
  }
  return {
    rejectUnauthorized: config.DB_SSL_REJECT_UNAUTHORIZED,
    ...(config.DB_SSL_CA !== undefined ? { ca: config.DB_SSL_CA } : {}),
  };
}

/** Construct a mysql2 promise connection pool from an already-validated {@link DbConfig}. */
export function createDbPool(config: DbConfig): Pool {
  const ssl = buildSslOptions(config);
  return mysql.createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    connectionLimit: config.DB_CONNECTION_LIMIT,
    waitForConnections: true,
    ...(ssl !== undefined ? { ssl } : {}),
  });
}

/**
 * Load `DB_*` config (throwing a clear `ConfigError` if it's missing or
 * malformed — see {@link loadDbConfig}) and construct the pool from it in
 * one call. This is the fail-fast entry point: config is validated
 * synchronously before any mysql2 API is touched.
 */
export function createDbPoolFromEnv(
  options: Omit<LoadConfigOptions<typeof DbConfigSchema.shape>, "schema"> = {},
): Pool {
  const config = loadDbConfig(options);
  return createDbPool(config);
}

/**
 * MySQL connection pool construction for the database-mysql plugin.
 *
 * `createDbPool()` wraps `mysql2/promise`'s `createPool()` (per spec.md's
 * "Database: MySQL 8, accessed via mysql2 (connection pooling, prepared
 * statements)") over an already-validated {@link DbConfig}, with TLS wired
 * in only when `DB_SSL=enabled`, and an optional bounded wait queue when
 * `DB_CONFIG.DB_POOL_QUEUE_LIMIT` is set (feature #23 — see config.ts's doc
 * comment on that field). `createDbPoolFromEnv()` is the fail-fast entry
 * point future lifecycle wiring (this plugin's `index.ts`, landing with
 * features #19-21) should call at startup: it validates config via
 * `loadDbConfig()` *before* ever touching mysql2, so a missing/malformed
 * `DB_*` var throws a clear `ConfigError` synchronously instead of the
 * failure surfacing later as an opaque connection error on first query.
 *
 * `mysql2`'s `createPool()` itself never opens a TCP connection eagerly —
 * connections are established lazily on first use — so constructing a pool
 * here does not by itself prove connectivity; that's what
 * {@link connectWithRetry} (feature #23's startup connectivity probe, with
 * exponential backoff over transient failures) and the integration test
 * against the docker-compose MySQL instance are for.
 */
import mysql, { type Pool } from "mysql2/promise";
import { loadDbConfig, type DbConfig, type DbConfigSchema } from "./config.js";
import type { LoadConfigOptions } from "../../../core/config.js";
import { DatabaseError, isAppError } from "../../../core/errors.js";
import { retryWithBackoff, type RetryOptions } from "./resilience.js";

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
    ...(config.DB_POOL_QUEUE_LIMIT !== undefined ? { queueLimit: config.DB_POOL_QUEUE_LIMIT } : {}),
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

/** Human-readable detail from an unknown thrown value, safe to embed in a `DatabaseError`'s internal `message`. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Feature #23's startup connectivity probe: acquire a connection from
 * `pool` and ping it, retrying with exponential backoff (see
 * {@link retryWithBackoff}, default: transient connection errors only —
 * `ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT`/... — up to 4 attempts) so a
 * MySQL instance that is merely still starting up (a fresh
 * `docker compose up`, a rolling restart) doesn't fail the whole kernel
 * boot on the very first attempt. Every acquired connection is always
 * released back to the pool, success or failure.
 *
 * On success, resolves with no value — the pool itself (already
 * constructed by the caller via `createDbPool()`/`createDbPoolFromEnv()`)
 * is what future queries use; this function only *proves* it can reach
 * MySQL, it does not return a connection to the caller.
 *
 * If every attempt fails, throws a {@link DatabaseError} (never mysql2's
 * raw driver exception) naming the number of attempts made, with the last
 * underlying error attached as `cause` for internal diagnostics — intended
 * for a future kernel/plugin bootstrap to call once at startup so a
 * capability consumer downstream never has to distinguish "MySQL never
 * came up" from any other database-mysql failure shape.
 */
export async function connectWithRetry(pool: Pool, options: RetryOptions = {}): Promise<void> {
  try {
    await retryWithBackoff(async () => {
      const connection = await pool.getConnection();
      try {
        await connection.ping();
      } finally {
        connection.release();
      }
    }, options);
  } catch (cause) {
    if (isAppError(cause)) {
      throw cause;
    }
    const attempts = options.retries ?? 4;
    throw new DatabaseError(
      `Could not connect to the database after ${attempts} attempt(s): ${describeError(cause)}`,
      {
        cause,
        publicMessage: "The database is temporarily unavailable. Please try again shortly.",
      },
    );
  }
}

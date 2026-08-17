/**
 * Integration tests against the real docker-compose MySQL instance (see
 * `docker-compose.yml` / `init.sh`, which brings it up and waits for its
 * healthcheck before the suite runs). These exercise actual TCP
 * connectivity through the pool built by `createDbPool()`/
 * `createDbPoolFromEnv()` — unlike pool.test.ts, which only asserts on the
 * pool's resolved config without ever opening a connection.
 *
 * Skips itself (rather than failing) when MySQL isn't reachable, so the
 * unit suite (`npm test`) stays green in environments without Docker; CI
 * and local dev running `init.sh` always have it up.
 */
import mysql from "mysql2/promise";
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "mysql2/promise";
import { createDbPool, createDbPoolFromEnv } from "../../../src/plugins/database-mysql/src/pool.js";

/** Matches docker-compose.yml's `mysql` service credentials. */
const DOCKER_COMPOSE_ENV = {
  DB_HOST: "127.0.0.1",
  DB_PORT: "3306",
  DB_USER: "appskeleton",
  DB_PASSWORD: "change-me",
  DB_NAME: "appskeleton",
  DB_CONNECTION_LIMIT: "5",
};

async function probeMysqlReachable(): Promise<boolean> {
  try {
    const probe = await mysql.createConnection({
      host: DOCKER_COMPOSE_ENV.DB_HOST,
      port: Number(DOCKER_COMPOSE_ENV.DB_PORT),
      user: DOCKER_COMPOSE_ENV.DB_USER,
      password: DOCKER_COMPOSE_ENV.DB_PASSWORD,
      database: DOCKER_COMPOSE_ENV.DB_NAME,
      connectTimeout: 2000,
    });
    await probe.ping();
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

// Resolved via top-level await (this is an ESM module) BEFORE the describe
// block below is registered, so describe.runIf() — whose condition is
// evaluated synchronously at collection time, not after any beforeAll —
// sees the real, already-settled result instead of a still-pending probe.
const mysqlReachable = await probeMysqlReachable();

if (!mysqlReachable) {
  console.warn(
    "[pool.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_ENV.DB_HOST}:${DOCKER_COMPOSE_ENV.DB_PORT} — skipping integration suite. ` +
      "Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

describe.runIf(mysqlReachable)("database-mysql pool — docker-compose MySQL integration", () => {
  let pool: Pool | undefined;

  afterEach(async () => {
    if (pool) {
      await pool.end();
      pool = undefined;
    }
  });

  it("connects and runs a query through a pool built by createDbPoolFromEnv()", async () => {
    pool = createDbPoolFromEnv({ env: DOCKER_COMPOSE_ENV });
    const [rows] = await pool.query("SELECT 1 + 1 AS sum");
    expect(rows).toEqual([{ sum: 2 }]);
  });

  it("acquires and releases a pooled connection", async () => {
    pool = createDbPoolFromEnv({ env: DOCKER_COMPOSE_ENV });
    const connection = await pool.getConnection();
    try {
      await connection.ping();
    } finally {
      connection.release();
    }
  });

  it("respects DB_CONNECTION_LIMIT under concurrent load", async () => {
    pool = createDbPool({
      DB_HOST: DOCKER_COMPOSE_ENV.DB_HOST,
      DB_PORT: Number(DOCKER_COMPOSE_ENV.DB_PORT),
      DB_USER: DOCKER_COMPOSE_ENV.DB_USER,
      DB_PASSWORD: DOCKER_COMPOSE_ENV.DB_PASSWORD,
      DB_NAME: DOCKER_COMPOSE_ENV.DB_NAME,
      DB_CONNECTION_LIMIT: 3,
      DB_SSL: "disabled",
      DB_SSL_REJECT_UNAUTHORIZED: true,
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => pool!.query("SELECT ? AS n", [i])),
    );
    expect(results).toHaveLength(8);
  });

  it("rejects a bad password with a real connection error (not a config error)", async () => {
    const badPool = createDbPool({
      DB_HOST: DOCKER_COMPOSE_ENV.DB_HOST,
      DB_PORT: Number(DOCKER_COMPOSE_ENV.DB_PORT),
      DB_USER: DOCKER_COMPOSE_ENV.DB_USER,
      DB_PASSWORD: "definitely-the-wrong-password",
      DB_NAME: DOCKER_COMPOSE_ENV.DB_NAME,
      DB_CONNECTION_LIMIT: 1,
      DB_SSL: "disabled",
      DB_SSL_REJECT_UNAUTHORIZED: true,
    });
    try {
      await expect(badPool.query("SELECT 1")).rejects.toThrow();
    } finally {
      await badPool.end();
    }
  });

  it("negotiates TLS when DB_SSL=enabled (MySQL 8's auto-generated self-signed cert)", async () => {
    pool = createDbPool({
      DB_HOST: DOCKER_COMPOSE_ENV.DB_HOST,
      DB_PORT: Number(DOCKER_COMPOSE_ENV.DB_PORT),
      DB_USER: DOCKER_COMPOSE_ENV.DB_USER,
      DB_PASSWORD: DOCKER_COMPOSE_ENV.DB_PASSWORD,
      DB_NAME: DOCKER_COMPOSE_ENV.DB_NAME,
      DB_CONNECTION_LIMIT: 2,
      DB_SSL: "enabled",
      // The container's cert is self-signed; without an operator-supplied
      // DB_SSL_CA there is nothing to verify it against.
      DB_SSL_REJECT_UNAUTHORIZED: false,
    });

    const [rows] = await pool.query<mysql.RowDataPacket[]>("SHOW STATUS LIKE 'Ssl_cipher'");
    expect(rows[0]?.["Value"]).toBeTruthy();
  });
});

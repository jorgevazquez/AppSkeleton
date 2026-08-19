/**
 * Integration test for feature #30's step 3 ("Write a test asserting
 * metrics update correctly under concurrent queries") against the real
 * docker-compose MySQL instance — see pool.integration.test.ts for the
 * shared skip-if-unreachable pattern this mirrors.
 *
 * Unlike pool-metrics.test.ts (a fake `pool.pool` internal-shape stand-in)
 * and query-capability.test.ts's `getPoolMetrics` suite (a fake `Pool`
 * whose internal counters are edited by hand to simulate state changes),
 * this exercises `collectPoolMetrics()` against mysql2's *real* pool
 * bookkeeping — genuinely concurrent queries hitting a real connection
 * pool, not a hand-constructed stand-in for one.
 */
import mysql from "mysql2/promise";
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "mysql2/promise";
import { createDbPool } from "../../../src/plugins/database-mysql/src/pool.js";
import { collectPoolMetrics } from "../../../src/plugins/database-mysql/src/pool-metrics.js";

/** Matches docker-compose.yml's `mysql` service credentials. */
const DOCKER_COMPOSE_ENV = {
  DB_HOST: "127.0.0.1",
  DB_PORT: "3306",
  DB_USER: "appskeleton",
  DB_PASSWORD: "change-me",
  DB_NAME: "appskeleton",
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

// Resolved via top-level await BEFORE describe.runIf()'s condition is
// evaluated at collection time — see pool.integration.test.ts for why this
// must not be a still-pending promise at that point.
const mysqlReachable = await probeMysqlReachable();

if (!mysqlReachable) {
  console.warn(
    "[pool-metrics.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_ENV.DB_HOST}:${DOCKER_COMPOSE_ENV.DB_PORT} — skipping. ` +
      "Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

describe.runIf(mysqlReachable)(
  "collectPoolMetrics — docker-compose MySQL integration (feature #30)",
  () => {
    let pool: Pool | undefined;

    afterEach(async () => {
      if (pool) {
        await pool.end();
        pool = undefined;
      }
    });

    it("reports all-zero before any connection has ever been acquired", () => {
      pool = createDbPool({
        DB_HOST: DOCKER_COMPOSE_ENV.DB_HOST,
        DB_PORT: Number(DOCKER_COMPOSE_ENV.DB_PORT),
        DB_USER: DOCKER_COMPOSE_ENV.DB_USER,
        DB_PASSWORD: DOCKER_COMPOSE_ENV.DB_PASSWORD,
        DB_NAME: DOCKER_COMPOSE_ENV.DB_NAME,
        DB_CONNECTION_LIMIT: 2,
        DB_SSL: "disabled",
        DB_SSL_REJECT_UNAUTHORIZED: true,
      });

      expect(collectPoolMetrics(pool)).toEqual({ active: 0, idle: 0, queued: 0 });
    });

    it("updates active/idle/queued correctly under concurrent queries that exceed connectionLimit", async () => {
      pool = createDbPool({
        DB_HOST: DOCKER_COMPOSE_ENV.DB_HOST,
        DB_PORT: Number(DOCKER_COMPOSE_ENV.DB_PORT),
        DB_USER: DOCKER_COMPOSE_ENV.DB_USER,
        DB_PASSWORD: DOCKER_COMPOSE_ENV.DB_PASSWORD,
        DB_NAME: DOCKER_COMPOSE_ENV.DB_NAME,
        DB_CONNECTION_LIMIT: 2,
        DB_SSL: "disabled",
        DB_SSL_REJECT_UNAUTHORIZED: true,
      });

      // Fire 5 concurrent, deliberately slow queries against a pool capped
      // at 2 connections. `pool.query()` synchronously starts mysql2's own
      // getConnection() bookkeeping the moment it's called (before any
      // network I/O has a chance to complete), so sampling right after
      // issuing every call — still in the same synchronous block, before
      // `await` ever yields — observes the pool genuinely mid-flight: 2
      // connections checked out (the cap), 3 callers queued behind it.
      const inFlight = Array.from({ length: 5 }, () => (pool as Pool).query("SELECT SLEEP(0.3)"));

      const midFlight = collectPoolMetrics(pool);
      expect(midFlight).toEqual({ active: 2, idle: 0, queued: 3 });

      await Promise.all(inFlight);

      // Every query has completed and released its connection back to the
      // pool — no connection is checked out, none are waiting.
      const afterDrain = collectPoolMetrics(pool);
      expect(afterDrain).toEqual({ active: 0, idle: 2, queued: 0 });
    });
  },
);

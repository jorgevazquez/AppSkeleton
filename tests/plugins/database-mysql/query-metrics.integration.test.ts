/**
 * Integration test against the real docker-compose MySQL instance (see
 * `docker-compose.yml` / `init.sh`) proving feature #26's step 3: a
 * deliberately slow query run through the db:query capability is both
 * logged (with its bound parameters redacted) and counted.
 *
 * Mirrors query-capability.integration.test.ts's shape: skips itself
 * (rather than failing) when MySQL isn't reachable, so `npm test` stays
 * green without Docker; `init.sh` and CI always have it up.
 *
 * The "slow query" here is MySQL's own `SLEEP(seconds)` — a real,
 * deliberate delay against a real server, not a mock — so this exercises
 * the actual composition a caller wires up in production: one shared
 * `QueryMetricsRecorder` fed by `createKyselyDb()`'s Kysely `log` hook
 * (built via `createSlowQueryLogger()`) and read back through
 * `createDbQueryCapability()`'s `getMetrics()`.
 */
import mysql from "mysql2/promise";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../../src/core/logger.js";
import { createDbPool } from "../../../src/plugins/database-mysql/src/pool.js";
import { createKyselyDb, type Database } from "../../../src/plugins/database-mysql/src/db.js";
import {
  createDbQueryCapability,
  type DbQueryCapability,
} from "../../../src/plugins/database-mysql/src/query-capability.js";
import {
  createQueryMetricsRecorder,
  createSlowQueryLogger,
  REDACTED_PARAMETER_PLACEHOLDER,
} from "../../../src/plugins/database-mysql/src/query-metrics.js";

/** Matches docker-compose.yml's `mysql` service credentials. */
const DOCKER_COMPOSE_CONFIG = {
  DB_HOST: "127.0.0.1",
  DB_PORT: 3306,
  DB_USER: "appskeleton",
  DB_PASSWORD: "change-me",
  DB_NAME: "appskeleton",
  DB_CONNECTION_LIMIT: 5,
  DB_SSL: "disabled" as const,
  DB_SSL_REJECT_UNAUTHORIZED: true,
};

/** Low enough that a real `SLEEP(0.2)` reliably trips it, high enough that ordinary fixture queries below never do. */
const TEST_THRESHOLD_MS = 50;

async function probeMysqlReachable(): Promise<boolean> {
  try {
    const probe = await mysql.createConnection({
      host: DOCKER_COMPOSE_CONFIG.DB_HOST,
      port: DOCKER_COMPOSE_CONFIG.DB_PORT,
      user: DOCKER_COMPOSE_CONFIG.DB_USER,
      password: DOCKER_COMPOSE_CONFIG.DB_PASSWORD,
      database: DOCKER_COMPOSE_CONFIG.DB_NAME,
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
    "[query-metrics.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping integration ` +
      "suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

describe.runIf(mysqlReachable)(
  "db:query capability — slow query logging & basic metrics (feature #26)",
  () => {
    let pool: mysql.Pool;
    let db: Kysely<Database>;
    let capability: DbQueryCapability;
    let chunks: string[];

    beforeAll(() => {
      pool = createDbPool(DOCKER_COMPOSE_CONFIG);

      chunks = [];
      const logger = createLogger({
        level: "trace",
        stream: {
          write(chunk: string, _encoding: unknown, callback: () => void) {
            chunks.push(chunk.toString());
            callback();
          },
        } as unknown as NodeJS.WritableStream,
      });

      // The two constructors are wired to the exact same recorder — see
      // this module's doc comment on why that's what makes
      // `capability.getMetrics()` reflect real traffic.
      const metrics = createQueryMetricsRecorder();
      db = createKyselyDb(pool, {
        log: createSlowQueryLogger({ logger, thresholdMs: TEST_THRESHOLD_MS, metrics }),
      });
      capability = createDbQueryCapability(db, { metrics });
    });

    afterAll(async () => {
      // Destroying Kysely ends the shared underlying mysql2 pool — see db.ts.
      await db.destroy();
    });

    function logLines(): Record<string, unknown>[] {
      return chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    }

    it("does not log a fast query, but still counts it without marking it an error", async () => {
      const before = capability.getMetrics();

      await capability.query((kdb) => sql`SELECT 1`.execute(kdb));

      const after = capability.getMetrics();
      expect(after.queryCount).toBe(before.queryCount + 1);
      expect(after.errorCount).toBe(before.errorCount);
      expect(logLines().some((line) => line.msg === "slow query detected")).toBe(false);
    });

    it("logs a deliberately slow query with its bound parameter redacted, and counts it", async () => {
      const before = capability.getMetrics();

      // Built outside the `capability.query(...)` call (rather than inline
      // in its callback) so the repo-wide `no-restricted-syntax` lint rule
      // — which forbids an interpolated template literal anywhere inside a
      // `.query(...)` call, to catch string-concatenated SQL in capability
      // consumer code — doesn't flag this: Kysely's `sql` tag always
      // compiles interpolated JS values to bound `?` placeholders, never
      // splices them into the SQL text (see query-capability.ts's own
      // docs), so there's nothing unsafe here to catch.
      const slowQuery = sql`SELECT SLEEP(0.2), ${"Ada Lovelace"} AS name`;
      await capability.query((kdb) => slowQuery.execute(kdb));

      const after = capability.getMetrics();
      expect(after.queryCount).toBe(before.queryCount + 1);
      expect(after.averageDurationMs).toBeGreaterThan(0);

      const slowLines = logLines().filter((line) => line.msg === "slow query detected");
      expect(slowLines.length).toBeGreaterThanOrEqual(1);
      const line = slowLines[slowLines.length - 1];
      expect(line?.sql).toContain("SLEEP");
      expect(line?.parameters).toEqual([REDACTED_PARAMETER_PLACEHOLDER]);
      const raw = JSON.stringify(line);
      expect(raw).not.toContain("Ada Lovelace");
      expect(typeof line?.durationMs).toBe("number");
      expect((line?.durationMs as number) >= TEST_THRESHOLD_MS).toBe(true);
    });

    it("counts a failing query as an error even when it isn't slow", async () => {
      const before = capability.getMetrics();

      await expect(
        capability.query((kdb) => sql`SELECT * FROM nonexistent_table_xyz`.execute(kdb)),
      ).rejects.toMatchObject({ code: "DATABASE_ERROR" });

      const after = capability.getMetrics();
      expect(after.queryCount).toBe(before.queryCount + 1);
      expect(after.errorCount).toBe(before.errorCount + 1);
    });
  },
);

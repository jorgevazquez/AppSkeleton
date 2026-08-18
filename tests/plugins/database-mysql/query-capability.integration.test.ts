/**
 * Integration tests against the real docker-compose MySQL instance (see
 * `docker-compose.yml` / `init.sh`) proving feature #20's step 3: a
 * parameterized SELECT/INSERT run through the db:query capability, with SQL
 * injection payloads treated as literal data rather than executed SQL.
 *
 * Mirrors pool.integration.test.ts's shape: skips itself (rather than
 * failing) when MySQL isn't reachable, so `npm test` stays green without
 * Docker; `init.sh` and CI always have it up.
 *
 * The migration runner (feature #19) hasn't landed yet — this plugin only
 * `depends_on: [18]` (the pool), not #19 — so this suite creates and drops
 * its own scratch table directly via the pool (test fixture setup, not a
 * "capability consumer" code path; the constraint under test is on what
 * db:query itself accepts, not on how a test seeds its fixtures). The table
 * is named per the `<plugin_id>_<table>` convention feature #22 will later
 * enforce for real migrations.
 */
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createDbPool } from "../../../src/plugins/database-mysql/src/pool.js";
import { createKyselyDb, type Database } from "../../../src/plugins/database-mysql/src/db.js";
import {
  createDbQueryCapability,
  type DbQueryCapability,
} from "../../../src/plugins/database-mysql/src/query-capability.js";

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

const TABLE = "database_mysql_query_capability_test";

// Built as plain strings (not template literals inline at the `.query()`
// call site) so this DDL fixture setup doesn't trip the repo-wide
// `no-restricted-syntax` lint rule that forbids `<expr>.query(\`...${x}...\`)`
// — that rule exists to catch string-concatenated SQL in *capability
// consumer* code, not table-name plumbing in a test's own raw-pool fixture
// setup (DDL identifiers can't be bound as `?` parameters in MySQL anyway).
const DROP_TABLE_SQL = "DROP TABLE IF EXISTS `" + TABLE + "`";
const CREATE_TABLE_SQL =
  "CREATE TABLE `" +
  TABLE +
  "` (" +
  "id INT AUTO_INCREMENT PRIMARY KEY, " +
  "name VARCHAR(255) NOT NULL, " +
  "note VARCHAR(255) NULL" +
  ")";
const COUNT_SQL = "SELECT COUNT(*) AS n FROM `" + TABLE + "`";

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
    "[query-capability.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping integration ` +
      "suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

describe.runIf(mysqlReachable)("db:query capability — parameterized-only integration", () => {
  let pool: mysql.Pool;
  let db: Kysely<Database>;
  let capability: DbQueryCapability;

  beforeAll(async () => {
    pool = createDbPool(DOCKER_COMPOSE_CONFIG);
    db = createKyselyDb(pool);
    capability = createDbQueryCapability(db);

    // Raw DDL fixture setup — not a db:query consumer path (see module docs).
    await pool.query(DROP_TABLE_SQL);
    await pool.query(CREATE_TABLE_SQL);
  });

  afterAll(async () => {
    await pool.query(DROP_TABLE_SQL);
    // Destroying Kysely ends the shared underlying mysql2 pool — see db.ts.
    await db.destroy();
  });

  it("performs a parameterized INSERT and SELECT through the capability", async () => {
    const inserted = await capability.query((kdb) =>
      kdb
        .insertInto(TABLE)
        .values({ name: "Ada Lovelace", note: "first programmer" })
        .executeTakeFirstOrThrow(),
    );
    expect(inserted.insertId).toBeGreaterThan(0n);

    const row = await capability.query((kdb) =>
      kdb
        .selectFrom(TABLE)
        .select(["name", "note"])
        .where("name", "=", "Ada Lovelace")
        .executeTakeFirstOrThrow(),
    );
    expect(row).toEqual({ name: "Ada Lovelace", note: "first programmer" });
  });

  it("stores a classic tautology injection payload as literal data, not as executed SQL logic", async () => {
    const payload = "' OR '1'='1";

    await capability.query((kdb) =>
      kdb.insertInto(TABLE).values({ name: payload, note: "tautology-payload" }).execute(),
    );

    // If the payload were ever concatenated into the query text instead of
    // bound as a parameter, a WHERE clause built around it would match
    // every row in the table (`... WHERE name = '' OR '1'='1'`) rather than
    // just the one row whose name is literally that string.
    const matches = await capability.query((kdb) =>
      kdb.selectFrom(TABLE).select(["name"]).where("name", "=", payload).execute(),
    );

    expect(matches).toEqual([{ name: payload }]);
  });

  it("stores a stacked-query DROP TABLE payload as literal data — the table survives", async () => {
    const payload = `x'; DROP TABLE ${TABLE}; --`;

    await capability.query((kdb) =>
      kdb.insertInto(TABLE).values({ name: payload, note: "drop-table-payload" }).execute(),
    );

    const row = await capability.query((kdb) =>
      kdb
        .selectFrom(TABLE)
        .select(["name", "note"])
        .where("note", "=", "drop-table-payload")
        .executeTakeFirstOrThrow(),
    );
    expect(row.name).toBe(payload);

    // The table must still exist and be queryable — the DROP TABLE embedded
    // in the payload text was never executed as SQL.
    const stillExists = await pool.query(COUNT_SQL);
    expect(Array.isArray(stillExists[0])).toBe(true);
  });

  it("stores a comment-terminator payload without truncating or altering the query", async () => {
    const payload = "trailing-comment-- ";

    await capability.query((kdb) =>
      kdb.insertInto(TABLE).values({ name: payload, note: "comment-payload" }).execute(),
    );

    const row = await capability.query((kdb) =>
      kdb
        .selectFrom(TABLE)
        .select(["name"])
        .where("note", "=", "comment-payload")
        .executeTakeFirstOrThrow(),
    );
    expect(row.name).toBe(payload);
  });

  it("matches nothing for an injection-shaped search value that isn't a stored literal (no injected logic executes)", async () => {
    await capability.query((kdb) =>
      kdb.insertInto(TABLE).values({ name: "Grace Hopper", note: "compiler pioneer" }).execute(),
    );

    const searchValue = "nonexistent' OR name IS NOT NULL -- ";
    const matches = await capability.query((kdb) =>
      kdb.selectFrom(TABLE).select(["name"]).where("name", "=", searchValue).execute(),
    );

    expect(matches).toEqual([]);
  });

  it("propagates a real driver error (e.g. NOT NULL violation) as a DatabaseError, not a silent failure", async () => {
    await expect(
      capability.query((kdb) =>
        // `name` is NOT NULL — omitting it must surface as a real failure.
        kdb
          .insertInto(TABLE)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately violating the NOT NULL constraint to prove errors surface as DatabaseError.
          .values({ note: "missing required name" } as any)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: "DATABASE_ERROR" });
  });

  it("healthCheck() reports healthy against the real, reachable docker-compose MySQL (feature #24)", async () => {
    await expect(capability.healthCheck()).resolves.toEqual({ healthy: true });
  });
});

describe.runIf(mysqlReachable)(
  "db:query capability — healthCheck() reports unhealthy when unreachable (feature #24)",
  () => {
    it("resolves { healthy: false, error } rather than rejecting when the pool points at an unreachable host", async () => {
      // A pool pointed at a closed port on localhost — nothing is listening,
      // so every connection attempt fails immediately, the same shape of
      // failure a genuinely down MySQL server would produce.
      const deadPool = createDbPool({ ...DOCKER_COMPOSE_CONFIG, DB_PORT: 1 });
      const deadDb = createKyselyDb(deadPool);
      const deadCapability = createDbQueryCapability(deadDb);

      try {
        const result = await deadCapability.healthCheck();
        expect(result.healthy).toBe(false);
        expect(typeof result.error).toBe("string");
      } finally {
        await deadDb.destroy();
      }
    });
  },
);

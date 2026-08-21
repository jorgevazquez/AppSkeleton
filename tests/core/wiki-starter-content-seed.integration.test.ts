/**
 * Integration test for feature #99 ("Wiki seed content (starter Home page
 * and platform documentation)"), step 3: "Write a test asserting seeding
 * twice does not duplicate the Home page."
 *
 * ## Why this lives in tests/core, not tests/plugins/wiki
 *
 * Same rationale as `tests/core/rbac-default-roles-seed.integration.test.ts`
 * (feature #37)'s own header comment: proving the seed actually writes real
 * rows needs `database-mysql`'s real pool/Kysely wiring alongside `wiki`'s
 * own migration files to create the `wiki_*` tables first — genuinely
 * cross-plugin, kernel-level wiring `docs/plugin-conventions.md`'s
 * "kernel-integration tests" carve-out allows, not something
 * `tests/plugins/wiki/**` could express under that section's rule.
 *
 * ## What this proves
 *
 * `src/plugins/wiki/seeds/index.ts` registers `"wiki:starter-content"` with
 * the generic seed runner (`src/core/seed.ts`, feature #25) purely by being
 * imported — exactly how `src/cli/seed.ts`'s `loadPluginSeedModules()`
 * discovers it in production. Importing it here for that same side effect,
 * then driving it through the real `runSeeds()` against real MySQL, tests
 * the actual shipped seed file end to end rather than a re-implementation
 * of it:
 *
 *   1. A first `runSeeds()` call applies it: the "main"/"docs" namespaces
 *      and every page in `SEED_PAGES` — including exactly one Home page at
 *      `("main", "home")` — land in their real `wiki_*` tables.
 *   2. A second `runSeeds()` call — simulating a second `npm run seed`
 *      invocation, e.g. after a redeploy — applies nothing new
 *      (`result.applied` is empty, `result.skipped` includes the seed's
 *      key) and, critically, there is still exactly one Home page row, not
 *      two. This is feature #99 step 3's literal requirement, proven the
 *      same way feature #37's own
 *      `tests/core/rbac-default-roles-seed.integration.test.ts` proves
 *      idempotency for its own seed: `runSeeds()`'s own `schema_seeds`
 *      bookkeeping — not any dedup logic inside the seed function itself —
 *      is what makes re-running it a no-op.
 *   3. A third call reconfirms nothing changes further.
 *
 * Skips itself (rather than failing) when MySQL isn't reachable, matching
 * every other integration suite in this repo.
 */
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import {
  SEEDS_TABLE,
  listRegisteredSeeds,
  runSeeds,
  type SeedableDatabase,
} from "../../src/core/seed.js";
import { createDbPool } from "../../src/plugins/database-mysql/src/pool.js";
import { createKyselyDb } from "../../src/plugins/database-mysql/src/db.js";
import * as createNamespaces from "../../src/plugins/wiki/src/migrations/0001_create_wiki_namespaces.js";
import * as createPages from "../../src/plugins/wiki/src/migrations/0002_create_wiki_pages.js";
import * as createRevisions from "../../src/plugins/wiki/src/migrations/0003_create_wiki_revisions.js";
import * as addFulltextIndex from "../../src/plugins/wiki/src/migrations/0004_add_wiki_pages_fulltext_index.js";
import {
  DOCS_NAMESPACE_ID,
  HOME_PAGE_SLUG,
  MAIN_NAMESPACE_ID,
  SEED_NAMESPACES,
  SEED_PAGES,
} from "../../src/plugins/wiki/seeds/index.js";

/** Matches docker-compose.yml's `mysql` service credentials — same fixture every sibling integration suite uses. */
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

const SEED_KEY = "wiki:starter-content";
const WIKI_TABLES = ["wiki_revisions", "wiki_pages", "wiki_namespaces"] as const;

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
// evaluated at collection time — see the sibling integration suites for why
// this must not be a still-pending promise at that point.
const mysqlReachable = await probeMysqlReachable();

if (!mysqlReachable) {
  console.warn(
    "[wiki-starter-content-seed.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping the ` +
      "feature #99 seed integration suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

describe.runIf(mysqlReachable)("wiki — starter content seed (feature #99)", () => {
  let pool: mysql.Pool;
  let db: Kysely<SeedableDatabase>;

  beforeAll(async () => {
    pool = createDbPool(DOCKER_COMPOSE_CONFIG);
    db = createKyselyDb(pool);

    for (const table of WIKI_TABLES) {
      await pool.query("DROP TABLE IF EXISTS `" + table + "`");
    }
    await pool.query("DELETE FROM `" + SEEDS_TABLE + "` WHERE `name` = ?", [SEED_KEY]);

    // Real migration files (feature #86), applied directly — same technique
    // rbac-default-roles-seed.integration.test.ts uses, avoiding any race
    // with sibling suites' own use of the shared schema_migrations tracking
    // table.
    await createNamespaces.up(db);
    await createPages.up(db);
    await createRevisions.up(db);
    await addFulltextIndex.up(db);
  });

  afterAll(async () => {
    for (const table of WIKI_TABLES) {
      await pool.query("DROP TABLE IF EXISTS `" + table + "`");
    }
    await pool.query("DELETE FROM `" + SEEDS_TABLE + "` WHERE `name` = ?", [SEED_KEY]);
    await db.destroy();
  });

  async function namespaceRows() {
    return db.selectFrom("wiki_namespaces").selectAll().orderBy("id", "asc").execute();
  }

  async function pageRows() {
    return db.selectFrom("wiki_pages").selectAll().orderBy("id", "asc").execute();
  }

  async function homePageRows() {
    return db
      .selectFrom("wiki_pages")
      .selectAll()
      .where("namespace_id", "=", MAIN_NAMESPACE_ID)
      .where("slug", "=", HOME_PAGE_SLUG)
      .execute();
  }

  it("registers the seed under the expected key", () => {
    expect(listRegisteredSeeds().map((s) => s.key)).toContain(SEED_KEY);
  });

  it("applies the seed: creates the main/docs namespaces and every starter page, including exactly one Home page", async () => {
    const result = await runSeeds(db);

    expect(result.applied).toEqual([SEED_KEY]);
    expect(result.skipped).toEqual([]);

    const namespaces = await namespaceRows();
    expect(namespaces.map((n) => n["id"]).sort()).toEqual(
      [MAIN_NAMESPACE_ID, DOCS_NAMESPACE_ID].sort(),
    );
    expect(namespaces).toHaveLength(SEED_NAMESPACES.length);

    const pages = await pageRows();
    expect(pages).toHaveLength(SEED_PAGES.length);

    const home = await homePageRows();
    expect(home).toHaveLength(1);
    expect(home[0]).toMatchObject({ title: "Home" });
  });

  it("seeding twice does not duplicate the Home page (feature #99 step 3)", async () => {
    const result = await runSeeds(db);

    // Nothing new applied — schema_seeds already has this key recorded.
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([SEED_KEY]);

    // Still exactly one Home page — not two — despite the seed's own
    // INSERTs having no existence check of their own (see seeds/index.ts's
    // "Idempotency" doc section).
    const home = await homePageRows();
    expect(home).toHaveLength(1);

    const namespaces = await namespaceRows();
    expect(namespaces).toHaveLength(SEED_NAMESPACES.length);

    const pages = await pageRows();
    expect(pages).toHaveLength(SEED_PAGES.length);
  });

  it("running a third time is still a no-op", async () => {
    const result = await runSeeds(db);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([SEED_KEY]);

    const home = await homePageRows();
    expect(home).toHaveLength(1);
  });
});

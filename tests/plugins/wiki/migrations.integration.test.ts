/**
 * Integration tests for the wiki plugin's own migrations (feature #86,
 * step 3 — "Write an integration test applying the migrations and
 * asserting constraints (unique slug per namespace) are enforced").
 *
 * Mirrors `tests/plugins/database-mysql/migrator.integration.test.ts`'s
 * "skip when docker-compose MySQL isn't reachable" precedent, so `npm test`
 * stays green without Docker while `init.sh`/CI (which always bring MySQL
 * up) get full coverage. Unlike that suite — which drives disposable
 * fixture migrations in a throwaway temp directory — this one applies the
 * plugin's own *real*, checked-in migration files
 * (`WIKI_MIGRATIONS_DIR`/`src/plugins/wiki/src/migrations/`) through the
 * same checksum-verified runner (`database-mysql/src/migrator.ts`).
 * That's intentional: proving `wiki_pages`/`wiki_revisions`/
 * `wiki_namespaces` and their indexes are exactly what step 1/2 describe is
 * the whole point of this feature, so a disposable fixture schema wouldn't
 * test anything. Also covers `migrations/0004_add_wiki_pages_fulltext_index.ts`
 * (feature #92 step 1's own `FULLTEXT` index), applied here through the
 * same `listMigrationFiles(WIKI_MIGRATIONS_DIR)` file list as the other
 * three, with no changes to this suite's own structure needed.
 *
 * `afterAll` fully rolls every migration this suite applied back
 * (`runMigrationsDown`,
 * `steps: <all of them>`), the same way `migrator.integration.test.ts` and
 * `database-mysql/integration.test.ts` always leave `schema_migrations`
 * exactly as they found it: every plugin's migrations share one *global*
 * tracking table (`MIGRATIONS_TABLE`/`schema_migrations`, see migrator.ts),
 * and `verifyAppliedChecksums` checks *every* already-applied row against
 * whatever file list a given caller passes in — so a row left behind by
 * one suite that isn't in a *different* suite's own migrationsDir file
 * list surfaces there as a "row with no matching file" `MigrationError`
 * (a pre-existing property of the shared table, documented in `tests/core/
 * audit-persistence.integration.test.ts`; feature #34's `claude-
 * progress.txt` notes the eventual fix — a per-plugin-namespaced tracking
 * table — as future work, not this feature's job). Fully rolling back here
 * keeps this suite from ever being the thing that trips that up for a
 * later suite, or for a second consecutive `npm test` run against the same
 * persistent dev database.
 *
 * This file crosses from `tests/plugins/wiki/` into `database-mysql`'s
 * runner/pool/db modules directly — allowed under `docs/plugin-
 * conventions.md`'s "kernel-integration tests" carve-out (same carve-out
 * `wiki/src/migrations-dir.ts`'s doc comment cites), since a real migration
 * runner is exactly what step 3 asks this test to drive the migrations
 * through.
 */
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createDbPool } from "../../../src/plugins/database-mysql/src/pool.js";
import { createKyselyDb, type Database } from "../../../src/plugins/database-mysql/src/db.js";
import {
  listMigrationFiles,
  runMigrationsDown,
  runMigrationsUp,
} from "../../../src/plugins/database-mysql/src/migrator.js";
import { WIKI_MIGRATIONS_DIR } from "../../../src/plugins/wiki/src/migrations-dir.js";

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

const PLUGIN_ID = "wiki";

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
// evaluated at collection time — see migrator.integration.test.ts for why
// this must not be a still-pending promise at that point.
const mysqlReachable = await probeMysqlReachable();

if (!mysqlReachable) {
  console.warn(
    "[wiki migrations.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping integration ` +
      "suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

async function tableExists(pool: mysql.Pool, tableName: string): Promise<boolean> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
    [tableName],
  );
  return Number(rows[0]?.["n"] ?? 0) > 0;
}

/** Row shape from `SHOW INDEX FROM <table>` — used to assert index/uniqueness metadata directly, not just infer it from behavior. */
interface ShowIndexRow extends mysql.RowDataPacket {
  Key_name: string;
  Non_unique: number;
  Column_name: string;
  Seq_in_index: number;
  Index_type: string;
}

async function showIndex(pool: mysql.Pool, tableName: string): Promise<ShowIndexRow[]> {
  const [rows] = await pool.query<ShowIndexRow[]>("SHOW INDEX FROM `" + tableName + "`");
  return rows;
}

describe.runIf(mysqlReachable)("wiki migrations — schema, indexes, and constraints", () => {
  let pool: mysql.Pool;
  let db: Kysely<Database>;

  const TEST_NAMESPACE_A = "wiki_migrations_test_ns_a";
  const TEST_NAMESPACE_B = "wiki_migrations_test_ns_b";
  const TEST_SLUG = "wiki-migrations-test-page";

  function files() {
    return listMigrationFiles(WIKI_MIGRATIONS_DIR);
  }

  beforeAll(async () => {
    pool = createDbPool(DOCKER_COMPOSE_CONFIG);
    db = createKyselyDb(pool);

    const result = await runMigrationsUp(db, files(), { pluginId: PLUGIN_ID });
    expect(result.applied).toEqual([
      "0001_create_wiki_namespaces.ts",
      "0002_create_wiki_pages.ts",
      "0003_create_wiki_revisions.ts",
      "0004_add_wiki_pages_fulltext_index.ts",
      "0005_create_wiki_attachments.ts",
    ]);
  });

  afterAll(async () => {
    // Roll every migration this suite applied back off, in one call — see
    // this file's top doc comment for why leaving them applied would risk
    // breaking a later suite (or a second `npm test` run) that shares the
    // same global `schema_migrations` tracking table.
    const result = await runMigrationsDown(db, files(), { pluginId: PLUGIN_ID, steps: 5 });
    expect(result.rolledBack).toEqual([
      "0005_create_wiki_attachments.ts",
      "0004_add_wiki_pages_fulltext_index.ts",
      "0003_create_wiki_revisions.ts",
      "0002_create_wiki_pages.ts",
      "0001_create_wiki_namespaces.ts",
    ]);
    for (const table of ["wiki_namespaces", "wiki_pages", "wiki_revisions", "wiki_attachments"]) {
      expect(await tableExists(pool, table)).toBe(false);
    }
    await db.destroy();
  });

  it("applies wiki_namespaces, wiki_pages, wiki_revisions, and wiki_attachments under the wiki_ table namespace", async () => {
    for (const table of ["wiki_namespaces", "wiki_pages", "wiki_revisions", "wiki_attachments"]) {
      expect(await tableExists(pool, table)).toBe(true);
    }

    // Idempotent — running up() again with nothing new pending applies
    // nothing (see migrator.ts's own idempotency guarantee).
    const result = await runMigrationsUp(db, files(), { pluginId: PLUGIN_ID });
    expect(result.applied).toEqual([]);
  });

  it("has a UNIQUE index on wiki_pages(namespace_id, slug)", async () => {
    const rows = await showIndex(pool, "wiki_pages");
    const uniqueIdxRows = rows
      .filter((row) => row.Key_name === "wiki_pages_namespace_slug_uniq")
      .sort((a, b) => a.Seq_in_index - b.Seq_in_index);

    expect(uniqueIdxRows.map((row) => row.Column_name)).toEqual(["namespace_id", "slug"]);
    expect(uniqueIdxRows.every((row) => row.Non_unique === 0)).toBe(true);
  });

  it("has a FULLTEXT index on wiki_pages(title, content) for feature #92's ranked search", async () => {
    const rows = await showIndex(pool, "wiki_pages");
    const fulltextIdxRows = rows
      .filter((row) => row.Key_name === "wiki_pages_fulltext_idx")
      .sort((a, b) => a.Seq_in_index - b.Seq_in_index);

    expect(fulltextIdxRows.map((row) => row.Column_name)).toEqual(["title", "content"]);
    expect(fulltextIdxRows.every((row) => row.Index_type === "FULLTEXT")).toBe(true);
  });

  it("has a lookup index on wiki_revisions(page_id) for revision-by-page queries", async () => {
    const rows = await showIndex(pool, "wiki_revisions");
    const pageIdxRows = rows.filter((row) => row.Key_name === "wiki_revisions_page_id_idx");
    expect(pageIdxRows.length).toBeGreaterThan(0);
    expect(pageIdxRows.some((row) => row.Column_name === "page_id")).toBe(true);
  });

  it("has a lookup index on wiki_attachments(page_id) and a UNIQUE index on storage_name (feature #97)", async () => {
    const rows = await showIndex(pool, "wiki_attachments");

    const pageIdxRows = rows.filter((row) => row.Key_name === "wiki_attachments_page_id_idx");
    expect(pageIdxRows.length).toBeGreaterThan(0);
    expect(pageIdxRows.some((row) => row.Column_name === "page_id")).toBe(true);

    const storageNameIdxRows = rows.filter(
      (row) => row.Key_name === "wiki_attachments_storage_name_uniq",
    );
    expect(storageNameIdxRows.map((row) => row.Column_name)).toEqual(["storage_name"]);
    expect(storageNameIdxRows.every((row) => row.Non_unique === 0)).toBe(true);
  });

  it("enforces unique slug per namespace: a duplicate (namespace_id, slug) pair is rejected", async () => {
    await db
      .insertInto("wiki_namespaces")
      .values({ id: TEST_NAMESPACE_A, name: "Test Namespace A" })
      .execute();

    await db
      .insertInto("wiki_pages")
      .values({
        namespace_id: TEST_NAMESPACE_A,
        slug: TEST_SLUG,
        title: "First page",
        content: "Original content",
      })
      .execute();

    await expect(
      db
        .insertInto("wiki_pages")
        .values({
          namespace_id: TEST_NAMESPACE_A,
          slug: TEST_SLUG,
          title: "Duplicate slug, same namespace",
          content: "Should be rejected",
        })
        .execute(),
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });

    // Only the original row exists — the rejected insert committed nothing.
    const rows = await db
      .selectFrom("wiki_pages")
      .selectAll()
      .where("namespace_id", "=", TEST_NAMESPACE_A)
      .where("slug", "=", TEST_SLUG)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["title"]).toBe("First page");
  });

  it("allows the same slug to be reused in a different namespace", async () => {
    await db
      .insertInto("wiki_namespaces")
      .values({ id: TEST_NAMESPACE_B, name: "Test Namespace B" })
      .execute();

    // Same TEST_SLUG as the page already created in TEST_NAMESPACE_A above —
    // must succeed, since uniqueness is scoped to (namespace_id, slug), not
    // slug alone.
    await expect(
      db
        .insertInto("wiki_pages")
        .values({
          namespace_id: TEST_NAMESPACE_B,
          slug: TEST_SLUG,
          title: "Same slug, different namespace",
          content: "Allowed",
        })
        .execute(),
    ).resolves.toBeDefined();

    const rows = await db
      .selectFrom("wiki_pages")
      .select(["namespace_id", "slug"])
      .where("slug", "=", TEST_SLUG)
      .execute();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.namespace_id))).toEqual(
      new Set([TEST_NAMESPACE_A, TEST_NAMESPACE_B]),
    );
  });

  it("supports revision lookup by page via wiki_revisions.page_id", async () => {
    const page = await db
      .selectFrom("wiki_pages")
      .select("id")
      .where("namespace_id", "=", TEST_NAMESPACE_A)
      .where("slug", "=", TEST_SLUG)
      .executeTakeFirstOrThrow();
    const pageId = page["id"] as number;

    await db
      .insertInto("wiki_revisions")
      .values({ page_id: pageId, title: "First page", content: "Revision 1" })
      .execute();
    await db
      .insertInto("wiki_revisions")
      .values({ page_id: pageId, title: "First page", content: "Revision 2" })
      .execute();

    const revisions = await db
      .selectFrom("wiki_revisions")
      .select(["content"])
      .where("page_id", "=", pageId)
      .orderBy("id", "desc")
      .execute();
    expect(revisions.map((row) => row.content)).toEqual(["Revision 2", "Revision 1"]);
  });
});

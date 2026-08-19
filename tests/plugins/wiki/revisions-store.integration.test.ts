/**
 * Integration tests for feature #89 — "Revision history: every edit
 * creates a revision row":
 *
 *   - step 1 ("On every page update, snapshot the previous content into
 *     wiki_revisions before applying the change") — proven directly
 *     against real MySQL, since it's a same-transaction, two-table write
 *     (`pages.ts`'s `updatePage`) that no fake/in-memory `db:query` stand-in
 *     could actually exercise.
 *   - step 2 ("Implement an endpoint/function to list revisions for a page
 *     in reverse-chronological order") — `revisions.ts`'s
 *     `createWikiRevisionsStore().listRevisions`.
 *   - step 3 ("Write a test asserting 3 sequential edits produce 3
 *     retrievable revisions in the correct order") — see "3 sequential
 *     edits produce 3 retrievable revisions in reverse-chronological
 *     order" below.
 *
 * Mirrors `pages-store.integration.test.ts`'s "skip when docker-compose
 * MySQL isn't reachable", real `pool`/`db`/`db:query`-capability triplet,
 * and "apply this suite's own migration files' up()/down() directly, not
 * the shared checksum-verified runner" precedents — see that file's own
 * module doc comment for the full rationale, which applies unchanged here.
 * This suite additionally applies migration 0003 (`wiki_revisions`), which
 * that suite deliberately leaves out.
 *
 * This file crosses from `tests/plugins/wiki/` into `database-mysql`'s
 * pool/db/query-capability modules directly — the same "kernel-integration
 * tests" carve-out `docs/plugin-conventions.md` section 5 allows and
 * `pages-store.integration.test.ts` already exercises for this exact
 * plugin.
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
import * as createNamespaces from "../../../src/plugins/wiki/src/migrations/0001_create_wiki_namespaces.js";
import * as createPages from "../../../src/plugins/wiki/src/migrations/0002_create_wiki_pages.js";
import * as createRevisions from "../../../src/plugins/wiki/src/migrations/0003_create_wiki_revisions.js";
import { createWikiPagesStore } from "../../../src/plugins/wiki/src/pages.js";
import { createWikiRevisionsStore } from "../../../src/plugins/wiki/src/revisions.js";

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

/** This suite's own tables, child-before-parent for the DROP order. */
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
// evaluated at collection time — see the sibling integration suites this
// file mirrors for why this must not be a still-pending promise then.
const mysqlReachable = await probeMysqlReachable();

if (!mysqlReachable) {
  console.warn(
    "[wiki revisions-store.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping the ` +
      "feature #89 revision-history integration suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

function connect(): { pool: mysql.Pool; db: Kysely<Database>; queryCapability: DbQueryCapability } {
  const pool = createDbPool(DOCKER_COMPOSE_CONFIG);
  const db = createKyselyDb(pool);
  const queryCapability = createDbQueryCapability(db);
  return { pool, db, queryCapability };
}

describe.runIf(mysqlReachable)("wiki revision history — feature #89", () => {
  const NAMESPACE = "feature89-ns";

  let setup: ReturnType<typeof connect>;

  beforeAll(async () => {
    setup = connect();
    for (const table of WIKI_TABLES) {
      await setup.pool.query("DROP TABLE IF EXISTS `" + table + "`");
    }
    await createNamespaces.up(setup.db);
    await createPages.up(setup.db);
    await createRevisions.up(setup.db);

    await setup.db
      .insertInto("wiki_namespaces")
      .values({ id: NAMESPACE, name: "Feature 89 Namespace" })
      .execute();
  });

  afterAll(async () => {
    // Independent connection — some tests below may have already
    // destroyed `setup`'s pool/db handles.
    const cleanup = connect();
    try {
      await createRevisions.down(cleanup.db);
      await createPages.down(cleanup.db);
      await createNamespaces.down(cleanup.db);
    } finally {
      await cleanup.db.destroy();
    }
  });

  it("snapshots the previous title/content into wiki_revisions before applying an update (step 1)", async () => {
    const pages = createWikiPagesStore(setup.queryCapability);
    const revisions = createWikiRevisionsStore(setup.queryCapability);

    const created = await pages.createPage({
      namespaceId: NAMESPACE,
      slug: "snapshot-test",
      title: "Original Title",
      content: "Original content.",
    });

    expect(await revisions.listRevisions(created.id)).toEqual([]);

    const updated = await pages.updatePage(created.id, { content: "New content." });

    const history = await revisions.listRevisions(created.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.pageId).toBe(created.id);
    expect(history[0]?.title).toBe("Original Title");
    expect(history[0]?.content).toBe("Original content.");

    // The live page now holds the *new* content — the revision holds only
    // what preceded it.
    expect(updated.content).toBe("New content.");
  });

  it("writes no revision for a no-op update (empty changes)", async () => {
    const pages = createWikiPagesStore(setup.queryCapability);
    const revisions = createWikiRevisionsStore(setup.queryCapability);

    const created = await pages.createPage({
      namespaceId: NAMESPACE,
      slug: "no-op-update",
      title: "Untouched",
      content: "Stays the same.",
    });

    await pages.updatePage(created.id, {});

    expect(await revisions.listRevisions(created.id)).toEqual([]);
  });

  it("3 sequential edits produce 3 retrievable revisions in reverse-chronological order (step 3)", async () => {
    const pages = createWikiPagesStore(setup.queryCapability);
    const revisions = createWikiRevisionsStore(setup.queryCapability);

    const created = await pages.createPage({
      namespaceId: NAMESPACE,
      slug: "three-edits",
      title: "Version 1",
      content: "Content v1.",
    });

    await pages.updatePage(created.id, { title: "Version 2", content: "Content v2." });
    await pages.updatePage(created.id, { title: "Version 3", content: "Content v3." });
    const final = await pages.updatePage(created.id, {
      title: "Version 4",
      content: "Content v4.",
    });

    expect(final.title).toBe("Version 4");
    expect(final.content).toBe("Content v4.");

    const history = await revisions.listRevisions(created.id);
    expect(history).toHaveLength(3);

    // Reverse-chronological: the most recently superseded version (v3,
    // captured just before the edit that produced "Version 4") comes
    // first; the very first snapshot (v1) comes last.
    expect(history.map((revision) => revision.title)).toEqual([
      "Version 3",
      "Version 2",
      "Version 1",
    ]);
    expect(history.map((revision) => revision.content)).toEqual([
      "Content v3.",
      "Content v2.",
      "Content v1.",
    ]);

    // Every revision correctly attributed to this page, and ids strictly
    // increasing with insertion order (oldest revision has the smallest id).
    expect(history.every((revision) => revision.pageId === created.id)).toBe(true);
    expect(history[0]!.id).toBeGreaterThan(history[1]!.id);
    expect(history[1]!.id).toBeGreaterThan(history[2]!.id);
  });

  it("keeps each page's revisions independent of other pages'", async () => {
    const pages = createWikiPagesStore(setup.queryCapability);
    const revisions = createWikiRevisionsStore(setup.queryCapability);

    const pageA = await pages.createPage({
      namespaceId: NAMESPACE,
      slug: "isolation-a",
      title: "A v1",
      content: "A content v1.",
    });
    const pageB = await pages.createPage({
      namespaceId: NAMESPACE,
      slug: "isolation-b",
      title: "B v1",
      content: "B content v1.",
    });

    await pages.updatePage(pageA.id, { title: "A v2" });
    await pages.updatePage(pageB.id, { title: "B v2" });
    await pages.updatePage(pageB.id, { title: "B v3" });

    const historyA = await revisions.listRevisions(pageA.id);
    const historyB = await revisions.listRevisions(pageB.id);

    expect(historyA).toHaveLength(1);
    expect(historyA[0]?.title).toBe("A v1");

    expect(historyB).toHaveLength(2);
    expect(historyB.map((revision) => revision.title)).toEqual(["B v2", "B v1"]);
  });

  it("listRevisions returns an empty array for a page with no edits and for an unknown pageId", async () => {
    const pages = createWikiPagesStore(setup.queryCapability);
    const revisions = createWikiRevisionsStore(setup.queryCapability);

    const created = await pages.createPage({
      namespaceId: NAMESPACE,
      slug: "never-edited",
      title: "Untouched Forever",
      content: "No edits yet.",
    });

    expect(await revisions.listRevisions(created.id)).toEqual([]);
    expect(await revisions.listRevisions(999_999)).toEqual([]);
  });
});

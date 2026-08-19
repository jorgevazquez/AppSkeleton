/**
 * Integration tests for `pages.ts`'s `db:query`-backed CRUD store (feature
 * #87 — "Page CRUD via the db:query capability"), step 3: "Write
 * integration tests for each CRUD operation including not-found and
 * duplicate-slug error paths."
 *
 * Mirrors `migrations.integration.test.ts`'s "skip when docker-compose
 * MySQL isn't reachable" precedent (`npm test` stays green without Docker;
 * `init.sh`/CI always bring MySQL up) and `tests/core/
 * rbac-persistence.integration.test.ts`'s `connect()` triplet — a real
 * mysql2 pool, a real `Kysely<Database>` instance, and a real
 * `db:query`-capability wrapper (`database-mysql/src/query-capability.ts`'s
 * `createDbQueryCapability`), never a fake/in-memory stand-in — since this
 * feature's whole point is proving `createWikiPagesStore` reads/writes
 * *entirely* through that capability, no direct SQL client usage (step 1).
 *
 * Applies the three migrations `wiki_namespaces`/`wiki_pages`/
 * `wiki_revisions` need by importing their `up()`/`down()` modules
 * directly — the same "own migration files' up()/down(), not the shared
 * checksum-verified runner and its single global `schema_migrations`
 * table" technique `rbac-persistence.integration.test.ts`'s own module doc
 * explains, so this suite can never race a concurrently-scheduled sibling
 * suite's migration bookkeeping. `wiki_revisions` (migration 0003) is
 * applied here too — feature #89's `updatePage` snapshots into it on every
 * update, in the same transaction as the update itself, so it must exist
 * for this suite's `updatePage` coverage to run at all (not just for
 * `revisions-store.integration.test.ts`'s own dedicated feature #89
 * coverage of what actually lands in it).
 *
 * This file crosses from `tests/plugins/wiki/` into `database-mysql`'s
 * pool/db/query-capability modules directly — the same "kernel-integration
 * tests" carve-out `docs/plugin-conventions.md` section 5 allows and
 * `migrations.integration.test.ts` already exercises for this exact plugin.
 */
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { NotFoundError, ValidationError } from "../../../src/core/errors.js";
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
    "[wiki pages-store.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping the ` +
      "feature #87 page CRUD integration suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

function connect(): { pool: mysql.Pool; db: Kysely<Database>; queryCapability: DbQueryCapability } {
  const pool = createDbPool(DOCKER_COMPOSE_CONFIG);
  const db = createKyselyDb(pool);
  const queryCapability = createDbQueryCapability(db);
  return { pool, db, queryCapability };
}

describe.runIf(mysqlReachable)("wiki pages store — db:query CRUD integration (feature #87)", () => {
  const NAMESPACE_A = "feature87-ns-a";
  const NAMESPACE_B = "feature87-ns-b";

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
      .values([
        { id: NAMESPACE_A, name: "Feature 87 Namespace A" },
        { id: NAMESPACE_B, name: "Feature 87 Namespace B" },
      ])
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

  describe("createPage", () => {
    it("creates a page and returns it with an assigned id and timestamps", async () => {
      const store = createWikiPagesStore(setup.queryCapability);

      const page = await store.createPage({
        namespaceId: NAMESPACE_A,
        slug: "getting-started",
        title: "Getting Started",
        content: "Welcome to the wiki.",
      });

      expect(page.id).toEqual(expect.any(Number));
      expect(page.namespaceId).toBe(NAMESPACE_A);
      expect(page.slug).toBe("getting-started");
      expect(page.title).toBe("Getting Started");
      expect(page.content).toBe("Welcome to the wiki.");
      expect(page.createdAt).toBeInstanceOf(Date);
      expect(page.updatedAt).toBeInstanceOf(Date);

      // Persisted for real — a brand-new store/connection reads it back.
      const reread = connect();
      try {
        const found = await createWikiPagesStore(reread.queryCapability).getPageBySlug(
          NAMESPACE_A,
          "getting-started",
        );
        expect(found).toEqual(page);
      } finally {
        await reread.db.destroy();
      }
    });

    it("rejects a malformed slug with a ValidationError, before touching the database", async () => {
      const store = createWikiPagesStore(setup.queryCapability);

      await expect(
        store.createPage({
          namespaceId: NAMESPACE_A,
          slug: "Not A Valid Slug!",
          title: "Bad Slug",
          content: "Should never be persisted.",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await store.getPageBySlug(NAMESPACE_A, "Not A Valid Slug!")).toBeUndefined();
    });

    it("rejects a namespace that does not exist with a ValidationError", async () => {
      const store = createWikiPagesStore(setup.queryCapability);

      await expect(
        store.createPage({
          namespaceId: "feature87-does-not-exist",
          slug: "orphan-page",
          title: "Orphan",
          content: "Should never be persisted.",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await store.getPageBySlug("feature87-does-not-exist", "orphan-page")).toBeUndefined();
    });

    it("rejects a duplicate (namespace, slug) pair with a ValidationError — the duplicate-slug error path", async () => {
      const store = createWikiPagesStore(setup.queryCapability);

      await store.createPage({
        namespaceId: NAMESPACE_A,
        slug: "duplicate-me",
        title: "First",
        content: "Original content.",
      });

      await expect(
        store.createPage({
          namespaceId: NAMESPACE_A,
          slug: "duplicate-me",
          title: "Second",
          content: "Should be rejected.",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // Only the original page exists — the rejected create persisted nothing.
      const found = await store.getPageBySlug(NAMESPACE_A, "duplicate-me");
      expect(found?.title).toBe("First");
    });

    it("allows the same slug to be reused in a different namespace", async () => {
      const store = createWikiPagesStore(setup.queryCapability);

      await store.createPage({
        namespaceId: NAMESPACE_A,
        slug: "shared-slug",
        title: "In namespace A",
        content: "A's content.",
      });

      const pageB = await store.createPage({
        namespaceId: NAMESPACE_B,
        slug: "shared-slug",
        title: "In namespace B",
        content: "B's content.",
      });

      expect(pageB.namespaceId).toBe(NAMESPACE_B);
      expect(pageB.slug).toBe("shared-slug");

      const pageA = await store.getPageBySlug(NAMESPACE_A, "shared-slug");
      expect(pageA?.namespaceId).toBe(NAMESPACE_A);
    });
  });

  describe("read", () => {
    it("getPageById / getPageBySlug return undefined (never throw) for a page that does not exist", async () => {
      const store = createWikiPagesStore(setup.queryCapability);

      expect(await store.getPageById(999_999)).toBeUndefined();
      expect(await store.getPageBySlug(NAMESPACE_A, "does-not-exist")).toBeUndefined();
    });

    it("listPages filters by namespace when given one, and lists everything otherwise", async () => {
      const store = createWikiPagesStore(setup.queryCapability);

      await store.createPage({
        namespaceId: NAMESPACE_B,
        slug: "list-test-page",
        title: "List Test",
        content: "Content.",
      });

      const namespaceBPages = await store.listPages(NAMESPACE_B);
      expect(namespaceBPages.every((page) => page.namespaceId === NAMESPACE_B)).toBe(true);
      expect(namespaceBPages.some((page) => page.slug === "list-test-page")).toBe(true);

      const allPages = await store.listPages();
      expect(allPages.length).toBeGreaterThanOrEqual(namespaceBPages.length);
    });
  });

  describe("updatePage", () => {
    it("updates title/content and leaves omitted fields unchanged", async () => {
      const store = createWikiPagesStore(setup.queryCapability);

      const created = await store.createPage({
        namespaceId: NAMESPACE_A,
        slug: "update-me",
        title: "Original Title",
        content: "Original content.",
      });

      const updated = await store.updatePage(created.id, { content: "Updated content." });
      expect(updated.title).toBe("Original Title");
      expect(updated.content).toBe("Updated content.");
      expect(updated.id).toBe(created.id);

      const retitled = await store.updatePage(created.id, { title: "New Title" });
      expect(retitled.title).toBe("New Title");
      expect(retitled.content).toBe("Updated content.");
    });

    it("throws a NotFoundError when updating a page that does not exist — the not-found error path", async () => {
      const store = createWikiPagesStore(setup.queryCapability);

      await expect(store.updatePage(999_999, { title: "Nope" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe("deletePage", () => {
    it("deletes an existing page", async () => {
      const store = createWikiPagesStore(setup.queryCapability);

      const created = await store.createPage({
        namespaceId: NAMESPACE_A,
        slug: "delete-me",
        title: "Delete Me",
        content: "Bye.",
      });

      await store.deletePage(created.id);

      expect(await store.getPageById(created.id)).toBeUndefined();
    });

    it("throws a NotFoundError when deleting a page that does not exist — the not-found error path", async () => {
      const store = createWikiPagesStore(setup.queryCapability);

      await expect(store.deletePage(999_999)).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

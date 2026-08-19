/**
 * Integration tests for `src/plugins/wiki/src/search.ts`'s `searchWikiPages`
 * (feature #94's own minimal scope for the `search` HTTP route — see that
 * module's doc comment). Mirrors `pages-store.integration.test.ts`'s "real
 * mysql2 pool, real `Kysely<Database>` instance, real `db:query`-capability
 * wrapper" pattern and "own migration files' up()/down(), rolled back in
 * afterAll" hygiene, since this module's `LIKE` matching is a genuine SQL
 * behavior worth proving against a real database, not a mock.
 */
import mysql from "mysql2/promise";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ValidationError } from "../../../src/core/errors.js";
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
import { searchWikiPages } from "../../../src/plugins/wiki/src/search.js";

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

const mysqlReachable = await probeMysqlReachable();

if (!mysqlReachable) {
  console.warn(
    "[wiki search.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping the ` +
      "feature #94 wiki search integration suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

function connect(): { pool: mysql.Pool; db: Kysely<Database>; queryCapability: DbQueryCapability } {
  const pool = createDbPool(DOCKER_COMPOSE_CONFIG);
  const db = createKyselyDb(pool);
  const queryCapability = createDbQueryCapability(db);
  return { pool, db, queryCapability };
}

describe.runIf(mysqlReachable)(
  "searchWikiPages — LIKE-based search integration (feature #94)",
  () => {
    const NAMESPACE_A = "feature94-search-ns-a";
    const NAMESPACE_B = "feature94-search-ns-b";

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
          { id: NAMESPACE_A, name: "Feature 94 Search Namespace A" },
          { id: NAMESPACE_B, name: "Feature 94 Search Namespace B" },
        ])
        .execute();

      const store = createWikiPagesStore(setup.queryCapability);
      await store.createPage({
        namespaceId: NAMESPACE_A,
        slug: "alpha-page",
        title: "Alpha Page",
        content: "This page talks about the mercurial-quokka-42 topic at length.",
      });
      await store.createPage({
        namespaceId: NAMESPACE_A,
        slug: "beta-page",
        title: "mercurial-quokka-42 in the title",
        content: "Unrelated body content.",
      });
      await store.createPage({
        namespaceId: NAMESPACE_A,
        slug: "gamma-page",
        title: "Gamma Page",
        content: "Nothing relevant here at all.",
      });
      await store.createPage({
        namespaceId: NAMESPACE_B,
        slug: "delta-page",
        title: "Delta Page",
        content: "Also mentions mercurial-quokka-42, but in a different namespace.",
      });
    });

    afterAll(async () => {
      const cleanup = connect();
      try {
        await createRevisions.down(cleanup.db);
        await createPages.down(cleanup.db);
        await createNamespaces.down(cleanup.db);
      } finally {
        await cleanup.db.destroy();
        await setup.db.destroy();
      }
    });

    it("matches a page whose content contains the term, and excludes an irrelevant page", async () => {
      const results = await searchWikiPages(setup.queryCapability, "mercurial-quokka-42");
      const slugs = results.map((result) => result.slug);

      expect(slugs).toContain("alpha-page");
      expect(slugs).not.toContain("gamma-page");
    });

    it("also matches a page whose title (not content) contains the term", async () => {
      const results = await searchWikiPages(setup.queryCapability, "mercurial-quokka-42");
      expect(results.map((result) => result.slug)).toContain("beta-page");
    });

    it("is case-insensitive", async () => {
      const results = await searchWikiPages(setup.queryCapability, "MERCURIAL-QUOKKA-42");
      expect(results.map((result) => result.slug)).toContain("alpha-page");
    });

    it("scopes to a namespace when one is supplied, excluding a match in a different namespace", async () => {
      const results = await searchWikiPages(
        setup.queryCapability,
        "mercurial-quokka-42",
        NAMESPACE_A,
      );
      const slugs = results.map((result) => result.slug);

      expect(slugs).toContain("alpha-page");
      expect(slugs).not.toContain("delta-page");
    });

    it("searches across every namespace when none is supplied", async () => {
      const results = await searchWikiPages(setup.queryCapability, "mercurial-quokka-42");
      expect(results.map((result) => result.slug)).toContain("delta-page");
    });

    it("returns a snippet that contains the matched term", async () => {
      const results = await searchWikiPages(
        setup.queryCapability,
        "mercurial-quokka-42",
        NAMESPACE_A,
      );
      const alpha = results.find((result) => result.slug === "alpha-page");
      expect(alpha?.snippet).toContain("mercurial-quokka-42");
    });

    it("returns an empty array when nothing matches", async () => {
      const results = await searchWikiPages(setup.queryCapability, "no-such-term-anywhere-xyz");
      expect(results).toEqual([]);
    });

    it("rejects an empty search term with a ValidationError, before ever issuing a query", async () => {
      await expect(searchWikiPages(setup.queryCapability, "   ")).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("treats a literal % in the search term as a literal character, not a wildcard", async () => {
      const store = createWikiPagesStore(setup.queryCapability);
      await store.createPage({
        namespaceId: NAMESPACE_A,
        slug: "percent-page",
        title: "Percent Page",
        content: "Discount is 50%-off this week only.",
      });

      const literalMatch = await searchWikiPages(setup.queryCapability, "50%-off", NAMESPACE_A);
      expect(literalMatch.map((result) => result.slug)).toContain("percent-page");

      // A search for a completely different literal-looking wildcard string
      // must not spuriously match every row the way an unescaped "%" would.
      const noMatch = await searchWikiPages(setup.queryCapability, "99%-off", NAMESPACE_A);
      expect(noMatch.map((result) => result.slug)).not.toContain("percent-page");
    });
  },
);

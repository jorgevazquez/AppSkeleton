/**
 * Integration tests for `src/plugins/wiki/src/search.ts`'s
 * `searchWikiPagesRanked` (feature #92 — "Full-text search across pages").
 *
 * Mirrors `search.integration.test.ts`'s "real mysql2 pool, real
 * `Kysely<Database>` instance, real `db:query`-capability wrapper" pattern
 * and "own migration files' up()/down(), rolled back in afterAll" hygiene —
 * `MATCH() AGAINST()` ranking, snippet highlighting, and the automatic
 * `LIKE`-fallback-when-the-index-is-missing path are all genuine SQL/driver
 * behaviors worth proving against a real database, not a mock.
 *
 * Two `describe` blocks, applying a different migration set each:
 *
 *   - "with the FULLTEXT index applied" — migrations 0001-0004 (the full
 *     set, including feature #92 step 1's own `migrations/
 *     0004_add_wiki_pages_fulltext_index.ts`) — step 3's "a search term
 *     matches the expected pages and irrelevant pages are excluded",
 *     step 2's relevance ranking and highlighted/escaped snippet.
 *   - "without the FULLTEXT index applied (LIKE fallback)" — migrations
 *     0001-0003 only, deliberately *not* 0004 — proves
 *     `searchWikiPagesRanked` still returns real, correct results (via
 *     `search.ts`'s documented `searchWikiPages` fallback) against a
 *     database that hasn't been migrated to have the index yet, rather than
 *     throwing MySQL's raw `ER_FT_MATCHING_KEY_NOT_FOUND` error.
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
import * as addFulltextIndex from "../../../src/plugins/wiki/src/migrations/0004_add_wiki_pages_fulltext_index.js";
import { createWikiPagesStore } from "../../../src/plugins/wiki/src/pages.js";
import { searchWikiPagesRanked } from "../../../src/plugins/wiki/src/search.js";

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
    "[wiki search-ranked.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping the ` +
      "feature #92 wiki ranked-search integration suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

function connect(): { pool: mysql.Pool; db: Kysely<Database>; queryCapability: DbQueryCapability } {
  const pool = createDbPool(DOCKER_COMPOSE_CONFIG);
  const db = createKyselyDb(pool);
  const queryCapability = createDbQueryCapability(db);
  return { pool, db, queryCapability };
}

describe.runIf(mysqlReachable)(
  "searchWikiPagesRanked — FULLTEXT-ranked search integration (feature #92)",
  () => {
    const NAMESPACE_A = "feature92-search-ns-a";
    const NAMESPACE_B = "feature92-search-ns-b";

    let setup: ReturnType<typeof connect>;

    beforeAll(async () => {
      setup = connect();
      for (const table of WIKI_TABLES) {
        await setup.pool.query("DROP TABLE IF EXISTS `" + table + "`");
      }
      await createNamespaces.up(setup.db);
      await createPages.up(setup.db);
      await createRevisions.up(setup.db);
      await addFulltextIndex.up(setup.db);

      await setup.db
        .insertInto("wiki_namespaces")
        .values([
          { id: NAMESPACE_A, name: "Feature 92 Search Namespace A" },
          { id: NAMESPACE_B, name: "Feature 92 Search Namespace B" },
        ])
        .execute();

      const store = createWikiPagesStore(setup.queryCapability);
      await store.createPage({
        namespaceId: NAMESPACE_A,
        slug: "alpha-page",
        title: "Introducing Platypus Migration",
        content:
          "This page is entirely about the platypus migration process, covering platypus " +
          "behavior, platypus habitats, and every other platypus detail you could want. " +
          "The platypus is truly a remarkable creature.",
      });
      await store.createPage({
        namespaceId: NAMESPACE_A,
        slug: "beta-page",
        title: "Weekly Notes",
        content: "This week we briefly discussed the platypus migration plan in passing.",
      });
      await store.createPage({
        namespaceId: NAMESPACE_A,
        slug: "gamma-page",
        title: "Unrelated Page",
        content: "Nothing about aquatic mammals here at all.",
      });
      await store.createPage({
        namespaceId: NAMESPACE_B,
        slug: "delta-page",
        title: "Cross-namespace Platypus Notes",
        content: "Also mentions the platypus migration, but in a different namespace.",
      });
    });

    afterAll(async () => {
      const cleanup = connect();
      try {
        await addFulltextIndex.down(cleanup.db);
        await createRevisions.down(cleanup.db);
        await createPages.down(cleanup.db);
        await createNamespaces.down(cleanup.db);
      } finally {
        await cleanup.db.destroy();
        await setup.db.destroy();
      }
    });

    it("matches pages whose content repeatedly discusses the term, and excludes an irrelevant page", async () => {
      const results = await searchWikiPagesRanked(setup.queryCapability, "platypus");
      const slugs = results.map((result) => result.slug);

      expect(slugs).toContain("alpha-page");
      expect(slugs).toContain("beta-page");
      expect(slugs).not.toContain("gamma-page");
    });

    it("ranks a page that discusses the term at length above one that only mentions it in passing", async () => {
      const results = await searchWikiPagesRanked(setup.queryCapability, "platypus", NAMESPACE_A);
      const alphaIndex = results.findIndex((result) => result.slug === "alpha-page");
      const betaIndex = results.findIndex((result) => result.slug === "beta-page");

      expect(alphaIndex).toBeGreaterThanOrEqual(0);
      expect(betaIndex).toBeGreaterThanOrEqual(0);
      // Higher relevance score first, and the heavily-repeating page ranks
      // strictly above the passing-mention page.
      expect(alphaIndex).toBeLessThan(betaIndex);
      const alpha = results[alphaIndex];
      const beta = results[betaIndex];
      expect(alpha?.relevance).toBeGreaterThan(beta?.relevance ?? 0);
    });

    it("returns results sorted by relevance descending", async () => {
      const results = await searchWikiPagesRanked(setup.queryCapability, "platypus");
      const relevances = results.map((result) => result.relevance);
      const sorted = [...relevances].sort((a, b) => b - a);
      expect(relevances).toEqual(sorted);
    });

    it("scopes to a namespace when one is supplied, excluding a match in a different namespace", async () => {
      const results = await searchWikiPagesRanked(setup.queryCapability, "platypus", NAMESPACE_A);
      const slugs = results.map((result) => result.slug);

      expect(slugs).toContain("alpha-page");
      expect(slugs).not.toContain("delta-page");
    });

    it("returns a snippet with every occurrence of the matched term wrapped in <mark>, HTML-escaped", async () => {
      const results = await searchWikiPagesRanked(setup.queryCapability, "platypus", NAMESPACE_A);
      const alpha = results.find((result) => result.slug === "alpha-page");

      expect(alpha?.snippetHtml).toContain("<mark>platypus</mark>");
      // No un-escaped '<'/'>' outside of the <mark> tags themselves — every
      // '<' in the snippet opens exactly a <mark> or </mark> tag.
      const tagLikeOccurrences = alpha?.snippetHtml.match(/<[^>]*>/g) ?? [];
      expect(tagLikeOccurrences.every((tag) => tag === "<mark>" || tag === "</mark>")).toBe(true);
    });

    it("HTML-escapes a snippet whose content contains markup-shaped characters, without breaking the highlight", async () => {
      const store = createWikiPagesStore(setup.queryCapability);
      await store.createPage({
        namespaceId: NAMESPACE_A,
        slug: "epsilon-page",
        title: "Markup Edge Case",
        content: 'A <script>alert(1)</script> tag & an unescaped quote " near platypus text.',
      });

      const results = await searchWikiPagesRanked(setup.queryCapability, "platypus", NAMESPACE_A);
      const epsilon = results.find((result) => result.slug === "epsilon-page");

      expect(epsilon?.snippetHtml).toContain("<mark>platypus</mark>");
      expect(epsilon?.snippetHtml).not.toContain("<script>");
      expect(epsilon?.snippetHtml).toContain("&lt;script&gt;");
      expect(epsilon?.snippetHtml).toContain("&amp;");
    });

    it("returns an empty array when nothing matches", async () => {
      const results = await searchWikiPagesRanked(
        setup.queryCapability,
        "no-such-term-anywhere-xyz",
      );
      expect(results).toEqual([]);
    });

    it("rejects an empty search term with a ValidationError, before ever issuing a query", async () => {
      await expect(searchWikiPagesRanked(setup.queryCapability, "   ")).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  },
);

describe.runIf(mysqlReachable)(
  "searchWikiPagesRanked — LIKE fallback when the FULLTEXT index is missing (feature #92 step 1)",
  () => {
    const NAMESPACE_A = "feature92-fallback-ns-a";

    let setup: ReturnType<typeof connect>;

    beforeAll(async () => {
      setup = connect();
      for (const table of WIKI_TABLES) {
        await setup.pool.query("DROP TABLE IF EXISTS `" + table + "`");
      }
      // Deliberately omits migration 0004 — proves the fallback path
      // against a database that hasn't been migrated to have the
      // FULLTEXT index yet, not just a mocked-out error.
      await createNamespaces.up(setup.db);
      await createPages.up(setup.db);
      await createRevisions.up(setup.db);

      await setup.db
        .insertInto("wiki_namespaces")
        .values({ id: NAMESPACE_A, name: "Feature 92 Fallback Namespace A" })
        .execute();

      const store = createWikiPagesStore(setup.queryCapability);
      await store.createPage({
        namespaceId: NAMESPACE_A,
        slug: "fallback-alpha",
        title: "Fallback Alpha",
        content: "This page mentions the mercurial-quokka-77 topic.",
      });
      await store.createPage({
        namespaceId: NAMESPACE_A,
        slug: "fallback-gamma",
        title: "Fallback Gamma",
        content: "Nothing relevant here.",
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

    it("still returns matching pages, excluding irrelevant ones, via the LIKE fallback", async () => {
      const results = await searchWikiPagesRanked(
        setup.queryCapability,
        "mercurial-quokka-77",
        NAMESPACE_A,
      );
      const slugs = results.map((result) => result.slug);

      expect(slugs).toContain("fallback-alpha");
      expect(slugs).not.toContain("fallback-gamma");
    });

    it("reports relevance 0 for a fallback result, since LIKE carries no relevance signal", async () => {
      const results = await searchWikiPagesRanked(
        setup.queryCapability,
        "mercurial-quokka-77",
        NAMESPACE_A,
      );
      const alpha = results.find((result) => result.slug === "fallback-alpha");
      expect(alpha?.relevance).toBe(0);
    });

    it("still highlights the matched term in the fallback snippet, safely escaped", async () => {
      const results = await searchWikiPagesRanked(
        setup.queryCapability,
        "mercurial-quokka-77",
        NAMESPACE_A,
      );
      const alpha = results.find((result) => result.slug === "fallback-alpha");
      expect(alpha?.snippetHtml).toContain("<mark>mercurial-quokka-77</mark>");
    });
  },
);

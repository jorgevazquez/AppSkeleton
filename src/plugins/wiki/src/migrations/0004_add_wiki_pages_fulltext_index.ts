/**
 * Adds a MySQL `FULLTEXT` index over `wiki_pages(title, content)` (feature
 * #92 — "Full-text search across pages", step 1: "Add a MySQL FULLTEXT
 * index on page title/content ... with a LIKE-based fallback path
 * documented for non-FULLTEXT-capable configurations").
 *
 * `./search.ts`'s `searchWikiPagesRanked` is the search function that uses
 * this index (`MATCH(title, content) AGAINST(... IN NATURAL LANGUAGE
 * MODE)`), ranking results by MySQL's own relevance score. `./search.ts`'s
 * pre-existing `searchWikiPages` (feature #94's `LIKE`-based match, unaware
 * of this index) is the documented fallback path for a database that
 * hasn't applied this migration, or a non-InnoDB/non-`FULLTEXT`-capable
 * configuration — see that module's doc comment for how
 * `searchWikiPagesRanked` detects a missing index (MySQL error
 * `ER_FT_MATCHING_KEY_NOT_FOUND`) and calls straight through to it.
 *
 * Kysely's schema builder has no `FULLTEXT` index API (it's a MySQL-only
 * concept — Postgres/SQLite dialects have no equivalent syntax), so this
 * migration issues the `ALTER TABLE` directly via Kysely's `sql` tagged
 * template, exactly like `0002_create_wiki_pages.ts`/
 * `0003_create_wiki_revisions.ts` already do for `CURRENT_TIMESTAMP`
 * defaults — the index name and column list are this file's own fixed
 * literal text, never caller/user input, so (like those two migrations'
 * own `sql` usage) there is nothing here for a bound parameter to protect
 * against.
 *
 * No storage-engine `ALTER TABLE ... ENGINE=InnoDB` is needed first —
 * `wiki_pages` (migration 0002) already gets InnoDB, MySQL's default engine
 * since 5.5, and InnoDB has supported `FULLTEXT` indexes since MySQL 5.6.
 */
import { sql, type Kysely } from "kysely";
import type { Database } from "../db.js";

/** Matches `search.ts`'s own reference to this index's name in its `MATCH(title, content)` doc comments. */
export const WIKI_PAGES_FULLTEXT_INDEX = "wiki_pages_fulltext_idx";

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE wiki_pages ADD FULLTEXT INDEX ${sql.raw(WIKI_PAGES_FULLTEXT_INDEX)} (title, content)`.execute(
    db,
  );
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE wiki_pages DROP INDEX ${sql.raw(WIKI_PAGES_FULLTEXT_INDEX)}`.execute(db);
}

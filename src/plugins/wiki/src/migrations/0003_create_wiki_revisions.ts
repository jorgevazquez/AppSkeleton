/**
 * Creates `wiki_revisions` (feature #86, step 1). Each row is an immutable
 * snapshot of a `wiki_pages` row's `title`/`content` at some point in its
 * edit history — feature #89 ("Revision history: every edit creates a
 * revision row") snapshots the *previous* content into a new row here
 * before applying an update, so `wiki_pages.content` always holds the
 * current body and this table holds everything that preceded it.
 *
 * Step 2 ("Include appropriate indexes: ... revision lookup by page"):
 * `wiki_revisions_page_id_idx` is a composite index over `(page_id, id)` —
 * `page_id` alone would satisfy an equality lookup, but the composite form
 * also covers feature #89's "list revisions for a page in
 * reverse-chronological order" query (`WHERE page_id = ? ORDER BY id DESC`)
 * without a separate filesort, since `id` (autoincrement) is a reliable
 * insertion-order tiebreaker — the same rationale `database_mysql_
 * audit_log`'s migration documents for preferring a surrogate order column
 * over a timestamp that two rows could tie on.
 *
 * `page_id` is left without a database-level foreign key into `wiki_pages`,
 * consistent with this codebase's existing association-table migrations
 * (see `wiki_pages`'s own migration doc comment) — enforced at the
 * application layer instead, by whichever feature writes rows here.
 */
import { sql, type Kysely } from "kysely";
import type { Database } from "../db.js";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("wiki_revisions")
    .addColumn("id", "integer", (col) => col.autoIncrement().primaryKey())
    .addColumn("page_id", "integer", (col) => col.notNull())
    .addColumn("title", "varchar(500)", (col) => col.notNull())
    .addColumn("content", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("wiki_revisions_page_id_idx")
    .on("wiki_revisions")
    .columns(["page_id", "id"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("wiki_revisions").execute();
}

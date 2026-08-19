/**
 * Creates `wiki_pages` (feature #86, step 1). `id` is a surrogate
 * autoincrement PK (revisions and future features reference a page by this
 * stable integer rather than its mutable `slug`); `namespace_id` +
 * `slug` together identify a page the way a URL does
 * (`/wiki/<namespace_id>/<slug>`), and `content` holds the page's *current*
 * body — feature #89's revision history snapshots the previous value of
 * this column into `wiki_revisions` on every update, it doesn't replace
 * this column with a join.
 *
 * Step 2 ("Include appropriate indexes: namespace+slug uniqueness ..."):
 * `wiki_pages_namespace_slug_uniq` is a UNIQUE index over
 * `(namespace_id, slug)` — the same slug may exist in two different
 * namespaces (they're different pages), but never twice within one
 * namespace. This is the constraint this feature's own integration test
 * exercises directly.
 *
 * `namespace_id` is left without a database-level foreign key into
 * `wiki_namespaces` — consistent with this codebase's existing
 * association-table migrations (see `wiki_namespaces`'s own migration doc
 * comment); feature #87's "Enforce ... namespace existence on create" step
 * is where that's checked at the application layer via `db:query`.
 */
import { sql, type Kysely } from "kysely";
import type { Database } from "../db.js";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("wiki_pages")
    .addColumn("id", "integer", (col) => col.autoIncrement().primaryKey())
    .addColumn("namespace_id", "varchar(255)", (col) => col.notNull())
    .addColumn("slug", "varchar(255)", (col) => col.notNull())
    .addColumn("title", "varchar(500)", (col) => col.notNull())
    .addColumn("content", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("wiki_pages_namespace_slug_uniq")
    .on("wiki_pages")
    .unique()
    .columns(["namespace_id", "slug"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("wiki_pages").execute();
}

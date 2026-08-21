/**
 * Creates `wiki_attachments` (feature #97 — "Attachments/file upload
 * support for wiki pages"), step 1. Each row is metadata for one file
 * attached to a `wiki_pages` row — `storage_name` is the randomized,
 * on-disk filename `../attachment-storage.ts`'s `generateStorageName()`
 * assigns at upload time (never the caller-supplied `filename`, which is
 * stored purely as display metadata here and never used to address a file
 * on disk — see that module's own doc comment for why the two are kept
 * independent).
 *
 * `page_id` is left without a database-level foreign key into
 * `wiki_pages`, consistent with every other wiki association-table
 * migration in this plugin (see `wiki_revisions`'s own migration doc
 * comment) — enforced at the application layer instead:
 * `../authorized-attachments.ts` only ever creates a row after the owning
 * page has already been looked up (and the caller authorized against its
 * namespace).
 *
 * Indexes:
 *   - `wiki_attachments_page_id_idx` over `page_id` — "list every
 *     attachment on this page" (the `GET /wiki/pages/:id/attachments`
 *     route), the same single-column lookup-index rationale
 *     `wiki_revisions_page_id_idx` documents.
 *   - `wiki_attachments_storage_name_uniq` — a UNIQUE index over
 *     `storage_name` — defense in depth against a `generateStorageName()`
 *     collision (astronomically unlikely at 24 random bytes / 192 bits,
 *     but a unique index costs nothing and turns "silently overwrote
 *     another attachment's blob" into a loud insert failure instead).
 */
import { sql, type Kysely } from "kysely";
import type { Database } from "../db.js";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("wiki_attachments")
    .addColumn("id", "integer", (col) => col.autoIncrement().primaryKey())
    .addColumn("page_id", "integer", (col) => col.notNull())
    .addColumn("filename", "varchar(255)", (col) => col.notNull())
    .addColumn("content_type", "varchar(255)", (col) => col.notNull())
    .addColumn("size_bytes", "integer", (col) => col.notNull())
    .addColumn("storage_name", "varchar(64)", (col) => col.notNull())
    .addColumn("uploaded_by", "varchar(255)")
    .addColumn("created_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("wiki_attachments_page_id_idx")
    .on("wiki_attachments")
    .columns(["page_id"])
    .execute();

  await db.schema
    .createIndex("wiki_attachments_storage_name_uniq")
    .on("wiki_attachments")
    .unique()
    .columns(["storage_name"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("wiki_attachments").execute();
}

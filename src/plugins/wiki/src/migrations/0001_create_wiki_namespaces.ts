/**
 * Creates `wiki_namespaces` (feature #86, step 1). A namespace is the top
 * level of the wiki's page hierarchy (e.g. "main", "help", "user") — every
 * page lives in exactly one namespace (`wiki_pages.namespace_id`, added by
 * the next migration), and a namespace may itself nest under a parent
 * namespace via `parent_id`, so feature #91's "3-level namespace hierarchy"
 * / nested page-tree query has a real column to walk.
 *
 * `id` is the stable, human-chosen slug (e.g. "main", "help"), not a
 * surrogate — mirrors `rbac_roles`/`rbac_permissions`'s "referenced by the
 * same string a plugin author/URL writes" precedent (see
 * `rbac/src/migrations/0001_create_rbac_roles.ts`), since a namespace id
 * appears directly in page URLs (`/wiki/<namespace>/<slug>`).
 *
 * `parent_id` is nullable (a top-level namespace has no parent) and left
 * without a database-level foreign key — this codebase's existing
 * migrations (`rbac_user_roles`, etc.) don't use FK constraints either,
 * relying on application-level checks instead (see feature #87's "Enforce
 * ... namespace existence on create" step) — but it is indexed so a
 * "children of namespace X" lookup (feature #91) doesn't require a table
 * scan.
 */
import type { Kysely } from "kysely";
import type { Database } from "../db.js";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("wiki_namespaces")
    .addColumn("id", "varchar(255)", (col) => col.primaryKey())
    .addColumn("parent_id", "varchar(255)")
    .addColumn("name", "varchar(255)", (col) => col.notNull())
    .addColumn("description", "varchar(1000)")
    .execute();

  await db.schema
    .createIndex("wiki_namespaces_parent_id_idx")
    .on("wiki_namespaces")
    .column("parent_id")
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("wiki_namespaces").execute();
}

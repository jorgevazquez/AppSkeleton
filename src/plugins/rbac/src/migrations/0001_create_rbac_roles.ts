/**
 * Creates `rbac_roles` (feature #34, step 1) — mirrors `types.ts`'s
 * `Role` interface: `id` (stable, lowercase-kebab-case identifier, e.g.
 * "wiki-editor") is the primary key, not a surrogate, so a role can be
 * referenced by the same string a plugin author writes in code.
 */
import type { Kysely } from "kysely";
import type { Database } from "../db.js";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("rbac_roles")
    .addColumn("id", "varchar(255)", (col) => col.primaryKey())
    .addColumn("name", "varchar(255)", (col) => col.notNull())
    .addColumn("description", "varchar(1000)")
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("rbac_roles").execute();
}

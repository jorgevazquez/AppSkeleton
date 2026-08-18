/**
 * Creates `rbac_permissions` (feature #34, step 1) — mirrors `types.ts`'s
 * `Permission` interface: `id` is the canonical `"resource:action"` string
 * (see `permission.ts`'s `toPermission`), the primary key, with `resource`/
 * `action` stored alongside it (denormalized from `id`) purely so a caller
 * can filter/select on either segment without re-parsing the string.
 */
import type { Kysely } from "kysely";
import type { Database } from "../db.js";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("rbac_permissions")
    .addColumn("id", "varchar(255)", (col) => col.primaryKey())
    .addColumn("resource", "varchar(255)", (col) => col.notNull())
    .addColumn("action", "varchar(255)", (col) => col.notNull())
    .addColumn("description", "varchar(1000)")
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("rbac_permissions").execute();
}

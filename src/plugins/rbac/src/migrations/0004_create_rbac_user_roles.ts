/**
 * Creates `rbac_user_roles` (feature #34, step 1) — the user->role
 * association table mirroring `types.ts`'s `UserRole` interface.
 * `(user_id, role_id)` is the composite primary key (no surrogate `id`).
 * `user_id` is intentionally not a foreign key into any table this plugin
 * owns — see `types.ts`'s `UserRole` doc comment: user identity is owned
 * elsewhere, this plugin only records which roles a given user id holds.
 */
import type { Kysely } from "kysely";
import type { Database } from "../db.js";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("rbac_user_roles")
    .addColumn("user_id", "varchar(255)", (col) => col.notNull())
    .addColumn("role_id", "varchar(255)", (col) => col.notNull())
    .addPrimaryKeyConstraint("rbac_user_roles_pk", ["user_id", "role_id"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("rbac_user_roles").execute();
}

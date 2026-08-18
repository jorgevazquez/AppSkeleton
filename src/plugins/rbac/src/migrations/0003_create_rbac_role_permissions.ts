/**
 * Creates `rbac_role_permissions` (feature #34, step 1) — the
 * role->permission association table mirroring `types.ts`'s
 * `RolePermission` interface. `(role_id, permission_id)` is the composite
 * primary key (no surrogate `id`), matching that interface's own doc
 * comment: "a given pair should appear at most once in any store."
 */
import type { Kysely } from "kysely";
import type { Database } from "../db.js";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("rbac_role_permissions")
    .addColumn("role_id", "varchar(255)", (col) => col.notNull())
    .addColumn("permission_id", "varchar(255)", (col) => col.notNull())
    .addPrimaryKeyConstraint("rbac_role_permissions_pk", ["role_id", "permission_id"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("rbac_role_permissions").execute();
}

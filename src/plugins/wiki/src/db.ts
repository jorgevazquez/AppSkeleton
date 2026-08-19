/**
 * The generic `Kysely` schema shape this plugin's persistence layer is
 * typed against (feature #86 — "Database schema/migrations: pages,
 * revisions, namespaces").
 *
 * This plugin must not import `src/plugins/database-mysql/src/db.ts`'s own
 * `Database` type directly — `docs/plugin-conventions.md` section 5
 * forbids a plugin from importing another plugin's internals, only its
 * kernel-brokered capabilities. Instead this mirrors that file's own
 * generic index-signature shape verbatim, exactly like `rbac/src/db.ts`'s
 * own copy of the same pattern (see that file's doc comment for the full
 * rationale): a real `Kysely<Database>` instance handed in by the
 * `db:query` capability (whatever concrete plugin backs it) is
 * structurally assignable here with zero cast, since TypeScript compares
 * this index signature structurally, not nominally.
 */
export interface Database {
  [table: string]: Record<string, unknown>;
}

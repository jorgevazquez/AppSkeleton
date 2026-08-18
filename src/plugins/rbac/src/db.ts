/**
 * The generic `Kysely` schema shape this plugin's persistence layer is
 * typed against (feature #34 — "Persistent storage for roles, permissions,
 * and assignments via database-mysql").
 *
 * This plugin must not import `src/plugins/database-mysql/src/db.ts`'s own
 * `Database` type directly — `docs/plugin-conventions.md` section 5
 * forbids a plugin from importing another plugin's internals, only its
 * kernel-brokered capabilities. Instead this mirrors that file's own
 * generic index-signature shape verbatim (same rationale `src/core/seed.ts`
 * documents for its own `SeedableDatabase`): a real `Kysely<Database>`
 * instance handed in by the `db:query` capability (whatever concrete
 * plugin backs it) is structurally assignable here with zero cast, since
 * TypeScript compares this index signature structurally, not nominally.
 */
export interface Database {
  [table: string]: Record<string, unknown>;
}

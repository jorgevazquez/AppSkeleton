# Migrations

Empty at this stage — no other shipped feature has needed a real table yet
(see `claude-progress.txt`). This directory is where this plugin's own
production migrations land as later features need them; the runner itself
(`../migrator.ts`) and its CLI (`../migrate.ts`, wired up as `npm run
migrate` / `npm run migrate:down`) are already fully built and tested
(feature #19) — `npm run migrate` against an empty directory is a normal,
successful no-op ("Nothing to migrate — already up to date.").

## Writing a migration

Each migration is a single file whose name starts with a zero-padded
sequence number, e.g. `0001_create_widgets.ts` — filenames sort
lexicographically to determine run order, so always zero-pad and always
add new migrations with a higher number than every existing one. A file
must export both an `up` and a `down` function, each receiving the plugin's
shared `Kysely<Database>` instance (actually a `Transaction<Database>` —
the runner wraps every migration in its own transaction):

```ts
import type { Kysely } from "kysely";
import type { Database } from "../db.js";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("database_mysql_widgets")
    .addColumn("id", "integer", (col) => col.autoIncrement().primaryKey())
    .addColumn("name", "varchar(255)", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("database_mysql_widgets").execute();
}
```

**Never edit an already-applied migration file.** The runner hashes each
file's raw source on every run and compares it against the checksum it
recorded when the migration was applied — a mismatch is treated as a
tampered/inconsistent history and refuses to run _any_ further migrations
(up or down) until it's resolved. If a mistake ships, write a new
migration that corrects it instead of editing history.

## Table naming convention: `<plugin_id>_<table>` (enforced)

spec.md requires "a per-plugin schema/table namespace convention so
plugins cannot collide" (feature #22). Every table a plugin's migration
creates **must** be named `<plugin_id>_<table>`, where `<plugin_id>` is
that plugin's own id with any `-` converted to `_` (MySQL identifiers are
conventionally snake_case) — e.g. plugin id `database-mysql` → prefix
`database_mysql_`, so `database_mysql_widgets` is valid and `widgets` (no
prefix) or `rbac_widgets` (a different plugin's prefix) are not.

This is not just a documented convention — the migration runner
(`../migrator.ts`) **enforces** it at run time. `runMigrationsUp()`/
`runMigrationsDown()` both require an `options.pluginId`, and wrap the
`db` handed to a migration's `up()`/`down()` so every
`db.schema.createTable(name)` call is checked (via `assertTableNamespace()`)
_before_ it ever reaches MySQL. A migration that tries to create a table
outside its own plugin's namespace — including one that happens to match
a _different_ plugin's namespace, since every plugin's prefix is unique —
throws a `MigrationError` naming the plugin, the offending table, and the
required prefix, and its transaction rolls back; nothing is created. See
`../migrator.ts`'s "Per-plugin table namespace enforcement" doc section
and `../migrator.test.ts`'s `assertTableNamespace`/`withTableNamespaceGuard`
suites for the exact behavior.

The one exception is `schema_migrations` itself (this runner's own
tracking table, not a plugin-owned domain table) — see feature #19's notes
for why it deliberately isn't namespaced.

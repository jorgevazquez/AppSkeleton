# database-mysql plugin

Owns the MySQL connection pool, migrations, and the db:query / db:transaction capability.

Deliberately empty at scaffold time — built out by its entries in
`feature_list.json`. Must be a self-contained plugin: `plugin.json`
manifest, lifecycle entry point, `src/`, `tests/`. No importing another
plugin's internals directly — only kernel-brokered capabilities. See
`spec.md` and the `plugin-builder` plugin's conventions once built.

# wiki plugin

Basic Wiki application: Markdown pages, revision history, search — built entirely on the other plugins' capabilities.

Deliberately empty at scaffold time — built out by its entries in
`feature_list.json`. Must be a self-contained plugin: `plugin.json`
manifest, lifecycle entry point, `src/`, `tests/`. No importing another
plugin's internals directly — only kernel-brokered capabilities. See
`spec.md` and the `plugin-builder` plugin's conventions once built.

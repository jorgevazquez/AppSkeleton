/**
 * Fixture plugin for `tests/plugins/plugin-builder/conventions-linter.test.ts`
 * (feature #77): the "bad naming" failing case. `plugin.json`'s `id`
 * ("great-plugin") is schema-valid lowercase-kebab-case on its own — this
 * is deliberately NOT the kind of violation `validateManifest()` already
 * catches (see `tests/core/manifest.test.ts`) — but does not match this
 * directory's actual name ("good-plugin"), which
 * `docs/plugin-conventions.md` section 2.1 requires.
 */
export {};

# Plugin Conventions

This document is the normative reference for how an AppSkeleton plugin is
shaped: naming rules, the manifest (`plugin.json`), the capability naming
grammar, directory layout, and cross-plugin import rules. It exists so a
human _or an AI coding agent_ (see spec.md's `plugin-builder` plugin, which
is meant to hand this exact document to an agent as unambiguous context) can
author a new, spec-compliant plugin without having to reverse-engineer the
rules from the kernel source.

**Source of truth.** Every regex and shape documented below is not a
hand-copied description — it is quoted from `src/core/manifest.ts`'s
exported constants (`PLUGIN_ID_PATTERN`, `CAPABILITY_PATTERN`,
`ENTRY_POINT_PATTERN`, `PluginManifestSchema`), which is the actual zod
schema the kernel validates every `plugin.json` against. A dedicated test,
`tests/core/plugin-conventions.test.ts`, parses this file and asserts each
regex block below is byte-for-byte identical to the corresponding exported
pattern's `.source` — so this document and the validator cannot silently
drift apart. If you change a pattern in `manifest.ts`, update the matching
block below (and its prose) in the same change, or that test will fail.

## 1. Directory layout

Every plugin lives in its own directory under `src/plugins/<plugin-id>/` and
is self-contained (spec.md, "Directory Layout"):

```
src/plugins/<plugin-id>/
  plugin.json     # required — the manifest described in section 3
  index.ts        # the lifecycle entry point named by plugin.json's entry_point
  src/            # the plugin's own implementation, private to the plugin
  tests/          # tests for this plugin (mirrored under tests/plugins/<plugin-id>/
                  # in this repo's actual layout — see below)
```

In this repository specifically, tests live in a parallel tree rather than
inside each plugin directory:

```
AppSkeleton/
  src/
    core/                      # the kernel — the only non-plugin code
      manifest.ts  registry.ts  loader.ts  broker.ts  graph.ts
      events.ts    config.ts    logger.ts  errors.ts  types.ts
    server/
      index.ts                 # bootstrap: load kernel, mount plugins, listen
    plugins/
      <plugin-id>/
        plugin.json
        index.ts                # optional until the plugin has real lifecycle logic
        src/
          ...                   # plugin-private modules
  tests/
    core/                       # kernel unit/integration tests
    plugins/
      <plugin-id>/
        ...                     # this plugin's tests
```

`src/core/registry.ts`'s `scanPluginDirectories()` treats `plugin.json` as
the only required file for a directory under `src/plugins/*` to count as a
plugin at all — a directory missing it is skipped (not an error) with reason
`missing_manifest`. `entry_point`'s existence on disk is **not** checked at
scan or validation time, so a scaffold-only plugin (manifest plus tests, no
implementation yet) is valid; several shipped plugins in this repo are
currently in exactly that state.

## 2. Naming rules

### 2.1 Plugin id

A plugin's `id` (in its manifest) must match its directory name under
`src/plugins/`, and must be **lowercase-kebab-case**: it starts with a
letter, may contain digits, and segments are separated by single hyphens
(no leading/trailing/doubled hyphens). Source: `PLUGIN_ID_PATTERN` in
`src/core/manifest.ts`.

```plugin-id-regex
^[a-z][a-z0-9]*(-[a-z0-9]+)*$
```

Valid: `rbac`, `database-mysql`, `html-renderer`, `api-gateway`,
`plugin-builder`, `wiki`. Invalid: `Database-MySQL` (uppercase),
`database_mysql` (underscore), `-database` (leading hyphen), `database--sql`
(doubled hyphen).

### 2.2 Entry point

`entry_point` is a relative path (no leading `/`, no `..` traversal segment)
ending in a JS/TS module extension (`.ts`, `.js`, `.mjs`, `.cjs`). Source:
`ENTRY_POINT_PATTERN` in `src/core/manifest.ts`.

```entry-point-regex
^(?!\/)(?!.*\.\.(?:\/|$))[A-Za-z0-9_./-]+\.(?:ts|js|mjs|cjs)$
```

Valid: `index.ts`, `src/index.ts`. Invalid: `/index.ts` (absolute),
`../shared/index.ts` (escapes the plugin directory), `index.py` (wrong
extension).

## 3. Manifest shape (`plugin.json`)

Validated by `PluginManifestSchema` / `validateManifest()` in
`src/core/manifest.ts`. The object is `.strict()` at every level: an unknown
field fails validation loudly (`unknown_field`) rather than being silently
ignored.

| Field                   | Type         | Required  | Notes                                                                                                                                                                                                                          |
| ----------------------- | ------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                    | string       | yes       | Section 2.1's `PLUGIN_ID_PATTERN`; must match the plugin's directory name.                                                                                                                                                     |
| `version`               | string       | yes       | Canonical SemVer 2.0.0 (`x.y.z`, optional `-prerelease`, optional `+build`); no leading `v`.                                                                                                                                   |
| `depends_on`            | object (map) | no (`{}`) | Other plugin ids -> the semver _range_ of that plugin this one is compatible with (e.g. `{"rbac": "^1.0.0"}`), mirroring npm's `package.json#dependencies`. A hard, load-order-enforcing edge — see section 5.                 |
| `capabilities.provides` | string array | no (`[]`) | Capability ids (section 4 grammar) this plugin implements as extension points for others. No duplicates within the array.                                                                                                      |
| `capabilities.requires` | string array | no (`[]`) | Capability ids (section 4 grammar) this plugin may ever ask the broker to `obtain()`. This is a **ceiling**, not a guarantee — obtaining still requires an operator grant and a live provider. No duplicates within the array. |
| `entry_point`           | string       | yes       | Section 2.2's `ENTRY_POINT_PATTERN`, relative to the plugin's own directory.                                                                                                                                                   |

Minimal valid example:

```json
{
  "id": "wiki",
  "version": "0.1.0",
  "entry_point": "index.ts"
}
```

(`depends_on` and `capabilities` default to `{}` / `{ provides: [], requires: [] }` when omitted.)

Fully populated example:

```json
{
  "id": "database-mysql",
  "version": "1.2.3",
  "depends_on": { "rbac": "^1.0.0" },
  "capabilities": {
    "provides": ["db:query", "db:transaction"],
    "requires": ["config:read"]
  },
  "entry_point": "index.ts"
}
```

## 4. Capability naming grammar

Every capability id — in `capabilities.provides`, `capabilities.requires`,
and every runtime call into the broker (`declareRequirement`,
`registerProvider`, `grant`, `obtain`, ...) — follows one fixed grammar:
`<namespace>:<action>` (spec.md's rbac section calls the same shape
"resource:action" for permission strings like `can(user, action,
resource)`; it is the same two-lowercase-kebab-segments-joined-by-a-colon
idea applied to two different sets of strings — permissions vs.
capabilities). Each of the two segments is independently lowercase-kebab-case
(same rule as a plugin id in section 2.1). Source: `CAPABILITY_PATTERN` in
`src/core/manifest.ts`.

```capability-grammar-regex
^[a-z][a-z0-9]*(-[a-z0-9]+)*:[a-z][a-z0-9]*(-[a-z0-9]+)*$
```

Valid: `db:query`, `db:transaction`, `http:route`, `render:template`,
`rbac:check`, `config:read`. Invalid: `dbquery` (no colon), `db:` /
`:query` (empty segment), `db:query:extra` (more than one colon), `Db:Query`
(uppercase), `db_query:read` (underscore instead of hyphen inside a
segment).

A capability id appearing more than once in the same `provides` or
`requires` array fails validation (`duplicate_capability`) — see
`rejectDuplicateCapabilities()` in `src/core/manifest.ts`.

## 5. Import rules (forbidden cross-plugin imports)

Per spec.md's Directory Layout section:

> Each plugin directory is self-contained: `plugin.json`, `index.ts`
> (lifecycle entry), `src/`, `tests/`. No plugin imports another plugin's
> internals directly — only via kernel-brokered capabilities.

Concretely, code under `src/plugins/<plugin-id>/**`:

- **May** import from `src/core/**` (the kernel — manifest types, `Result`,
  error classes, the logger, etc.) and from npm packages.
- **May** import from its own `src/plugins/<plugin-id>/**` tree.
- **Must not** import — via a relative path, a workspace alias, or any other
  mechanism — from `src/plugins/<other-plugin-id>/**` for any
  `<other-plugin-id> !== <plugin-id>`. There is no such thing as a plugin's
  "public" subset of files another plugin is allowed to reach into; the
  _only_ sanctioned channel between two plugins is a capability obtained
  through the broker (`context.capabilities.obtain(capabilityId)`), which is
  itself gated by the plugin's own declared `capabilities.requires`, an
  operator grant, and a registered provider (see `src/core/broker.ts`).
  This is what "no global singletons reached via bare imports for
  cross-plugin access" (spec.md, Kernel Architecture) means in practice.
- A plugin **also must not** reach into `src/server/**` (the bootstrap) —
  the bootstrap composes plugins, plugins never compose or reference the
  bootstrap. (`src/plugins/database-mysql/src/migrate.ts` is the existing
  precedent: it deliberately reimplements a small helper locally rather than
  importing it from `src/server/index.ts`, specifically to keep this
  invariant, per `claude-progress.txt`'s notes on that feature.)

Tests are the one deliberate exception to plugin-privacy in this repo's
layout: a test file under `tests/plugins/<plugin-id>/**` may of course
import from `src/plugins/<plugin-id>/**` (that is what it is testing), but
must not import from another plugin's `src/` either — a plugin's tests
exercise that plugin (and, for kernel-integration tests, the kernel), not a
sibling plugin's internals.

This rule is documented here as the authoritative statement of the
convention; automated static enforcement (a linter that flags a violating
import, as opposed to relying on code review) is the `plugin-builder`
plugin's job (spec.md: "a static validator/linter that checks an existing
plugin directory against kernel conventions (naming, capability
declarations, no forbidden imports)") and is intentionally out of scope for
this document.

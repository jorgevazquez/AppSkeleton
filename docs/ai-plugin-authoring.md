# AI Agent Plugin Authoring Guide

**Audience: you are an AI coding agent** about to author a new AppSkeleton
plugin, or to scaffold one on a human's behalf (spec.md's `plugin-builder`
plugin, section 5: "Markdown docs written specifically to be an unambiguous
prompt/context for AI agents authoring new plugins" — this is that
document). It is self-contained: everything needed to produce a
spec-compliant plugin — the manifest shape, the capability grammar, the
directory layout, the lifecycle module contract, and a full worked example
— is below. You should not need to read kernel source to succeed, though
every claim here is traceable to one (file:line citations are given so you
can verify instead of trusting prose).

Read the whole document once before writing any file. Section 8 is a
complete worked example; sections 1–7 are the reference material that
example draws on. If you only want the fastest path to a working plugin,
jump to §0's checklist, then §8 — but do not skip §3 (forbidden imports)
and §6 (validation), which are the two ways a first attempt most commonly
fails.

This document's sibling, `docs/plugin-conventions.md` (feature #15), is the
normative reference the kernel's own tests cross-check against — its
regexes are quoted from `src/core/manifest.ts` and a dedicated test
(`tests/core/plugin-conventions.test.ts`) fails the build if they drift.
This document quotes the same regexes for the same reason (see §2.2) and
adds what that one doesn't: a step-by-step authoring procedure, an explicit
decision tree, a worked example built from real shipped plugins, and a
troubleshooting FAQ aimed at the mistakes an agent unfamiliar with this
codebase actually makes. If the two ever appear to disagree, `manifest.ts`
is the ultimate source of truth for both, and it is worth re-reading before
trusting either doc.

### A note on the code samples in this document

Every TypeScript import in this document — including in code you're meant
to copy verbatim (§6.2, §8) — points at a `.js` extension even when the
file being imported is actually `.ts` (e.g.
`from "../../../src/core/manifest.js"`). This is not a typo: this repo
uses TypeScript's NodeNext module resolution, under which an import
specifier always names the extension the file will have _after
compilation_, regardless of the source file's own extension. Keep the
`.js` extension when you copy these imports — changing it to `.ts` will
fail to build.

## 0. Checklist (tl;dr)

To create plugin `<id>`:

1. Pick `<id>`: lowercase-kebab-case (§2.1). It will also be your directory
   name — the two must match exactly.
2. Create `src/plugins/<id>/plugin.json` (§2) with `id`, `version`,
   `entry_point`, and (if applicable) `depends_on` / `capabilities`.
3. Create `src/plugins/<id>/index.ts` (§4) exporting whichever of
   `onInstall` / `onEnable` / `onDisable` / `onUninstall` / `provides` you
   need — all are optional.
4. Create `src/plugins/<id>/src/` for any implementation code the entry
   point delegates to (optional, but conventional once there is more than a
   few lines of logic — see §7).
5. Create `tests/plugins/<id>/manifest.test.ts` (§6) asserting the manifest
   is discoverable and valid — copy the pattern in §6.2 verbatim, it is
   identical across every shipped plugin.
6. Run `npm run lint && npm run build && npx vitest run tests/plugins/<id>` and
   fix anything that fails before considering the plugin done.
7. Never import from `src/plugins/<other-id>/**` or `src/server/**` (§3).
   If you need something from another plugin, that plugin must first
   `provide` it as a capability, and yours must `require` it — there is no
   other channel.

## 1. Mental model

Six facts, in order, that everything else follows from:

1. **The kernel (`src/core/**`) is the only non-plugin code.** Everything
   else — `rbac`, `database-mysql`, `html-renderer`, `api-gateway`,
   `plugin-builder`, `wiki`, and whatever you are about to add — is a
   plugin under `src/plugins/<id>/`, discovered, validated, and
   instantiated by the kernel. A plugin never imports the kernel's
   bootstrap (`src/server/**`); the bootstrap composes plugins, not the
   reverse.
2. **A plugin describes itself with one file: `plugin.json`.** This is the
   _manifest_ (§2). It is the only thing `src/core/registry.ts`'s
   `scanPluginDirectories()` requires for a directory to count as a plugin
   at all (`src/core/registry.ts:29-49`) — a directory without one is
   silently skipped, not an error.
3. **A plugin's actual code is optional at the manifest level.**
   `entry_point`'s existence on disk is not checked at scan or validation
   time (`docs/plugin-conventions.md` §1) — a manifest-only "scaffold" is a
   structurally valid plugin. In practice, though, a plugin exists to _do_
   something, so §8's worked example includes a working `index.ts`, not
   just a manifest.
4. **Plugins never see each other's internals.** The only channel between
   two plugins is a _capability_: plugin A `provides` one under a name like
   `db:query`; plugin B declares in its own manifest that it `requires`
   that same name; an operator (or, in tests, the loader's default policy)
   `grant`s it; only then can B's code call
   `context.capabilities.obtain("db:query")` and get a live handle. See §3
   and §5.
5. **A capability id is not a permission by itself.** `requires` in a
   manifest is a _ceiling_ — the most that plugin could ever be granted —
   not a promise that it will be. `obtain()` can fail at runtime even for a
   correctly-declared, correctly-spelled capability id if nothing granted
   it or nothing is currently registered to provide it
   (`src/core/broker.ts:124-134`). Don't assume a capability is available;
   check the `Result` `obtain()` returns.
6. **Every regex quoted in this document is the kernel's real validator**,
   copy-pasted from `src/core/manifest.ts`'s exported constants, not a
   paraphrase. If you need to double check one, that file is the ground
   truth.

## 2. The manifest (`plugin.json`)

Validated by `PluginManifestSchema` in `src/core/manifest.ts`. The schema
is `.strict()` at every object level: **an unrecognized field fails
validation** (`unknown_field`) instead of being silently dropped. Do not
add fields beyond the five below, even ones that seem harmless (e.g. a
`description` or `author` field) — they will fail validation.

| Field                   | Type         | Required | Default |
| ----------------------- | ------------ | -------- | ------- |
| `id`                    | string       | yes      | —       |
| `version`               | string       | yes      | —       |
| `depends_on`            | object (map) | no       | `{}`    |
| `capabilities.provides` | string array | no       | `[]`    |
| `capabilities.requires` | string array | no       | `[]`    |
| `entry_point`           | string       | yes      | —       |

The absolute minimum valid manifest — no dependencies, no capabilities —
relies on the schema defaulting `depends_on` to `{}` and `capabilities` to
`{ provides: [], requires: [] }` when they're omitted entirely:

```json
{
  "id": "wiki",
  "version": "0.1.0",
  "entry_point": "index.ts"
}
```

That said, **every plugin actually shipped in this repo spells these
fields out explicitly even when empty** — `"depends_on": {}` and
`"capabilities": {"provides": [...], "requires": []}` — rather than relying
on the default (see §7.1's and §7.2's real `plugin.json` files, and §8's
worked example). Follow that convention for a new plugin too: it makes a
manifest's shape self-evident at a glance instead of requiring the reader
to know the schema's defaults. Omitting them is not wrong — the validator
accepts both — but explicit-empty is the idiomatic style here.

### 2.1 `id`

Must be **lowercase-kebab-case** and must **exactly match the plugin's
directory name** under `src/plugins/`. Source: `PLUGIN_ID_PATTERN` in
`src/core/manifest.ts:44`.

```plugin-id-regex
^[a-z][a-z0-9]*(-[a-z0-9]+)*$
```

Valid: `rbac`, `database-mysql`, `html-renderer`, `plugin-builder`. Invalid,
with the specific reason: `Database-MySQL` (uppercase not allowed anywhere
in the id), `database_mysql` (underscores are never valid — only hyphens
separate segments), `-database` (cannot start with a hyphen — must start
with a letter), `database--sql` (no doubled hyphens), `2fa` (cannot start
with a digit — must start with a letter, digits are only allowed _after_
the first character).

### 2.2 `version`

Canonical SemVer 2.0.0: `MAJOR.MINOR.PATCH` with optional `-prerelease` and
optional `+build`. No leading `v`. New plugins should start at `0.1.0`
(every shipped plugin in this repo currently does). `1.0.0`, `0.1.0-beta.1`,
and `2.3.4+build.5` are all valid; `v1.0.0` and `1.0` are not.

### 2.3 `depends_on`

A map of _other_ plugin ids to the semver **range** of that plugin this one
needs, e.g. `{"rbac": "^1.0.0"}` — the same shape as npm's
`package.json#dependencies`. This is a **hard, load-order-enforcing edge**:
the kernel's loader (`src/core/graph.ts`) refuses to start your plugin
before every dependency named here has finished loading, and refuses to
start it at all if the dependency is missing or its installed version
doesn't satisfy the range.

Leave this `{}` (or omit it) unless your plugin's _own load sequence_
genuinely cannot proceed without another plugin already being loaded —
which, in this codebase, is rare. `depends_on` is not how you consume a
capability; that's what `capabilities.requires` plus a runtime `obtain()`
call is for (see §5). None of the six plugins currently shipped in this
repo (`rbac`, `database-mysql`, `html-renderer`, `api-gateway`,
`plugin-builder`, `wiki`) declares a non-empty `depends_on` — every
cross-plugin need so far is expressed through capabilities instead. Default
to the same choice: an empty `depends_on` plus `capabilities.requires` for
whatever you actually need from another plugin.

### 2.4 `capabilities`

`{ provides: string[], requires: string[] }`, each defaulting to `[]`. See
§4 for the id grammar and §5 for what `provides`/`requires` actually do at
runtime. No duplicate id may appear twice within the same array — the
validator rejects that (`duplicate_capability`,
`src/core/manifest.ts:111-129`) — but the same id may legitimately appear
in both `provides` and `requires` of _different_ plugins (one plugin
provides `db:query`, several others require it).

### 2.5 `entry_point`

A relative path (no leading `/`, no `..` segment) ending in `.ts`, `.js`,
`.mjs`, or `.cjs`. Source: `ENTRY_POINT_PATTERN` in
`src/core/manifest.ts:65`.

```entry-point-regex
^(?!\/)(?!.*\.\.(?:\/|$))[A-Za-z0-9_./-]+\.(?:ts|js|mjs|cjs)$
```

Every shipped plugin in this repo uses `"index.ts"`. Use the same unless
you have a specific reason not to — an agent reading this repo's existing
plugins will expect it.

## 3. Directory layout and import isolation

Your plugin's own files:

```
src/plugins/<id>/
  plugin.json     # required (§2)
  index.ts        # the module named by plugin.json's entry_point (§4)
  src/            # your own implementation modules, private to this plugin
  README.md       # optional, but every shipped plugin has one
```

Its tests live in a **parallel tree**, not inside the plugin directory —
this is a repo-specific layout choice, different from spec.md's generic
per-plugin `tests/` sketch:

```
tests/plugins/<id>/
  manifest.test.ts   # required — see §6.2
  ...                # any other tests for this plugin's own logic
```

`src/core/**` (kernel: `manifest.ts`, `registry.ts`, `loader.ts`,
`broker.ts`, `graph.ts`, `events.ts`, `config.ts`, `logger.ts`, `errors.ts`,
`types.ts`) is free to import from — every plugin does.

**The rule that is easiest to violate by accident, because nothing stops
you syntactically:**

> Code under `src/plugins/<id>/**` must never import — by relative path,
> alias, or any other mechanism — from `src/plugins/<other-id>/**` for any
> `other-id !== id`, and must never import from `src/server/**`.

There is no "public subset" of another plugin's files you're allowed to
reach into, even a file that looks like an exported API. The _only_
sanctioned channel between two plugins is a capability obtained through the
broker (§5) — `context.capabilities.obtain("some:capability")` — gated by
your own manifest's `capabilities.requires`, an operator grant, and a
registered provider. If you find yourself about to write
`import { something } from "../../rbac/src/policy.js"` from inside another
plugin's directory: stop. Either that thing should be exposed as a
capability by `rbac`'s own `index.ts` (and consumed via `obtain()`), or you
don't actually need it.

The one deliberate exception: a test file under `tests/plugins/<id>/**` may
import from `src/plugins/<id>/**` — that's what it's testing — but still
never from a _sibling_ plugin's `src/`.

(This section restates `docs/plugin-conventions.md` §5, the normative
version of this rule, in the imperative voice an agent about to write an
import statement needs.)

## 4. The lifecycle module (`index.ts`)

What your `entry_point` module is expected to export — the `PluginModule`
interface, `src/core/loader.ts:115-121`:

```ts
export interface PluginModule {
  onInstall?: PluginLifecycleHook;
  onEnable?: PluginLifecycleHook;
  onDisable?: PluginLifecycleHook;
  onUninstall?: PluginLifecycleHook;
  provides?: Readonly<Record<string, unknown>>;
}
```

**Every one of these five exports is optional.** A plugin that only
provides a capability and needs no setup can skip all four lifecycle hooks
and export only `provides`. A plugin with nothing to provide and nothing to
set up can export nothing at all (§1, fact 3) — though that's unusual
outside a scaffold-in-progress.

`PluginLifecycleHook` (`src/core/loader.ts:105`) is
`(context: PluginLifecycleContext) => void | Promise<void>` — synchronous
or async, the loader always awaits it either way.

`PluginLifecycleContext` (`src/core/loader.ts:82-102`) — what every hook
receives:

```ts
export interface PluginLifecycleContext {
  readonly manifest: PluginManifest; // this plugin's own validated manifest
  readonly capabilities: PluginCapabilityAccess; // { obtain(capabilityId) }, bound to this plugin's id
  readonly logger: Logger; // pre-scoped with { plugin: manifest.id }
  readonly auditSink?: AuditSink; // optional; treat "missing" as "don't audit", never as an error
}
```

**When each hook runs, and what to put in it** (`src/core/loader.ts:1-70`):

- **`onInstall`** — runs first. Use it for synchronous setup:
  reading/validating config, wiring `context.auditSink` into your own
  module state (rbac's pattern, §7.1), anything that should fail fast and
  loudly if misconfigured. `database-mysql`'s `onInstall` loads its `DB_*`
  env config and throws `ConfigError` here if required vars are missing
  (§7.2) — exactly the fail-fast behavior you want for anything your
  plugin cannot function without.
- **`onEnable`** — runs second, after `onInstall`. Use it for anything
  asynchronous: opening a connection pool, running your plugin's own
  migrations, calling `context.capabilities.obtain(...)` for a capability
  you need at startup. `database-mysql` builds its connection pool here,
  proves connectivity, and runs migrations (§7.2).
- **`onDisable`** — runs on teardown (`kernel.disablePlugin(...)` or
  process shutdown), before `onUninstall`. Release anything `onEnable`
  acquired — close a pool, cancel a timer.
- **`onUninstall`** — runs last, after `onDisable`.

**`provides`** — if your manifest declares `capabilities.provides`, this
export supplies the actual implementation, keyed by capability id. The
loader registers every entry here with the broker _before_ calling any of
your lifecycle hooks on _any_ plugin — so by the time your own `onInstall`
runs, anything you provide is already reachable by a dependency that loaded
before you. Build `provides` at module scope (not inside a hook) unless
constructing it genuinely requires something only available in a hook
context — rbac's `check`/`manage` closures and database-mysql's `db:query`
wrapper are both built at module scope over module-level state (§7).

**Failure isolation:** if any step for your plugin throws — manifest
wiring, `onInstall`, or `onEnable` — the loader catches it, logs it, and
marks your plugin `failed` without crashing the kernel or any unrelated
plugin (`src/core/loader.ts:36-52`). A plugin whose `depends_on` names a
plugin that already failed is skipped entirely, never attempted. Don't
add your own top-level try/catch around setup logic to "be safe" — let it
throw; the loader's isolation is the safety net, and swallowing the error
yourself just hides a real misconfiguration.

## 5. Capability grammar and the provide/require/grant/obtain cycle

### 5.1 Grammar

Every capability id — everywhere one appears: `capabilities.provides`,
`capabilities.requires`, and every runtime broker call
(`declareRequirement`, `registerProvider`, `grant`, `obtain`) — follows one
fixed shape: `<namespace>:<action>`, each segment independently
lowercase-kebab-case (the same per-segment rule as a plugin id, §2.1).
Source: `CAPABILITY_PATTERN` in `src/core/manifest.ts:56`.

```capability-grammar-regex
^[a-z][a-z0-9]*(-[a-z0-9]+)*:[a-z][a-z0-9]*(-[a-z0-9]+)*$
```

Valid: `db:query`, `db:transaction`, `http:route`, `render:template`,
`rbac:check`, `rbac:manage`. Invalid, with the reason: `dbquery` (missing
the colon — this is not just "any string", it must have exactly one),
`db:` / `:query` (a segment cannot be empty), `db:query:extra` (exactly one
colon, not two), `Db:Query` (uppercase, same rule as a plugin id),
`db_query:read` (underscore inside a segment — hyphens only).

Pick a namespace that names the _domain_, not your plugin — `db`, not
`database-mysql`; `rbac`, not `rbac-plugin`. Every capability namespace
currently in use in this repo (`db`, `http`, `render`, `rbac`) is shorter
than the plugin id that provides it, and that's intentional: another
plugin's manifest reads `"requires": ["db:query"]`, not
`"requires": ["database-mysql:query"]` — the capability is a
domain-shaped contract, not "a message to a specific plugin."

### 5.2 What `provides` and `requires` actually mean

- **`capabilities.provides`** — capability ids _this_ plugin implements as
  extension points for others. Each one must have a matching entry in your
  `index.ts`'s `provides` export (§4) once your plugin actually implements
  it; a manifest can legitimately declare `provides` for something not yet
  built (a scaffold), but a shipped plugin shouldn't leave a gap between
  what it claims and what `index.ts` actually exports.
- **`capabilities.requires`** — capability ids this plugin **may ever ask
  for**. This is a ceiling, not a guarantee (§1, fact 5): declaring
  `"requires": ["rbac:check"]` means "I might call
  `context.capabilities.obtain("rbac:check")`", not "I am guaranteed to get
  it." The loader's default grant policy (`grantAllDeclared`,
  `src/core/loader.ts:143-145`) grants everything a plugin declares here —
  but a real operator-controlled deployment could use a stricter policy, and
  even under the permissive default, `obtain()` still fails if no plugin is
  currently _providing_ that capability (e.g. it's optional, or its
  provider failed to load). `api-gateway`'s manifest requires both
  `rbac:check` and `render:template` "optionally" (spec.md §4) — its code
  must handle `obtain()` returning `Err` for either one gracefully, not
  assume both always succeed.

At runtime (not manifest-authoring time, but worth understanding so you
write `index.ts` correctly): the loader calls
`declareRequirements(pluginId, manifest.capabilities.requires)` before your
hooks run, then (per the grant policy) `grant()`s some subset, then hands
you `context.capabilities` — the narrow `{ obtain(capabilityId) }` facade
bound to your plugin's id (`PluginCapabilityAccess`,
`src/core/broker.ts:73-76`). Calling `obtain()` for an id you didn't
declare in `capabilities.requires` fails with `reason: "not_declared"` —
there is no way around declaring it in the manifest first.

```ts
const result = context.capabilities.obtain<SomeCapabilityType>("some:capability");
if (!result.ok) {
  // result.error.details.reason is "not_declared" | "not_granted" | "no_provider"
  context.logger.warn({ err: result.error }, "some:capability unavailable");
  return; // or degrade gracefully — never assume obtain() succeeds
}
const capability = result.value;
```

## 6. Validating your plugin before you call it done

You do not need to boot the whole kernel to check a plugin is
structurally correct. Three checks, in increasing order of what they
cover:

### 6.1 Manifest shape only

```ts
import { validateManifest } from "../../src/core/manifest.js";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("src/plugins/<id>/plugin.json", "utf8"));
const result = validateManifest(manifest);
// result is { ok: true, value: PluginManifest } or { ok: false, error: ValidationError }
```

`validateManifest` never throws — it returns a `Result` (`src/core/types.js`),
so check `result.ok` (or use `isOk(result)` from the same module) rather
than wrapping the call in try/catch.

### 6.2 Discoverability — copy this test verbatim

Every shipped plugin has a `tests/plugins/<id>/manifest.test.ts` shaped
exactly like this (this is `tests/plugins/rbac/manifest.test.ts` with the
id swapped out — copy it, don't reinvent it):

```ts
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../../../src/core/manifest.js";
import { scanPluginDirectories } from "../../../src/core/registry.js";
import { isOk } from "../../../src/core/types.js";

const PLUGINS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/plugins",
);

describe("<id> plugin manifest", () => {
  it("is discoverable by the plugin registry scan", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "<id>");
    expect(entry).toBeDefined();
    expect(entry?.manifestPath).toBe(path.join(PLUGINS_ROOT, "<id>", "plugin.json"));
    expect(entry?.manifest).not.toBeNull();
  });

  it("has a manifest that passes the kernel's manifest validator", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "<id>");
    const result = validateManifest(entry?.manifest);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.id).toBe("<id>");
      expect(result.value.entry_point).toBe("index.ts");
    }
  });
});
```

Run it with `npx vitest run tests/plugins/<id>/manifest.test.ts`.

### 6.3 Whole-repo sanity

Before considering the plugin finished:

```bash
npm run lint    # eslint . --ext .ts
npm run build   # tsc -p tsconfig.json — catches type errors your editor might not
npm test        # vitest run — the full suite; your new plugin must not break anything else
```

All three must pass clean. `npm test` also re-runs
`tests/core/plugin-conventions.test.ts`, which will fail if a manifest or
capability id you wrote happens to reveal a drift between the docs and the
validator — that failure means fix the doc, not silence the test.

## 7. Canonical patterns: `rbac` and `database-mysql`

These two shipped plugins are the reference implementations this document
points to (per feature #78's own requirement) because between them they
cover the two shapes almost every new plugin will be one of.

### 7.1 `rbac` — a self-contained, dependency-free capability provider

`src/plugins/rbac/plugin.json`:

```json
{
  "id": "rbac",
  "version": "0.1.0",
  "depends_on": {},
  "capabilities": {
    "provides": ["rbac:check", "rbac:manage"],
    "requires": []
  },
  "entry_point": "index.ts"
}
```

What to copy from `src/plugins/rbac/index.ts`:

- **`provides` is built at module scope**, as a plain object of closures
  over module-level state (`policyStore`, an exported mutable object), not
  constructed inside a lifecycle hook:

  ```ts
  export const provides: Readonly<Record<string, unknown>> = {
    "rbac:check": { check } satisfies RbacCheckCapability,
    "rbac:manage": managementApi,
  };
  ```

  This works because `check()` needs nothing from
  `PluginLifecycleContext` to be callable — it's a stable closure from the
  moment the module is imported. Do this whenever your capability's
  implementation doesn't genuinely need context-provided data (a
  connection pool, a config value) to exist.

- **`onInstall` is a single, small hook** that does exactly one thing: copy
  `context.auditSink` into local module state, so later calls have
  somewhere to log to without importing a singleton:

  ```ts
  export function onInstall(context: PluginLifecycleContext): void {
    auditState.sink = context.auditSink;
  }
  ```

- **State the plugin owns is exported, mutable module state** (not a
  private closure variable) specifically so tests can seed/inspect it
  directly, without needing a management API to go through first. If your
  plugin has in-memory state a test will need to manipulate directly,
  follow this precedent rather than hiding it.
- **No `depends_on`, no `capabilities.requires`.** `rbac` needs nothing
  from any other plugin to function. If your plugin is similarly
  self-contained, your manifest should look like this — resist the urge to
  add a `depends_on`/`requires` entry "just in case."

### 7.2 `database-mysql` — config-gated, async setup, migrations

`src/plugins/database-mysql/plugin.json`:

```json
{
  "id": "database-mysql",
  "version": "0.1.0",
  "depends_on": {},
  "capabilities": {
    "provides": ["db:query", "db:transaction", "db:migrate"],
    "requires": []
  },
  "entry_point": "index.ts"
}
```

What to copy from `src/plugins/database-mysql/index.ts`:

- **`onInstall` fails fast on bad config.** It loads `DB_*` environment
  config and throws `ConfigError` immediately if required values are
  missing — it does not defer that discovery to the first query. If your
  plugin needs external configuration to function at all, validate it in
  `onInstall`, synchronously, and throw rather than limping along with
  partial config.
- **`onEnable` is where anything asynchronous happens**: building the
  connection pool, proving connectivity with retry, running this plugin's
  own migrations. Note the explicit split: `onInstall` = "is my config even
  valid" (sync, fail fast), `onEnable` = "actually stand up the resource"
  (async, can retry/backoff).
- **`onDisable` tears down exactly what `onEnable` stood up** — destroying
  the shared `Kysely` instance (which also closes the underlying pool), so
  a runtime disable doesn't leak connections.
- **A capability that needs a caller identity threads it explicitly.**
  `db:migrate`'s methods take an explicit `{ pluginId, migrationsDir }`
  rather than assuming they can infer the caller — there is no way for a
  capability's plain-object implementation to know which plugin is calling
  it through the broker. If your capability needs to know who's calling,
  add that as an explicit parameter; don't rely on hidden context.
- **Its own migrations run directly, not through its own `db:migrate`
  capability** — `onEnable` calls the migration runner as an ordinary
  same-plugin function call. A plugin never needs to round-trip through the
  broker to call its own capability implementation; that indirection is
  only for _other_ plugins.

### 7.3 What to imitate for your own plugin

- If your plugin needs nothing external and its capability implementation
  is pure/stateless-enough to build at module scope: follow §7.1 (`rbac`).
  Minimal manifest (`depends_on: {}`, no `requires`), no `onEnable` at all
  if there's nothing asynchronous to do.
- If your plugin needs configuration, an external connection, or anything
  that can fail at startup and must fail loudly: follow §7.2
  (`database-mysql`) — validate config in `onInstall`, stand up resources
  in `onEnable`, tear them down in `onDisable`.
- If your plugin needs something from _another_ plugin at runtime, follow
  `api-gateway`'s manifest shape (`"requires": ["rbac:check",
"render:template"]`, §5.2) and handle `obtain()` failing gracefully —
  never assume a required capability is actually granted.

## 8. Worked example: a trivial `greeter` plugin

This section builds a minimal, complete, spec-compliant plugin from
scratch, applying every rule above. It provides one capability
(`greet:hello`) that returns a greeting string, needs no configuration, and
requires nothing from any other plugin — the `rbac` shape (§7.1), since
that's the simpler of the two to start from. It is not committed anywhere
in this repository; it exists here purely as a template to copy from.
(Feature #79, a separate, later piece of work, is what actually generates
and commits a real `hello-world` plugin proven to load in the kernel — this
worked example is deliberately not that, to avoid overlapping it.)

**Step 1 — pick the id.** `greeter`. Lowercase-kebab-case, matches
§2.1's regex, will be both the directory name and the manifest `id`.

**Step 2 — `src/plugins/greeter/plugin.json`:**

```json
{
  "id": "greeter",
  "version": "0.1.0",
  "depends_on": {},
  "capabilities": {
    "provides": ["greet:hello"],
    "requires": []
  },
  "entry_point": "index.ts"
}
```

Walking through why each field looks like this: `id` matches the directory
and §2.1's pattern. `version` starts at `0.1.0`, matching every shipped
plugin's starting point (§2.2). `depends_on` is empty — nothing about this
plugin's own load sequence depends on another plugin having loaded first
(§2.3). `capabilities.provides` has one entry, `greet:hello` — a
`namespace:action` pair (§5.1) naming the domain (`greet`) and the action
(`hello`), not the plugin id. `capabilities.requires` is empty — this
plugin needs nothing from any other plugin. `entry_point` is `"index.ts"`,
the repo-wide convention (§2.5).

**Step 3 — `src/plugins/greeter/index.ts`:**

```ts
/**
 * greeter plugin lifecycle module.
 *
 * Provides `greet:hello` — a single, dependency-free capability, following
 * rbac's "build `provides` at module scope, no lifecycle hook needed to
 * construct it" pattern (docs/ai-plugin-authoring.md §7.1), since building
 * a greeting string needs nothing from `PluginLifecycleContext`.
 */
import type { PluginLifecycleContext } from "../../core/loader.js";

/** What `greet:hello` hands back to a consuming plugin. */
export interface GreetHelloCapability {
  /** Returns a friendly greeting for `name`. */
  greet(name: string): string;
}

function greet(name: string): string {
  return `Hello, ${name}!`;
}

export const provides: Readonly<Record<string, unknown>> = {
  "greet:hello": { greet } satisfies GreetHelloCapability,
};

/**
 * Nothing to validate or stand up before `provides` is usable — `greet()`
 * is a pure function, stable from module-import time. This hook exists
 * only to demonstrate where you'd put fail-fast config validation if this
 * plugin ever needed any (see database-mysql, §7.2); it does no real work.
 */
export function onInstall(context: PluginLifecycleContext): void {
  context.logger.info({ plugin: context.manifest.id }, "greeter installed");
}
```

**Step 4 — `tests/plugins/greeter/manifest.test.ts`** (§6.2's template,
`<id>` replaced with `greeter`):

```ts
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../../../src/core/manifest.js";
import { scanPluginDirectories } from "../../../src/core/registry.js";
import { isOk } from "../../../src/core/types.js";

const PLUGINS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/plugins",
);

describe("greeter plugin manifest", () => {
  it("is discoverable by the plugin registry scan", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "greeter");
    expect(entry).toBeDefined();
    expect(entry?.manifestPath).toBe(path.join(PLUGINS_ROOT, "greeter", "plugin.json"));
    expect(entry?.manifest).not.toBeNull();
  });

  it("has a manifest that passes the kernel's manifest validator", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "greeter");
    const result = validateManifest(entry?.manifest);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.id).toBe("greeter");
      expect(result.value.capabilities.provides).toEqual(["greet:hello"]);
    }
  });
});
```

**Step 5 — verify.** `npm run lint && npm run build && npx vitest run
tests/plugins/greeter` — all three clean means the plugin is
spec-compliant.

A consuming plugin, once `greeter` is loaded, would declare
`"requires": ["greet:hello"]` in its own manifest and call:

```ts
const result = context.capabilities.obtain<GreetHelloCapability>("greet:hello");
if (result.ok) {
  context.logger.info(result.value.greet("world")); // "Hello, world!"
}
```

## 9. FAQ / common mistakes

**"Do I need a `src/` subdirectory?"** Only once `index.ts` would
otherwise get long. §8's `greeter` example is small enough to live entirely
in `index.ts`; `rbac` and `database-mysql` both split real logic out into
`src/` because their `index.ts` would otherwise be enormous. Either is
valid — `entry_point`'s only requirement is that it resolves to a real
module (§2.5); nothing requires a `src/` directory to exist.

**"Can I name my capability after my plugin, like
`greeter:greet`?"** You can — it's grammatically valid (§5.1) — but it's
against the grain of every capability actually shipped in this repo. A
capability names a _domain_ action (`db:query`, `rbac:check`), so that a
future second plugin providing the same kind of thing under a different
implementation could plausibly reuse the same capability id. `greet:hello`,
not `greeter:hello`, follows that convention.

**"My plugin needs `rbac:check` — do I also add `rbac` to
`depends_on`?"** No, not for this reason. `depends_on` controls _load
order_; `capabilities.requires` plus a runtime `obtain()` call is the
actual channel for using another plugin's capability (§2.3, §5.2). Since
the loader processes plugins in _dependency-graph_ order but capabilities
are registered before any plugin's hooks run (§4), a plugin that only
`requires` `rbac:check` (no `depends_on` on `rbac` at all) still works
correctly regardless of the two plugins' relative order in
`src/plugins/` — `api-gateway`'s manifest is exactly this shape (§5.2). Add
a `depends_on` entry only if your own `onInstall`/`onEnable` would be
_incorrect_ to run before that other plugin's finished loading — a
strictly stronger requirement than "I will eventually call `obtain()` on
something it provides."

**"The manifest validator rejected my `plugin.json` and I don't know
why."** `validateManifest()` (§6.1) returns every violation, not just the
first — read `result.error.details.issues`, an array of
`{ path, code, message }`. The most common causes, in order of frequency
seen while validating this document's own worked example against the real
validator: an extra field beyond the five in §2's table (`unknown_field` —
the schema is `.strict()`); `id` not matching the plugin's directory name;
a capability id with zero or two colons instead of exactly one; `version`
with a leading `v` or missing a patch segment.

**"Do I need to register my plugin anywhere besides its own directory?"**
No. `scanPluginDirectories()` walks `src/plugins/*` itself (§3, §6.2) —
there is no central plugin list to edit. Creating the directory with a
valid `plugin.json` is sufficient for the plugin to be _discovered_;
nothing beyond that is required for the manifest-validity checks in §6 to
pass. (Whether it actually _loads_ cleanly at kernel bootstrap — no
`depends_on` cycle, no failing `onInstall`/`onEnable` — is a separate
question from discoverability, covered by §6.3's full-suite run.)

## Appendix: doc validation log

Per feature #78 step 3, this document was pressure-tested by handing it —
and nothing else: not `docs/plugin-conventions.md`, not `spec.md`, not any
kernel source — to a fresh agent with no prior exposure to this codebase,
with the instruction to author a trivial plugin (`pinger`, providing
`ping:pong`) using only the document's content and its own judgment, while
logging every point of hesitation as it happened rather than reconstructing
them afterward. Two rounds of findings came out of that process:

**Anticipated during authoring, before the dry run** (reasoned through
while writing the doc, based on where an unfamiliar reader would plausibly
guess wrong) — each already reflected in the sections below, and none of
which the dry-run agent below actually re-hit, which is evidence the fix
held:

- Capability namespace choice: an early framing risked a reader naming a
  capability after the plugin (`greeter:greeting`) instead of the domain.
  §5.1 and §9 now state and justify the domain-not-plugin rule explicitly,
  with `greet:hello` vs. `greeter:hello` as the contrast.
- `depends_on` vs. `capabilities.requires`: these are easy to conflate as
  "two ways to declare a dependency." §2.3, §5.2, and §9's FAQ now state
  directly that they're different mechanisms (load order vs. a
  grant-gated, `obtain()`-mediated runtime channel), with `api-gateway`'s
  real manifest (`requires` only, no `depends_on`) as the counter-example.
- Whether `onInstall`/`onEnable`/etc. are mandatory: §4 now leads with
  "every one of these five exports is optional" before describing what
  each hook is _for_, so a stateless capability provider doesn't infer it
  needs boilerplate it doesn't.

**Actually surfaced by the dry-run agent** (real, unprompted friction —
the agent produced a correct, valid `pinger` plugin regardless, but flagged
these as places it had to guess or found inconsistent):

- **The `.js`-extension-on-`.ts`-imports convention was never
  explained.** Every copyable code sample imports `src/core/*.js` — the
  compiled extension — even though the source is `.ts`. The doc never
  named this as NodeNext/ESM convention, so a reader with zero other
  context could plausibly "fix" it to `.ts` and break the build. Fixed:
  added the "A note on the code samples in this document" callout right
  before §0, stated explicitly, with the warning that changing it breaks
  the build.
- **Explicit-empty vs. omitted optional manifest fields was
  inconsistent.** §2's minimal example omits `depends_on`/`capabilities`
  entirely (relying on schema defaults); every worked example elsewhere
  (§7, §8) spells them out even when empty, with no stated reason to
  prefer one style for a new plugin. The dry-run agent guessed
  correctly (matched the worked-example style) but noted it was a guess.
  Fixed: §2 now states outright that the explicit-empty style is this
  repo's actual convention (every shipped plugin does it), while noting
  the schema accepts either.

The dry-run agent reported no other friction, and explicitly confirmed it
did not need to read any file beyond this document to produce a manifest,
lifecycle module, and test that all match this document's own conventions.

If a future reader of this document — human or agent — finds another point
where they had to guess or cross-reference source to proceed, that is
itself a bug in this document: fix the ambiguity here and add an entry to
this log, the same way `docs/plugin-conventions.md`'s regex blocks are kept
byte-for-byte synchronized with `manifest.ts` by its own test.

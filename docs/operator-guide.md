# Operator Guide

This document is for whoever runs an AppSkeleton deployment day to day: how
to configure it via the environment, how to add a new plugin to a running
deployment, and how the capability grants that gate what a plugin can
actually do are managed. It exists for the same reason `docs/security.md`
and `docs/plugin-conventions.md` do — so a human _or an AI coding agent_
operating a deployment knows the real, current behavior without having to
reverse-engineer it from the kernel source.

**Source of truth.** Nothing below is aspirational. Every claim is backed by
the corresponding kernel module — `src/core/config.ts`, `src/core/broker.ts`,
`src/core/loader.ts`, `src/core/registry.ts`, `src/server/index.ts` — as
actually implemented today. If the kernel's behavior changes, update this
document in the same change.

## 1. Environment configuration

### 1.1 The layered config engine

`src/core/config.ts`'s `loadConfig()` is the generic engine every config
schema in this codebase (the kernel's own `CoreConfigSchema` and every
plugin's `*ConfigSchema`) is built on. It merges up to three layers, lowest
precedence first:

1. **`defaults`** — safe, built-in fallback values passed by the caller.
2. **`env`** — `process.env` (or an injected map, used only in tests).
3. **`overrideFilePath`** — an optional local JSON file, read as a flat
   object and merged in at the highest precedence.

The merged object is validated with `zod`; a missing required field or an
invalid value throws a `ConfigError` with a clear, actionable message
(never a raw `ZodError`) rather than booting with bad config.
`sanitizeZodIssues()` in `config.ts` keeps a raw value out of
`ConfigError.details` specifically — the structured payload an API error
envelope would serialize — but the human-readable `message` itself (built
separately by `formatZodError()`) can still echo an invalid _non-missing_
value for certain zod issue types (e.g. an unrecognized `DB_SSL` enum
value). Don't paste a real secret into a variable that only accepts a
fixed set of values.

**In this deployment, only the first two layers are actually reachable.**
`overrideFilePath` is a real, tested capability of `loadConfig()` itself,
but nothing in this codebase currently passes one: `bootstrapKernel()`
calls `loadCoreConfig({ env })` with no `overrideFilePath`, and none of the
per-plugin loaders (`loadDbConfig()`, `loadSessionConfig()`,
`loadCookieConfig()`, `loadRateLimitConfig()`, etc.) are ever called with
one either. Wiring a JSON override file into a real boot path is a
straightforward, self-contained addition to `server/index.ts` (or a given
plugin's `onInstall`) if a future deployment needs it — but as shipped
today, **the only supported way to configure the running server is real
process environment variables.**

That last point matters more than it sounds: `npm run dev` / `npm start`
(i.e. `src/server/index.ts`, wherever `bootstrapKernel()` is called) never
loads a `.env` file itself — there is no `import "dotenv/config"` anywhere
in that module. Only two one-off scripts do that: `npm run migrate` /
`npm run migrate:down` (`src/plugins/database-mysql/src/migrate.ts`) and
`npm run seed` (`src/cli/seed.ts`), plus `scripts/backup.sh`/
`scripts/restore.sh` via their shared `scripts/lib/env.sh` helper. A `.env`
file on disk configures those scripts automatically; it does **not**, by
itself, configure the running server — see §1.2.

### 1.2 Setting it up

```bash
cp .env.example .env   # then edit secrets
```

This is read automatically by the migration/seed scripts and the
backup/restore scripts described above. To get the same values into the
actual server process, export them into your real shell environment first
(e.g. `set -a; source .env; set +a; npm run dev`) or use Docker's
`--env-file` (§1.6) — `npm run dev`/`npm start` read only `process.env`.

`.env.example` at the repo root is a **starting point** covering the
variables most deployments need, not an exhaustive list — several optional
variables with safe defaults (e.g. `DB_SSL*`, `DB_POOL_QUEUE_LIMIT`,
`SESSION_COOKIE_NAME`) are intentionally omitted from it. §1.4 below, and
each plugin's own `*-config.ts` module, are the actual authoritative
source for the full set. Never commit a real `.env` — the repo's
`.gitignore` already excludes it, and `docs/security.md`'s gitleaks gate
exists precisely to catch a secret that slips past that.

### 1.3 Kernel-level config

`src/core/config.ts`'s `CoreConfigSchema`, loaded once at the very start of
`bootstrapKernel()`:

| Variable    | Required | Default       | Meaning                                            |
| ----------- | -------- | ------------- | -------------------------------------------------- |
| `NODE_ENV`  | no       | `development` | `development` \| `test` \| `production`            |
| `PORT`      | no       | `3000`        | Port `listen()` binds the HTTP server on           |
| `LOG_LEVEL` | no       | `info`        | `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace` |

A `ConfigError` here is **fatal** — it aborts the whole boot with a single,
stack-trace-free line on stderr and a non-zero exit code (see
`formatFatalStartupError()` in `src/server/index.ts`), because the kernel
does not even know what port to listen on or how verbosely to log. This is
the one config layer that can bring the whole process down; every plugin's
own config below is isolated instead.

### 1.4 Per-plugin config

Each plugin owns and validates its own config independently, using the same
`loadConfig()` engine. The authoritative list of variables always lives
next to the plugin's implementation (its `src/config.ts`/`*-config.ts`
file); as of this writing:

**`database-mysql`** (`src/plugins/database-mysql/src/config.ts`):

| Variable                     | Required | Default               |
| ---------------------------- | -------- | --------------------- |
| `DB_HOST`                    | no       | `127.0.0.1`           |
| `DB_PORT`                    | no       | `3306`                |
| `DB_USER`                    | **yes**  | —                     |
| `DB_PASSWORD`                | **yes**  | —                     |
| `DB_NAME`                    | **yes**  | —                     |
| `DB_CONNECTION_LIMIT`        | no       | `10`                  |
| `DB_SSL`                     | no       | `disabled`            |
| `DB_SSL_CA`                  | no       | unset                 |
| `DB_SSL_REJECT_UNAUTHORIZED` | no       | `true`                |
| `DB_POOL_QUEUE_LIMIT`        | no       | unset (unbounded)     |
| `DB_SLOW_QUERY_THRESHOLD_MS` | no       | unset (200ms applies) |

**`api-gateway`** (`src/plugins/api-gateway/src/*-config.ts`):

| Variable                   | Required | Default                      |
| -------------------------- | -------- | ---------------------------- |
| `SESSION_SECRET`           | **yes*** | —                            |
| `SESSION_COOKIE_NAME`      | no       | `sid`                        |
| `COOKIE_SECURE`            | no       | `true`                       |
| `CORS_ORIGIN`              | no       | `""` (deny all cross-origin) |
| `RATE_LIMIT_MAX`           | no       | `300`                        |
| `RATE_LIMIT_WINDOW_MS`     | no       | `60000`                      |
| `HELMET_ENABLED`           | no       | `true`                       |
| `HELMET_CSP_ENABLED`       | no       | `true`                       |
| `HELMET_HSTS_ENABLED`      | no       | `true`                       |
| `HELMET_HSTS_MAX_AGE`      | no       | `15552000`                   |
| `REQUEST_BODY_LIMIT_BYTES` | no       | `1048576`                    |
| `REQUEST_TIMEOUT_MS`       | no       | `30000`                      |

\* `SESSION_SECRET` is only loaded (and only required) the first time a
route handler actually needs to issue or verify a signed session id — not
just api-gateway's own `SessionConfigSchema`, but the equivalent schema
`rbac` (`src/plugins/rbac/src/session-identity.ts`) and `wiki`
(`src/plugins/wiki/src/session-identity.ts`) each define for their own
session-reading routes. Mounting the Fastify app itself never depends on
it. Every other api-gateway variable is safe to leave unset; each has a
secure-by-default value.

**`wiki`** (`src/plugins/wiki/src/attachment-storage-config.ts`):

| Variable                    | Required | Default                                                                                                            |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `WIKI_ATTACHMENTS_DIR`      | no       | `<cwd>/var/wiki-attachments` (resolved from the process's working directory at startup, not a fixed relative path) |
| `WIKI_ATTACHMENT_MAX_BYTES` | no       | `5242880` (5 MiB)                                                                                                  |

### 1.5 Fail-fast vs. graceful degradation

A required-but-missing plugin variable throws a `ConfigError` too, but
where that lands depends on _when_ it's loaded:

- **At boot, inside a plugin's own `onInstall`** — e.g. `database-mysql`
  calls `loadDbConfig()` synchronously from its `onInstall`, so a missing
  `DB_PASSWORD` throws during the load pass. `src/core/loader.ts`'s
  per-plugin isolation catches this: that plugin alone is recorded as
  `failed` (and every plugin depending on it is cascade-skipped — see
  §2.3), while every unrelated plugin still loads and the kernel still
  boots. This is spec.md's "graceful degradation" baseline in practice: an
  AppSkeleton deployment with no MySQL configured at all still boots and
  serves whatever routes don't need `database-mysql`'s capabilities.
- **At request time, inside a route handler** — e.g. `SESSION_SECRET` is
  only loaded the first time a route actually needs to sign/verify a
  session id, not at boot. A missing value here throws _during a request_,
  well after `loadPlugins()`'s own try/catch has already exited; it's an
  ordinary request-time error handled by api-gateway's error handler (a
  500 response), not a loader-level failure. The plugin itself stays
  `loaded`, and nothing is cascade-skipped because of it.

### 1.6 Docker

The production image (`Dockerfile`) takes the same variables, either
individually or via a whole file:

```bash
docker run -d --name appskeleton -p 3000:3000 \
  -e SESSION_SECRET=<a long random string> \
  -e DB_HOST=<your-mysql-host> \
  -e DB_PASSWORD=<your-mysql-password> \
  appskeleton
# or:
docker run -d --name appskeleton -p 3000:3000 --env-file .env appskeleton
```

## 2. Adding a new plugin to a deployment

### 2.1 What a plugin is, on disk

A plugin is a self-contained directory under `src/plugins/<plugin-id>/`
containing at minimum a `plugin.json` manifest. `entry_point`'s existence
on disk is **not** checked at scan or validation time, so a manifest-only
directory passes discovery and gets a real slot in the dependency graph —
but it will not actually load: the kernel's `import()` of a nonexistent
entry point fails, and (per §2.3 below) that plugin ends up reported as
`failed`, not "inert but present." `docs/plugin-conventions.md` is the
normative reference for the manifest shape, the `id`/capability naming
grammar, and the forbidden cross-plugin import rule — read that document
before hand-authoring one.

### 2.2 Scaffolding one

Either write `plugin.json` (and `index.ts`) by hand, or generate a
spec-compliant skeleton with the `plugin-builder` plugin's CLI:

```bash
npm run create-plugin -- --id my-plugin --description "What it does" \
  [--provides db:query] [--requires rbac:check]
```

This writes a valid `plugin.json`, an `index.ts` stub, and a matching test
stub under `tests/plugins/my-plugin/` — see
`src/plugins/plugin-builder/src/cli.ts`'s `USAGE` for the full flag list.

### 2.3 How it actually joins a deployment — auto-discovery, not registration

There is no separate "install"/"register" step or config file listing
active plugins. `bootstrapKernel()` calls `registry.ts`'s
`scanPluginDirectories()` against the plugins root (`src/plugins` by
default) on every process start, validates every `plugin.json` it finds,
and dynamically `import()`s each valid one's `entry_point`. Concretely:

1. Drop the new plugin's directory under `src/plugins/`.
2. If it depends on another plugin, declare that in `depends_on` (a semver
   range) — `graph.ts`'s `resolveLoadOrder()` topologically sorts every
   discovered plugin by this before anything loads. An unresolvable
   dependency graph (a cycle, a `depends_on` id that doesn't exist, an
   unsatisfied semver range, or a duplicate plugin id) is **fatal** — it
   aborts the whole boot, because it's a structural problem spanning more
   than one plugin, not one plugin's own runtime failure.
3. If it owns database tables, put its migrations in its **own**
   `src/migrations/` directory (never under `database-mysql`'s — each
   plugin's migrations only ever create tables prefixed with that plugin's
   own id; `database-mysql`'s migration runner enforces this). **Be aware
   that `npm run migrate` only applies `database-mysql`'s own migrations**
   (`src/plugins/database-mysql/src/migrate.ts`'s `MIGRATIONS_DIR` is
   hard-coded to its own sibling directory) — it does not discover or run
   any other plugin's migrations. The intended path for a plugin to run
   its own migrations is the `db:migrate` capability
   (`database-mysql`'s `up({ pluginId, migrationsDir })`, obtained and
   called from the plugin's own `onEnable`) — but as shipped today, **no
   plugin in this repo actually does that**: `wiki` and `rbac` each ship a
   `migrations-dir.ts` pointing at their own migration files, and those
   files are currently exercised only by integration tests
   (`tests/plugins/wiki/migrations.integration.test.ts`), never by a real
   `onEnable`. In practice, a new plugin that owns tables today must wire
   its own `db:migrate` call from `onEnable` itself — there is no existing
   shipped precedent that already does this end-to-end to copy from, and
   `npm run migrate` will not help.
4. If its manifest declares `capabilities.provides`/`capabilities.requires`,
   run `npm run generate:capability-index` and commit the regenerated
   `docs/capability-index.md` — a dedicated test fails the build if that
   file ever drifts from what the generator would produce.
5. **Restart the process.** Plugin discovery only happens at bootstrap;
   there is no hot-reload of newly-added plugin directories into an
   already-running kernel.

A plugin whose `entry_point` fails to `import()`, or whose own
`onInstall`/`onEnable` throws, does not fail the deployment: `loader.ts`
isolates it (and cascades the isolation to anything depending on it) while
every other plugin loads normally — see `src/server/index.ts`'s "Fatal vs.
isolated failures" for the exact two cases (config error, dependency-graph
error) that _are_ fatal.

### 2.4 Verifying it loaded

```bash
npm run introspect
```

Boots a real kernel (identical to `npm run dev`'s own bootstrap) and prints
one entry per plugin that reached the dependency graph — i.e. every plugin
whose `plugin.json` existed and passed `validateManifest()` — with its id,
version, status (`loaded` or `failed`; `disabled` is also a possible
status on a live `Kernel`, but a fresh CLI invocation never disables
anything, so this particular command will never print it), and its
`capabilities.provides`/`requires`/`granted`. **A plugin whose directory is
missing `plugin.json` entirely, or whose manifest fails validation, does
not appear in this report at all** — that case is only a warning-level log
line at boot (`scanPluginDirectories()`/`discoverPluginDefinitions()` in
`src/server/index.ts`), so if a newly-added plugin doesn't show up here at
all, check the boot log rather than assuming it's fine. This is still the
fastest way to confirm a plugin that _does_ appear actually loaded and, if
it declares required capabilities, that they were actually granted (see
§3).

## 3. How capability grants are managed

### 3.1 The three verbs

`src/core/broker.ts`'s `CapabilityBroker` is the kernel's sole mechanism
for one plugin to reach another's functionality — "no global singletons
reached via bare imports for cross-plugin access" (spec.md). A capability
becomes obtainable only once all three of the following hold at once:

- **Declared** — the plugin's `plugin.json` lists the capability id under
  `capabilities.requires`. `loader.ts` calls `broker.declareRequirements()`
  for every plugin automatically at load time, straight from its validated
  manifest; this is not something an operator does by hand.
- **Registered** — some plugin's module exports an implementation for that
  capability id under `provides`, and `loader.ts` calls
  `broker.registerProvider()` for it automatically at load time too. If
  the providing plugin isn't deployed, or fails to load, `obtain()` fails
  with reason `no_provider`.
- **Granted** — `broker.grant(pluginId, capabilityId)` was called for this
  exact plugin/capability pair, and hasn't since been revoked.

### 3.2 Who actually calls `grant()` today

**Every capability grant in this deployment is automatic.** `loader.ts`'s
`loadPlugins()` grants every capability id a plugin declared under
`capabilities.requires` — no operator action, config value, or CLI command
currently decides otherwise. This is `grantAllDeclared()`, the default
`GrantPolicy`:

```ts
export function grantAllDeclared(): boolean {
  return true;
}
```

`loadPlugins()` accepts a `grantPolicy` option that could deny specific
grants (an RBAC-backed or config-backed policy, per that option's own
docs), and `bootstrapKernel()` in `src/server/index.ts` calls
`loadPlugins()` without ever supplying one — so the permissive default is
what every real boot uses. **There is currently no environment variable,
config file, or CLI command that lets an operator withhold a specific
capability grant from a deployed plugin.** The levers that do exist today:

- **Edit the manifest.** A plugin can only ever be granted what it
  declares under `capabilities.requires` — shrinking that array (in the
  plugin's own `plugin.json`) is the actual ceiling-setting mechanism.
  `broker.grant()` independently rejects any id not declared there
  (`not_declared`), regardless of policy.
- **Don't deploy/enable the provider.** No registered provider means
  `obtain()` always fails with `no_provider`, whatever the grant state.
- **Write a custom `GrantPolicy`.** Anyone embedding `loadPlugins()`
  directly (rather than through the shipped `bootstrapKernel()`) can pass
  their own `(pluginId, capabilityId, manifest) => boolean` function. This
  is a code-level extension point today, not an operator-facing runtime
  setting.

### 3.3 Revocation

`broker.revoke(pluginId, capabilityId)` immediately and permanently kills a
grant — every handle a plugin already obtained under it throws
`CapabilityDeniedError` on its very next use (property read or call), not
just on the next `obtain()`. This applies to function- and object-shaped
capability handles, which are the norm (`wrapHandle()`'s `Proxy` traps).
**Primitive-shaped handles (a raw string/number/boolean) are the one
documented exception** — `wrapHandle()` returns them as-is, since JS gives
no hook to intercept a read of an already-copied primitive; revoking one
still blocks all _future_ `obtain()` calls, it just can't reach back into a
copy a caller already holds. A provider needing true immediate-revocation
semantics on primitive-shaped data should register an accessor function
instead. Two things in this codebase call `revoke()` today, both automatic,
not operator-triggered:

- `loader.ts` revokes every capability granted so far during a plugin's own
  load attempt if that same plugin fails partway through loading (rollback
  isolation), and, on teardown via `unloadPlugins()`, revokes every
  capability listed in the plugin's own `capabilities.requires` (not
  strictly "every capability it was granted" — under the default policy
  the two sets are identical, but a custom `GrantPolicy` that withheld some
  of them would make this a revoke-everything-declared sweep regardless).
  `unloadPlugins()` itself is invoked by graceful shutdown
  (`shutdownKernel()` in `src/server/index.ts`) and by anything embedding
  it directly.
- **Runtime `kernel.disablePlugin()`/`enablePlugin()` (feature #16) does
  NOT touch grants.** Administratively disabling a plugin only runs its
  `onDisable` hook and flips `introspect()`'s reported status to
  `"disabled"` — every capability it was granted stays granted, and every
  capability it provides to others stays registered, the whole time it's
  paused. Full revocation only happens via `unloadPlugins()` (i.e., process
  shutdown or an embedder calling it directly), not via the runtime
  enable/disable toggle.

### 3.4 Observing grants and auditing decisions

- `npm run introspect` (§2.4) reads `broker.isGranted()` live for every
  plugin's declared capabilities — this is the fastest way to confirm what
  is actually granted right now, as opposed to what a manifest merely
  declares.
- Every `grant`/`revoke`/`obtain`/`registerProvider` call records one audit
  event (actor, action, target, outcome, timestamp) to the kernel's shared
  audit sink, when one is configured — `bootstrapKernel()` always
  configures one. It starts in-memory and is later swapped to a
  MySQL-backed sink, persisted in the `database_mysql_audit_log` table —
  but **not** the moment `database-mysql` itself finishes loading:
  `attachPersistentAuditSinkIfAvailable()` (`src/server/index.ts`) only
  runs after `loadPlugins()`'s _entire_ pass returns, i.e. after every
  plugin in this boot has finished its own load attempt. The switch also
  performs no replay — `setDelegate()` is documented as never buffering or
  replaying prior events against a later delegate (`src/core/audit.ts`).
  **Practical consequence: every capability grant/register decision made
  during this boot's own load pass — which is when the interesting ones
  happen — is recorded only to the in-memory sink and is lost on restart,
  never reaching MySQL.** Only events recorded _after_ the swap (later
  `obtain()` calls, and plugin-emitted events such as wiki's own
  `wiki:*` actions) are durable.
- **No route or CLI command surfaces the capability audit trail
  specifically.** `wiki` does ship an admin-gated `GET /wiki/audit` view
  over the same kernel sink, but it filters to entries whose `action`
  starts with `wiki:` — it deliberately excludes the broker's own
  `capability:grant`/`capability:revoke`/`capability:obtain`/
  `capability:register` events. Inspecting those today means querying
  `database_mysql_audit_log` directly with SQL, and per the point above,
  that table currently only ever contains a given boot's _post-load-pass_
  capability events, not its initial grants.
- `npm run capability-audit` (feature #118,
  [`docs/capability-audit.md`](./capability-audit.md)) drives a real HTTP
  flow against the shipped plugin set and compares each plugin's declared
  `capabilities.requires` against what it actually obtained per the audit
  trail described above — surfacing any capability a plugin declares but
  never uses (over-privileged), which `npm run introspect`'s live-grants
  view above cannot: `isGranted()` only reports what an operator _could_
  currently obtain, not what a plugin's own code has actually reached for.

## See also

- [`docs/plugin-conventions.md`](./plugin-conventions.md) — the manifest
  shape, naming rules, and import restrictions referenced in §2.
- [`docs/capability-index.md`](./capability-index.md) — the generated,
  build-enforced snapshot of every shipped plugin's
  `provides`/`requires`.
- [`docs/security.md`](./security.md) — CI-level scanning gates (dependency
  vulnerabilities, committed secrets); a different layer of security from
  the runtime capability grants described here.
- [`docs/backup-restore.md`](./backup-restore.md) — database backup/restore
  scripts, configured with the same `DB_*` variables as §1.4.
- [`docs/capability-audit.md`](./capability-audit.md) — the least-privilege
  capability audit script referenced in §3.4.

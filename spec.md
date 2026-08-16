# AppSkeleton — Plugin-Based Application Platform

## Vision

AppSkeleton is a web application platform where **everything is a plugin**. The
core ("kernel") contains no business logic at all — it only knows how to
discover, validate, load, sandbox, sequence, and tear down plugins, and how to
let plugins talk to each other through well-defined, permissioned contracts.
Every piece of user-visible functionality (auth, database access, HTML
rendering, the HTTP API, even the tools used to build more plugins, and the
Wiki application) is itself a plugin built on top of that kernel, using the
same public plugin API a third-party developer would use.

Non-negotiable qualities, in priority order:

1. **Secure** — least privilege by default, no ambient authority, every
   capability a plugin uses must be explicitly declared and granted, all
   input validated at trust boundaries, safe defaults everywhere.
2. **Robust** — typed contracts, exhaustive validation, graceful degradation
   (a broken plugin must not crash the kernel or unrelated plugins), full
   test coverage on the kernel and every shipped plugin.
3. **Performant** — connection pooling, caching, minimal overhead in the
   plugin dispatch path, lazy loading, benchmarked hot paths.

## Tech Stack (decided, not up for silent drift)

- **Language:** TypeScript (strict mode) on Node.js LTS (>=20). Strong typing
  is a security/robustness feature here, not a preference.
- **HTTP layer:** Fastify — chosen for first-class JSON-schema validation,
  a mature plugin/encapsulation model that maps naturally onto our own plugin
  concept, and strong throughput characteristics.
- **Database:** MySQL 8, accessed via `mysql2` (connection pooling, prepared
  statements) wrapped by `kysely` for type-safe query building. No raw string
  SQL concatenation anywhere — enforced by lint rule.
- **Validation:** `zod` for runtime schema validation of plugin manifests,
  config, and API payloads (mirrors/derives TypeScript types).
- **Testing:** `vitest` for unit/integration tests, `supertest`-style HTTP
  assertions against the Fastify instance, `eslint` + `prettier` for style.
- **Process/dev environment:** Docker Compose for local MySQL; `.env` for
  secrets/config, never committed.

## Kernel Architecture (`src/core`)

The kernel is the only part of the system that is NOT a plugin. It provides:

- **Plugin Manifest** (`plugin.json` per plugin, validated by zod schema):
  id, version, semver-range dependencies on other plugin ids, declared
  **capabilities required** (e.g. `db:query`, `http:route`, `render:template`,
  `rbac:check`), declared **capabilities provided** (extension points other
  plugins may hook into), lifecycle entry point.
- **Plugin Registry & Loader**: discovers plugins under `src/plugins/*`,
  topologically sorts by `depends_on`, validates manifests, instantiates in
  dependency order, calls lifecycle hooks (`onInstall`, `onEnable`,
  `onDisable`, `onUninstall`).
- **Capability/Permission Broker**: a plugin only receives handles to the
  capabilities it declared in its manifest and that the operator has granted.
  No global singletons reached via bare imports for cross-plugin access —
  everything crosses the boundary through the broker so it can be audited,
  mocked, and revoked.
- **Event Bus**: typed pub/sub so plugins can react to each other's lifecycle
  and domain events without direct coupling (`user.created`,
  `page.published`, etc.).
- **Config System**: layered config (defaults → env → operator overrides),
  validated per-plugin against a zod schema the plugin exports.
- **Structured Logger & Audit Trail**: every capability grant, permission
  check, and mutating action is logged with actor/target/outcome, ready to be
  consumed by the RBAC plugin's audit views.
- **Error Isolation**: a plugin that throws during load or in a request
  handler is caught, logged, and (in production) shows a safe generic error —
  it must never crash the whole process or leak stack traces to clients.

## Shipped Plugins

### 1. `rbac` — Role-Based Access Control
Roles, permissions (resource:action grammar), role→permission and
user→role assignments, a `can(user, action, resource)` check function
exposed as a capability other plugins consume, policy caching, an audit log
of access decisions, and an admin API/UI surface for managing roles.

### 2. `database-mysql` — Database Plugin
Owns the MySQL connection pool, a migration runner (versioned, forward-only,
checksum-verified), a per-plugin schema/table namespace convention so
plugins cannot collide, transaction helpers, health checks, and a
`db:query`/`db:transaction` capability exposed to other plugins — no plugin
talks to MySQL directly.

### 3. `html-renderer` — HTML Rendering Engine Plugin
A small, dependency-free templating engine we own end-to-end: layouts,
partials/components, context-aware auto-escaping (HTML/attr/URL/JS
contexts) to prevent XSS by default, a `render:template` capability, and a
theme/asset pipeline other plugins register views against.

### 4. `api-gateway` — Extensible, Highly Configurable API Plugin
The single place HTTP routes come into existence. Wraps Fastify and exposes
a `http:route` capability so any plugin can register versioned REST routes
with a JSON-schema contract (auto-generates OpenAPI), without touching
Fastify directly. Provides: request validation, consistent error envelopes,
pagination/filtering helpers, rate limiting, auth/RBAC middleware
integration, per-route capability requirements, and configurable
CORS/security headers.

### 5. `plugin-builder` — AI Agent Plugin-Builder Plugin
A meta-plugin whose job is to make it trivial (for a human OR an AI coding
agent) to scaffold a new, spec-compliant plugin: a machine-readable JSON
Schema for `plugin.json`, a `create-plugin` generator (CLI + programmatic
API) that emits a valid skeleton (manifest, lifecycle stubs, test stub), a
static validator/linter that checks an existing plugin directory against
kernel conventions (naming, capability declarations, no forbidden imports),
and Markdown docs written specifically to be an unambiguous prompt/context
for AI agents authoring new plugins.

### 6. `wiki` — Basic Wiki Application Plugin
The proof that the platform works end-to-end: Markdown pages with revision
history and diffing, a page tree/navigation, full-text search, RBAC-gated
read/write/admin permissions per page or namespace, all HTML produced via
`html-renderer`, all data via `database-mysql`, all HTTP via `api-gateway`.
Zero direct database/HTTP/rendering code of its own — it only calls
capabilities.

## Directory Layout

```
AppSkeleton/
  spec.md
  feature_list.json
  claude-progress.txt
  init.sh
  AGENTS.md
  dev-agent.py
  package.json / tsconfig.json / vitest.config.ts / eslint config
  docker-compose.yml         # MySQL for local dev
  .env.example
  src/
    core/                    # kernel — the only non-plugin code
      manifest.ts  registry.ts  loader.ts  broker.ts
      events.ts    config.ts    logger.ts  errors.ts  types.ts
    server/
      index.ts               # bootstrap: load kernel, mount plugins, listen
    plugins/
      rbac/
      database-mysql/
      html-renderer/
      api-gateway/
      plugin-builder/
      wiki/
  tests/
    core/
    plugins/
```

Each plugin directory is self-contained: `plugin.json`, `index.ts`
(lifecycle entry), `src/`, `tests/`. No plugin imports another plugin's
internals directly — only via kernel-brokered capabilities.

## Security Baseline (applies everywhere)

- All input validated at the boundary with zod/JSON-schema; never trust
  client input, including plugin config loaded from disk.
- Parameterized queries only; the `database-mysql` plugin's query builder
  makes raw concatenation structurally awkward on purpose.
- Auto-escaping HTML renderer; explicit opt-out only, and audited.
- Secrets only from environment/.env, never hard-coded, never logged.
- CSRF protection on state-changing routes, secure session cookies
  (`HttpOnly`, `Secure`, `SameSite=Lax` by default).
- Rate limiting and request size limits on the API gateway by default.
- Principle of least privilege for plugin capabilities — a plugin's
  manifest is the ceiling of what it can ever do at runtime.
- Dependency audit (`npm audit`) wired into CI.

## Execution Plan

This project is built via the **infinite-dev** workflow:
`feature_list.json` is the source of truth for what to build next,
`claude-progress.txt` is the running log, and git history is the audit
trail. See `AGENTS.md` for the operating procedure. Features are ordered so
the kernel and its test harness land first, then each plugin lands in
dependency order (`database-mysql` and `html-renderer` before `api-gateway`
before `wiki`; `rbac` early since almost everything depends on it;
`plugin-builder` after the kernel conventions it documents are stable).

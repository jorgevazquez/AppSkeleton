# Least-privilege capability audit (feature #118)

`npm run capability-audit` (`scripts/capability-audit.ts`) compares each
shipped plugin's declared `capabilities.requires` against the capability ids
it actually invoked at runtime, and reports the two ways that comparison can
disagree:

- **Uses more than it declared** — should be impossible by construction:
  `core/broker.ts`'s `obtain()` denies a request for an undeclared capability
  before it ever records a `"granted"` audit event, so this can only ever
  happen if that invariant itself has been broken. Reported as `IMPOSSIBLE`
  and always fails the run.
- **Declares more than it uses** — over-privileged: a capability id sitting
  in `capabilities.requires` that the plugin's own code never actually
  reaches for. Reported as `OVER-PRIVILEGED` and fails the run unless it is a
  documented, deliberate exception (see below).

## Why this needs a real run, not a static scan

`plugin-builder`'s conventions linter (feature #77,
[`src/plugins/plugin-builder/src/conventions-linter.ts`](../src/plugins/plugin-builder/src/conventions-linter.ts))
already performs a _static_ version of the mirror-image check
(`undeclared_capability_use`) by regex-scanning source text for `.obtain(...)`
calls. That catches "this code could obtain something it never declared" —
but several real `obtain()` call sites in this codebase are lazy, invoked
only when a specific request path is actually taken (e.g.
`api-gateway/src/rbac-protection.ts` only calls `obtain("rbac:check")` for a
request that both matches a `requiredPermission`-protected route **and**
carries a valid session). A static read can prove a capability id is
_reachable_, never that it actually gets reached in a live deployment. This
audit answers the complementary, runtime question by driving a real HTTP
flow against the real plugin set and reading back the capability broker's
own audit trail (`core/audit.ts`'s `capability:obtain` events) — see
[`src/core/capability-audit.ts`](../src/core/capability-audit.ts) for the
pure comparison logic this script feeds.

## Running it

```
npm run capability-audit
```

Requires a running, migrated MySQL (`./init.sh`, or
`docker compose up -d mysql`) — the same prerequisite as every
`*.integration.test.ts` in this repo and `scripts/load-test.ts`. The script:

1. Reads every shipped plugin's real `plugin.json` (the "declared" half).
2. Boots a real instance of every plugin that actually declares
   `capabilities.requires` (`api-gateway`, `rbac`, `wiki`) plus their
   capability providers, through the real capability broker/loader.
   `database-mysql`, `hello-world`, and `plugin-builder` all declare
   `capabilities.requires: []` — nothing to audit on the "used" side, so
   they're included in the final report trivially clean without needing to
   be live-booted.
3. Drives a real HTTP flow (`app.inject()`) across every reachable
   `obtain()` call site this plugin set has: wiki's full page lifecycle
   (create/get/edit/delete/search/history/diff/attachments/forms/audit) as
   three different RBAC roles, one of rbac's own admin routes (the only
   route in this set that goes through api-gateway's generic
   `requiredPermission` middleware), and a 404 with a browser-like `Accept`
   header (to reach `html:error-pages`).
4. Compares declared vs. observed usage and exits non-zero if anything
   unacknowledged is found.

## Current, accepted finding

`api-gateway` declares `render:template` in `capabilities.requires`, but its
own code never calls `capabilities.obtain("render:template")` anywhere — its
one HTML-producing surface (`/docs`,
[`src/plugins/api-gateway/src/openapi.ts`](../src/plugins/api-gateway/src/openapi.ts)'s
`renderApiDocsHtml`) deliberately hand-rolls its own dependency-free HTML
instead of going through html-renderer, and its error pages go through the
higher-level `html:error-pages` capability instead — which itself calls
`render:template` from _inside_ html-renderer's own plugin, never across a
broker boundary attributable to api-gateway.

This is a real over-privileged finding by this audit's own definition, but
not dead configuration to delete: it is an explicit, previously reviewed,
load-bearing design decision — pinned by
[`tests/plugins/api-gateway/manifest.test.ts`](../tests/plugins/api-gateway/manifest.test.ts)
and documented in spec.md §4,
[`docs/ai-plugin-authoring.md`](./ai-plugin-authoring.md) §5.2/§7.3, and
[`docs/capability-index.md`](./capability-index.md). `capabilities.requires`
is documented throughout this repo as "a ceiling, not a guarantee" — a
plugin may legitimately declare a capability it doesn't exercise on every
boot (or ever, if it's reserved for a documented future/optional use), the
same reasoning `conventions-linter.ts`'s own
`unsatisfied_capability_requirement` check already applies (a `"warning"`,
not a hard error) to a comparable gap. `scripts/capability-audit.ts`'s own
`KNOWN_OVER_PRIVILEGED` allowlist records exactly this one exception, with
its full reasoning inline — still reported by every run, but not treated as
a fresh regression. Any other over-privileged (or impossible) finding this
script produces is new and fails the run.

## See also

- [`docs/operator-guide.md`](./operator-guide.md) §3.4 — how capability
  grants are observed and audited more generally.
- [`docs/capability-index.md`](./capability-index.md) — the generated,
  build-enforced snapshot of every shipped plugin's `provides`/`requires`.
- [`docs/performance-baseline.md`](./performance-baseline.md) —
  `scripts/load-test.ts`, this script's closest sibling (same "real
  broker/loader, real HTTP via a hand-wired plugin subset" harness shape).

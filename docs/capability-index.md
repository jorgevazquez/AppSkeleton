# Capability index

**Generated — do not hand-edit.** Run `npm run generate:capability-index` after changing any plugin's `capabilities.provides`/`capabilities.requires` (see `src/plugins/plugin-builder/src/generate-capability-index.ts`, feature #82). `tests/plugins/plugin-builder/capability-index.test.ts` fails the build if this file ever drifts from what that script would produce.

## By plugin

| Plugin | Provides | Requires |
| --- | --- | --- |
| `api-gateway` | `http:route` | `rbac:check`, `render:template`, `html:error-pages` |
| `database-mysql` | `db:query`, `db:transaction`, `db:migrate` | _(none)_ |
| `hello-world` | _(none)_ | _(none)_ |
| `html-renderer` | `render:template`, `html:error-pages` | _(none)_ |
| `plugin-builder` | _(none)_ | _(none)_ |
| `rbac` | `rbac:check`, `rbac:manage` | _(none)_ |
| `wiki` | _(none)_ | `rbac:check`, `db:query`, `render:template`, `http:route` |

## By capability

| Capability | Provided by | Required by |
| --- | --- | --- |
| `db:migrate` | `database-mysql` | _(none)_ |
| `db:query` | `database-mysql` | `wiki` |
| `db:transaction` | `database-mysql` | _(none)_ |
| `html:error-pages` | `html-renderer` | `api-gateway` |
| `http:route` | `api-gateway` | `wiki` |
| `rbac:check` | `rbac` | `api-gateway`, `wiki` |
| `rbac:manage` | `rbac` | _(none)_ |
| `render:template` | `html-renderer` | `api-gateway`, `wiki` |

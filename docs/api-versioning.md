# API Versioning & Deprecation Policy

This document is the normative reference for how AppSkeleton versions its
HTTP API surface. It exists for the same reason `docs/plugin-conventions.md`
does: so a human _or an AI coding agent_ registering a new route knows the
convention without having to reverse-engineer it from `api-gateway`'s
source.

**Source of truth.** The prefixing behavior described below is not a
hand-copied description — it is implemented by `registerRoute()` in
`src/plugins/api-gateway/src/route-capability.ts` (see
`buildVersionedPath()` and `DEFAULT_API_VERSION`). If that implementation
changes, update this document in the same change.

## 1. The convention

Every route mounted through the `http:route` capability's `registerRoute()`
(feature #59) is automatically prefixed with an API version segment:

```
/api/<version>/<path>
```

A plugin that calls:

```ts
registerRoute({
  method: "GET",
  path: "/widgets/:id",
  schema: { params: /* ... */, response: /* ... */ },
  handler: /* ... */,
});
```

mounts a route reachable at `GET /api/v1/widgets/:id` — **never** at bare
`GET /widgets/:id`. There is no opt-out: `registerRoute()` is, by design,
the *only* sanctioned way a plugin mounts an HTTP endpoint (spec.md,
`api-gateway`), so this is also the only place versioning needs to be
enforced, and it is enforced unconditionally.

`options.path` should be written exactly as it would look with no version
prefix at all (e.g. `"/widgets"`, `"/greet/:name"`) — `registerRoute()`
handles joining it onto the version segment, including normalizing a path
that's missing its leading slash.

### The one exception: `/health`

`api-gateway`'s own built-in liveness endpoint, `GET /health` (feature #58),
is registered directly against the Fastify instance in `onEnable`, not
through `registerRoute()`, and is deliberately **not** version-prefixed.
Health/readiness checks are infrastructure-facing (load balancers,
orchestrators, uptime monitors), not part of the versioned application API
surface, and are conventionally expected at a stable, well-known path
regardless of how many API versions coexist behind it.

## 2. Choosing a version

`registerRoute()` accepts an optional `version` field:

```ts
registerRoute({
  method: "GET",
  path: "/widgets/:id",
  version: "v2",
  schema: /* ... */,
  handler: /* ... */,
});
```

- **Omit it.** This is the expected default for the overwhelming majority of
  routes — including every route registered while there is only one API
  version. Omitting `version` mounts the route under `v1`
  (`DEFAULT_API_VERSION`, exported from both `route-capability.ts` and
  `api-gateway`'s `index.ts`).
- **Pass an explicit segment** (`"v2"`, `"v3"`, ...) only when deliberately
  introducing a new, breaking version of a route family alongside the
  version(s) already in production. A version segment must match `v` followed
  by a positive integer with no leading zero (`/^v[1-9][0-9]*$/` — `"v1"`,
  `"v2"`, `"v10"`); anything else throws a `ValidationError` before the route
  is ever registered with Fastify, the same fail-closed pattern
  `assertDeclaresRequestAndResponseSchema` already uses for a missing
  request/response schema.

A new version is additive: registering `path: "/widgets/:id"` under both
`version: "v1"` (or the default) and `version: "v2"` mounts two independent
routes — `/api/v1/widgets/:id` and `/api/v2/widgets/:id` — on the same live
Fastify instance, each with its own schema and handler. Nothing about
registering `v2` removes or changes `v1`'s behavior; that is a separate,
deliberate deprecation step (below).

## 3. When to bump the version

Bump to a new version segment (`v2`, `v3`, ...) for a **breaking** change to
an already-shipped route: removing or renaming a response field a client
may depend on, tightening a request schema in a way that rejects previously
valid requests, changing a status code a client branches on, or any change
that is not purely additive.

Prefer *not* bumping the version — and just changing the existing route in
place — for a genuinely backward-compatible change: adding a new optional
request field, adding a new response field, adding a wholly new route.
Fastify's own schema-driven response serialization (feature #59's
`response`-schema enforcement) already strips any field a route's declared
schema doesn't list, so additive server-side changes are safe to ship
without a version bump as long as the *declared* schema for the version
stays backward compatible.

## 4. Deprecating an old version

When a new version (`v2`) supersedes an old one (`v1`) for a given route
family:

1. **Announce.** Record the deprecation — which route(s), which version,
   the planned removal date/release — in this repository's own change log
   (`claude-progress.txt`'s dated entries are this project's log of record
   until a dedicated `CHANGELOG.md` exists).
2. **Keep both versions live.** `v1` and `v2` routes coexist, registered
   side by side via two `registerRoute()` calls with different `version`
   values (see §2) — consumers migrate at their own pace within the
   deprecation window.
3. **Signal deprecation to clients.** A deprecated route's handler should
   set a `Deprecation` response header (and, once a removal date is fixed,
   a `Sunset` header per the IETF `Sunset` HTTP header convention) so
   automated API consumers can detect the deprecation without reading
   documentation out of band. This is a per-route handler concern — nothing
   in `registerRoute()` itself needs to change to support it, since
   `handler` has full control over the `reply` object.
4. **Remove.** Once the deprecation window has elapsed, delete the old
   version's `registerRoute()` call (and its handler/schema, if not shared)
   in a single change, and record the removal the same way the deprecation
   was announced.

There is no minimum deprecation window mandated by this document — pick one
appropriate to the route's actual consumers (an internal-only route can be
removed faster than one with external integrators) and state it explicitly
in the announcement.

## 5. Testing a versioned route

Because `registerRoute()` prefixes unconditionally, a route's own tests
should assert against its versioned path directly (e.g.
`app.inject({ url: "/api/v1/widgets/42" })`), not the bare `path` passed
into `registerRoute()`. `tests/plugins/api-gateway/route-versioning.test.ts`
is the canonical example: it registers a route with `path: "/widgets"` and
asserts it answers at `/api/v1/widgets` while 404ing at the bare,
unversioned `/widgets`.

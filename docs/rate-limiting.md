# Rate Limiting & DoS Mitigation Defaults

This document describes AppSkeleton's default rate-limit configuration
(feature #66 — "Configurable rate limiting (global and per-route)"),
explains the traffic assumptions behind the numbers, and tells an operator
how to tune them for a real deployment. It exists for the same reason
`docs/security.md` and `docs/api-versioning.md` do: so a human _or an AI
coding agent_ changing or deploying this service knows the intent behind a
setting, not just its current value.

**Source of truth.** The table below is not a hand-copied description — the
values are read directly from `RateLimitConfigSchema`
(`src/plugins/api-gateway/src/rate-limit-config.ts`) via
`tests/plugins/api-gateway/rate-limiting-docs.test.ts`, which fails the
suite if this document and the schema's actual defaults ever drift apart.
If you change a default in the schema, update this table in the same
change (see [Verifying the docs match the code](#verifying-the-docs-match-the-code)).

## 1. What's covered

api-gateway wires `@fastify/rate-limit` as a **global** default
(`registerRateLimiting`, `src/plugins/api-gateway/src/rate-limit.ts`): every
route registered afterwards — `/health` included, plus every route a
consumer plugin mounts via `registerRoute()` — is rate-limited per-IP unless
that specific route opts into a stricter override or disables rate limiting
entirely (`registerRoute()`'s `rateLimit` option; see
[Per-route overrides](#3-per-route-overrides-for-sensitive-endpoints)
below). A client that exceeds the limit gets a `429` with the uniform
`{code: "RATE_LIMIT_EXCEEDED", message, details}` error envelope and a
`Retry-After` header.

Rate limiting is one layer of AppSkeleton's DoS mitigation, not the whole
of it. It's complemented by feature #71's request size/timeout limits
(`REQUEST_BODY_LIMIT_BYTES`, `REQUEST_TIMEOUT_MS` —
`src/plugins/api-gateway/src/request-limits-config.ts`), which bound how
much of a single request the server will buffer and how long it will wait
for one to complete (guarding against oversized bodies and slowloris-style
slow-request attacks). This document focuses on the rate-limit settings
specifically; see that module's docs for the request-size/timeout story.

## 2. Current defaults

| Setting             | Env var                | Default | Meaning                                                                                                                                                                                                                         |
| ------------------- | ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requests per window | `RATE_LIMIT_MAX`       | `300`   | The maximum number of requests a single client (keyed by `req.ip`, `@fastify/rate-limit`'s own default `keyGenerator`) may make within `RATE_LIMIT_WINDOW_MS` before a route with no per-route override starts returning `429`. |
| Window length       | `RATE_LIMIT_WINDOW_MS` | `60000` | The sliding time window, in milliseconds, that `RATE_LIMIT_MAX` applies over. `60000` is one minute.                                                                                                                            |

Both are set in `.env.example` and loaded by `loadRateLimitConfig()`
(`src/plugins/api-gateway/src/rate-limit-config.ts`), which is safe to call
unconditionally at boot: an unconfigured deployment still boots with these
defaults rather than failing fast, since rate limiting is defense-in-depth,
not a correctness requirement the way a signed session secret is.

## 3. Why these numbers (realistic traffic assumptions)

Feature #66 shipped with `RATE_LIMIT_MAX=100` over the same one-minute
window. Feature #109 revisited that number against realistic traffic
patterns and raised it to `300`, for two concrete reasons:

1. **A single legitimate client issues more than one request per page
   interaction.** This is a JSON API gateway, not a single-request-per-click
   form poster: one browser tab loading a moderately dynamic page can
   easily fire off a dozen-plus `fetch`/XHR calls (initial data load, a few
   widgets, short-interval polling for live data), and a user who
   refreshes, navigates, or double-submits adds more on top. At
   `100`/minute (~1.7 req/s), a single active tab under normal use could
   plausibly trip the global limit on a busy page; `300`/minute (~5 req/s
   sustained, with bursts up to `300` in a fresh window) gives that same
   session comfortable headroom without weakening the control against an
   actual abusive client.
2. **`req.ip` often represents more than one real user.** `@fastify/rate-
limit`'s default key is the request's IP address. Users behind a shared
   corporate NAT, a mobile carrier's CGNAT, or a school/office network can
   share a single apparent IP across many simultaneous people. A limit
   tuned only for "one person, one browser" (like the original `100`)
   collectively starves every other legitimate user sharing that address
   far sooner than intended. `300`/minute gives a shared-IP population
   materially more room before the group as a whole gets throttled,
   without abandoning the control entirely.

The one-minute window (`RATE_LIMIT_WINDOW_MS=60000`) was kept as-is: it's
long enough to average out short legitimate bursts (a page load's request
fan-out) while staying short enough that a client that does trip the limit
recovers quickly (within a minute), which matters for both DoS mitigation
(a limited attacker still can't sustain much aggregate throughput) and
for not making a false-positive-throttled legitimate user wait a long time.

`300`/minute is still a deliberately conservative **global** default — it
is not meant to be the right limit for every route. It exists to bound
overall request volume against every unauthenticated, unclassified route in
the system; endpoints with a materially different risk profile should
layer their own override rather than relying on (or loosening) the global
number.

## 4. Per-route overrides for sensitive endpoints

`registerRoute()` (`src/plugins/api-gateway/src/route-capability.ts`)
accepts a `rateLimit` option that overrides the global default for that one
route, or disables rate limiting for it entirely with `rateLimit: false`.
This is the mechanism operators/plugin authors should reach for instead of
tightening the global default:

```ts
registerRoute({
  method: "POST",
  path: "/login",
  schema: {/* ... */},
  handler: loginHandler,
  // Far stricter than the global default: a route this sensitive should
  // never allow anywhere near 300 attempts/minute from one source.
  rateLimit: { max: 5, timeWindow: 60000 },
});
```

Recommended starting points for common sensitive-route categories (tune
per deployment, same as the global default):

- **Authentication (login, signup, password reset/change):** a low
  absolute `max` (single digits) over a one-minute-or-longer window. These
  routes are the classic credential-stuffing/brute-force target, and
  legitimate users never need dozens of attempts per minute.
- **Expensive/write-heavy operations** (large report generation, bulk
  writes, anything that does significant DB or CPU work per request): a
  `max` well below the global default, sized to what the backing resource
  (e.g. the database connection pool — see feature #30's pool metrics) can
  actually absorb concurrently.
- **Unauthenticated public endpoints with no legitimate high-frequency use
  case:** as strict as the endpoint's real usage pattern allows.

Nothing in `@fastify/rate-limit` enforces "per-route overrides must be
stricter than the global default" as a runtime invariant — that's a
convention this codebase follows, not something validated at boot.

## 5. Tuning guidance for operators

The right values depend on the deployment, not just this codebase. Before
changing `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` (via `.env` or your
deployment's environment configuration — no code change needed), consider:

- **Expected legitimate request rate.** Estimate the busiest realistic
  client's request rate (a power-user's browser tab, or a legitimate
  integration polling the API) and set `RATE_LIMIT_MAX` comfortably above
  it — the goal is to catch abusive/broken clients, not to throttle normal
  use.
- **How many real users can share one IP in your deployment.** Consumer
  ISPs with CGNAT, corporate networks, and school/university networks can
  put hundreds of legitimate users behind one address. If that's a
  significant share of your traffic, raise the global default (and lean
  more on authenticated, per-user limits where possible — this feature's
  IP-keyed limit is a blunt instrument for that case).
- **Whether you're behind a reverse proxy or load balancer.**
  `@fastify/rate-limit`'s default `keyGenerator` uses Fastify's `req.ip`,
  and this codebase does **not** currently set Fastify's `trustProxy`
  option. If you deploy behind a reverse proxy/load balancer without
  enabling `trustProxy` (and configuring it to trust only your actual
  proxy hop), `req.ip` resolves to the proxy's address for every request,
  which collapses **all** traffic into a single rate-limit bucket —
  effectively rate-limiting your entire user base together, not each
  client individually. If this applies to you, either configure
  `trustProxy` appropriately for your proxy topology before relying on
  this feature, or enforce rate limiting at the proxy/load-balancer layer
  instead (or in addition).
- **Raise the window, not just the max, for bursty-but-legitimate
  workloads.** If legitimate traffic is naturally bursty (e.g. a batch
  import client), a longer `RATE_LIMIT_WINDOW_MS` with a proportionally
  higher `RATE_LIMIT_MAX` smooths that out better than a very high `max`
  over a short window, which mostly just weakens the control against a
  genuine burst attack.
- **Lower the defaults for a smaller, higher-value deployment.** An
  internal admin tool or a low-traffic service with a small, known user
  base can afford to run tighter than the general-purpose defaults here —
  there's no traffic volume that needs the headroom.
- **Always re-verify after changing.** Run the existing rate-limit test
  suite (`tests/plugins/api-gateway/rate-limit.test.ts`, the rate-limiting
  section of `tests/plugins/api-gateway/gateway.integration.test.ts`, and
  this document's own no-drift test) after any change to confirm the new
  values are still internally consistent and documented.

## 6. Verifying the docs match the code

Because these are boot-time config defaults with existing, direct unit
test coverage (`tests/plugins/api-gateway/rate-limit-config.test.ts`
asserts `RateLimitConfigSchema.parse({})` yields the documented values),
this document adds one more test on top:
`tests/plugins/api-gateway/rate-limiting-docs.test.ts` parses the
`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` rows out of the table in
[section 2](#2-current-defaults) above and asserts they equal
`RateLimitConfigSchema.parse({})`'s actual values. If a future change bumps
a default in `rate-limit-config.ts` without updating this file's table (or
vice versa), that test fails the suite instead of the two silently
drifting apart.

Verified locally by:

1. Running the full suite (`npm test`) after changing `RATE_LIMIT_MAX`'s
   default from `100` to `300` and updating this document, `.env.example`,
   and the existing default-value assertions in
   `rate-limit-config.test.ts` in the same change — all pass.
2. Temporarily changing only this document's table (leaving the schema's
   default untouched) to confirm `rate-limiting-docs.test.ts` fails with a
   clear mismatch message, then reverting — confirming the drift check
   actually catches a real drift rather than trivially passing.

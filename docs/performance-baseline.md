# Load Testing Harness & Performance Baseline

This document is for whoever needs to know "is this deployment's HTTP
performance normal?" or "did that kernel/plugin change regress throughput or
latency?" — feature #110 ("Load testing harness with a documented
baseline"). It exists for the same reason `docs/rate-limiting.md` and
`docs/security.md` do: so a human _or an AI coding agent_ changing this
codebase's hot paths (the kernel's request pipeline, `api-gateway`, or
`wiki`) has a concrete, reproducible number to compare against instead of
guessing.

**This is not a drift-tested document.** Unlike `docs/rate-limiting.md`
(whose table is asserted against `RateLimitConfigSchema`'s actual defaults
by a test), the numbers below are a **point-in-time measurement** — real
network+DB throughput/latency on one machine, on one day. They will never
match exactly on a different machine, and they are not meant to: their job
is to be a _baseline to diff against on the same machine_, not an
absolute performance contract. See [§4](#4-how-to-interpret-these-numbers).

## 1. The harness

`scripts/load-test.ts` (wired up via `npm run load-test`) drives
[`autocannon`](https://github.com/mcollina/autocannon) against a real local
instance of this codebase's own `api-gateway` + `rbac` + `html-renderer` +
`wiki` plugins — the exact same plugin modules a real deployment loads,
wired through the real capability broker/loader
(`createCapabilityBroker()`/`loadPlugins()`) and backed by a real MySQL
connection, exactly like
`tests/plugins/wiki/http-routes.integration.test.ts` already does (down to
reusing that suite's own `login-fixture` stand-in, since wiki has no login
route of its own — see that file's module doc). The one difference: this
script calls `app.listen()` instead of `app.inject()`, since `autocannon`
needs a real socket to hammer, not an in-process dispatch.

### 1.1 Prerequisites

- A running MySQL instance with `database-mysql`'s own migrations applied:
  `./init.sh` (or `docker compose up -d mysql && npm run migrate`).
- `scripts/load-test.ts` applies (and rolls back) `wiki`'s own
  `wiki_namespaces`/`wiki_pages`/`wiki_revisions` migrations itself at
  startup/shutdown — `npm run migrate` does **not** cover them today (it
  only discovers `database-mysql`'s own `src/migrations/` directory; see
  `src/plugins/wiki/src/migrations-dir.ts`'s own doc comment, which names
  exactly this kind of "ops script" as the intended caller until a real
  `db:migrate` capability exists). This means the harness is self-contained
  — it leaves the shared dev database exactly as it found it, tables
  included — but also that **a plain `npm run dev` instance's wiki routes
  do not work out of the box** without something applying those same
  migrations first; this is a pre-existing gap this feature does not
  attempt to close.

### 1.2 Running it

```bash
npm run load-test

# Longer/heavier run:
LOAD_TEST_DURATION_S=30 LOAD_TEST_CONNECTIONS=50 npm run load-test
```

| Env var                 | Default | Meaning                                                          |
| ----------------------- | ------- | ---------------------------------------------------------------- |
| `LOAD_TEST_DURATION_S`  | `10`    | Seconds each scenario runs for.                                  |
| `LOAD_TEST_CONNECTIONS` | `20`    | Concurrent connections per scenario.                             |
| `LOAD_TEST_PORT`        | `4100`  | Port the throwaway server binds to.                              |
| `LOAD_TEST_SEED_PAGES`  | `50`    | Wiki pages pre-seeded in a scratch namespace for read scenarios. |

Every scenario runs **sequentially**, never overlapping, so one scenario's
load never contends with another's for a DB connection or CPU — the numbers
stay comparable to each other and across re-runs. The script prints a
markdown summary table at the end (the same shape as
[§3](#3-recorded-baseline)) ready to paste into a future update of this
document.

### 1.3 Scenarios exercised

| Scenario                       | Route                        | Auth                                |
| ------------------------------ | ---------------------------- | ----------------------------------- |
| `api-gateway` health check     | `GET /health`                | none                                |
| `api-gateway` OpenAPI document | `GET /api/v1/openapi.json`   | none                                |
| `wiki` list pages              | `GET /api/v1/wiki/pages`     | session cookie (read)               |
| `wiki` get single page         | `GET /api/v1/wiki/pages/:id` | session cookie (read)               |
| `wiki` full-text search        | `GET /api/v1/wiki/search`    | session cookie (read)               |
| `wiki` create page             | `POST /api/v1/wiki/pages`    | session cookie + CSRF token (write) |

This is a deliberately small, representative slice — the "key" routes step
1 asks for — not exhaustive coverage of every wiki route (attachments,
diff, revision history, delete): those share the same request pipeline
(`api-gateway`'s routing/RBAC/CSRF middleware chain, `wiki`'s
`authorized-store.ts`) as the read/write pair already measured, so they are
not expected to reveal a materially different bottleneck. Add a scenario
for one of them here if a future change gives specific reason to suspect
otherwise (e.g. a change specifically to attachment storage).

**Rate limiting is raised, not disabled**, for the duration of the run
(`RATE_LIMIT_MAX` set very high, restored to its previous value afterward)
— the production default (`RATE_LIMIT_MAX=300`/minute per IP, see
`docs/rate-limiting.md`) exists specifically to cap a single client's
throughput well below what these scenarios intentionally drive per second,
so leaving it in place would measure the rate limiter, not the server. See
[§4](#4-how-to-interpret-these-numbers) for what that default actually
does to a real client's numbers.

## 2. Environment this baseline was recorded on

|                                                                           |                                                                        |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Date                                                                      | 2026-08-21                                                             |
| Machine                                                                   | Apple M4, 10 cores, 24 GB RAM                                          |
| OS                                                                        | macOS 27.0                                                             |
| Node.js                                                                   | v25.9.0                                                                |
| MySQL                                                                     | 8.4.11 (via `docker-compose.yml`'s `mysql` service, aarch64 container) |
| `LOAD_TEST_DURATION_S` / `LOAD_TEST_CONNECTIONS` / `LOAD_TEST_SEED_PAGES` | `10` / `20` / `50` (all defaults)                                      |

## 3. Recorded baseline

| Scenario                                    | Method | Path                                               | Req/s (avg) | Latency p50 (ms) | Latency p99 (ms) |    2xx | non-2xx | Errors |
| ------------------------------------------- | ------ | -------------------------------------------------- | ----------: | ---------------: | ---------------: | -----: | ------: | -----: |
| api-gateway: health check                   | GET    | `/health`                                          |     31013.8 |                0 |                1 | 341120 |       0 |      0 |
| api-gateway: OpenAPI document               | GET    | `/api/v1/openapi.json`                             |     12740.0 |                1 |                1 | 140133 |       0 |      0 |
| wiki: list pages (authenticated read)       | GET    | `/api/v1/wiki/pages?namespaceId=...`               |      5343.8 |                3 |                6 |  58779 |       0 |      0 |
| wiki: get single page (authenticated read)  | GET    | `/api/v1/wiki/pages/:id`                           |     12791.2 |                1 |                2 | 127908 |       0 |      0 |
| wiki: full-text search (authenticated read) | GET    | `/api/v1/wiki/search?q=throughput&namespaceId=...` |      6444.4 |                3 |                4 |  64440 |       0 |      0 |
| wiki: create page (authenticated write)     | POST   | `/api/v1/wiki/pages`                               |      2681.9 |                7 |               13 |  29493 |       0 |      0 |

Zero non-2xx responses and zero connection errors across every scenario —
the server handled the full offered load at 20 connections without
rejecting or timing out any request.

## 4. How to interpret these numbers

- **Compare shape, not absolute numbers, across machines.** A different CPU,
  a MySQL instance not sharing a loopback interface with the app, or a
  busier machine will all shift every number. What generalizes:
  - `GET /health` (no DB, no auth, no RBAC check) is the fastest route by a
    wide margin (~2.4x the next-fastest scenario here) — it's a useful
    "framework + network floor" reference point for every other route.
  - **`wiki: list pages` and `wiki: full-text search` are both slower than
    `wiki: get single page`** despite all three being simple authenticated
    reads — both scan/filter across the seeded namespace's pages (a
    `LIKE`-based scan for search, a full-namespace `SELECT` for list)
    rather than a single indexed-PK lookup, so this gap is expected and
    should scale with `LOAD_TEST_SEED_PAGES` — re-run with a larger seed
    count before concluding a regression here.
  - **`wiki: create page` is the slowest scenario** — a write path that
    validates namespace existence, checks slug uniqueness, inserts a page
    row, and (per feature #89) snapshots a revision row, all inside one
    request — three to four sequential round-trips to MySQL per request
    versus one for a read. This is architecturally expected, not a red
    flag, unless the gap versus a prior baseline widens significantly.
- **This measures one process on one machine, not a distributed
  deployment.** No load balancer, no connection pooling across multiple app
  instances, no network hop between app and DB beyond loopback. Treat this
  as a ceiling for a single instance, not a promise about production
  capacity.
- **The production rate limit (`RATE_LIMIT_MAX=300`/minute per IP, see
  `docs/rate-limiting.md`) is deliberately raised during this run** — with
  it left at its real default, a _single IP_ sustaining any of these
  scenarios past ~5 req/s would start seeing `429 RATE_LIMIT_EXCEEDED`
  responses well before hitting any of the throughput ceilings recorded
  above; that's the rate limiter working as designed (see
  `docs/rate-limiting.md` §3 for why `300`/minute was chosen), not a
  capacity problem this document is tracking. A real distributed load test
  against the production default would need many distinct source IPs (or a
  raised per-deployment `RATE_LIMIT_MAX`) to reach these numbers — this
  harness sidesteps that by raising the limit for the one process it's
  measuring.

## 5. Re-running after a kernel/plugin change (step 3)

Re-run `npm run load-test` (same defaults, so the numbers are directly
comparable to [§3](#3-recorded-baseline)) after any change that plausibly
touches the request hot path — the kernel's capability broker/loader, the
Fastify request pipeline in `api-gateway`, `rbac`'s `check()`, or `wiki`'s
own route handlers/store layer. Compare the new run's printed summary table
against [§3](#3-recorded-baseline):

- A **material regression** (a scenario materially slower or its error
  count no longer zero, on the same machine/config) is worth investigating
  before merging — note it here (see the changelog below) even if you
  decide it's an acceptable tradeoff, so the next person re-running this
  doesn't have to rediscover it.
- A **material improvement** is worth recording too — replace
  [§3](#3-recorded-baseline)'s table with the new run and add a changelog
  entry noting what changed and why, so this document keeps reflecting the
  current codebase rather than going stale.

### Changelog

- **2026-08-21** — Initial baseline (feature #110). Recorded on the
  environment in [§2](#2-environment-this-baseline-was-recorded-on); see
  [§3](#3-recorded-baseline) for the numbers.

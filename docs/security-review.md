# OWASP Top 10 Self-Audit (feature #112)

This document is AppSkeleton's own walkthrough of the OWASP Top 10 (2021
edition) against the _actual implemented application_ — not a generic
checklist. It exists for the same reason `docs/security.md` (CI scanning
gates) and `docs/rate-limiting.md` do: so a human _or an AI coding agent_
reasoning about this codebase's security posture has one place that names
the real control (or the real gap) for each category, with file references,
instead of having to reverse-engineer it from source.

**Relationship to `docs/security.md`.** That document covers two _automated
CI gates_ (`npm audit`, gitleaks) — supply-chain and secrets scanning. This
document is the complementary, broader OWASP Top 10 walkthrough: application
design and code, not CI tooling. Where a category overlaps (A06, A08 supply
chain), this document cross-references rather than duplicates.

**Scope.** AppSkeleton is a plugin-based Node/TypeScript kernel
(`src/core`) with an HTTP surface owned by `api-gateway`
(`src/plugins/api-gateway`), an RBAC policy engine (`src/plugins/rbac`), a
MySQL persistence layer (`src/plugins/database-mysql`), an
auto-escaping HTML template renderer (`src/plugins/html-renderer`), and a
wiki application (`src/plugins/wiki`) built on top of all of the above.
There is currently no traditional username/password login flow anywhere in
the codebase — see A07 below — so this audit's access-control findings are
scoped to the session/RBAC model that _does_ exist.

---

## A01:2021 — Broken Access Control

**Checked:** `src/plugins/api-gateway/src/rbac-protection.ts` (per-route
`requiredPermission` gate), `src/plugins/wiki/src/access.ts`
(`checkWikiAccess`/`assertWikiAccess`, namespace-scoped overrides),
`src/plugins/rbac/src/policy.ts` (deny-by-default core), `src/plugins/api-gateway/src/cors.ts`.

**Verdict: OK.**

- `rbac-protection.ts`'s `preHandler` hook resolves the caller's identity
  from the signed session cookie and gates any route registered with
  `requiredPermission` behind a real `rbac:check(userId, action, resource)`
  call — no session, no identity to check (401); a resolved identity that
  fails the check gets 403 (`registerRbacProtection`, lines 134–177). A
  route that doesn't opt into `requiredPermission` is not silently open by
  omission-as-a-feature; it's simply outside this audit's IDOR concern
  because the only routes that touch data at all (wiki) do declare it (see
  `src/plugins/wiki/index.ts`'s route registrations).
- `rbac`'s own policy engine is deny-by-default and purely additive
  (`policy.ts` rules 1–2, cited in `bootstrap-admin.ts`'s docs) — there is
  no code path that grants access absent an explicit role/permission grant.
- The wiki plugin's `checkWikiAccess` (`access.ts` lines 96–109) resolves a
  namespace-scoped override _before_ falling back to the global `wiki:`
  resource, and that override can only ever be _additive_ (grant more),
  never restrictive — confirmed by reading `policy.ts`'s precedence rules
  the module doc cites. Every mutating/restricted-read wiki operation routes
  through `assertWikiAccess`/`assertWikiAccessAudited`
  (`authorized-store.ts`), so there's no code path that reaches the
  database layer while skipping the check.
- CORS (`cors.ts`) is deny-by-default: an `Origin` not on `CORS_ORIGIN`'s
  allow-list gets no `Access-Control-Allow-Origin` header at all, rather
  than `@fastify/cors`'s own upstream default of reflecting every origin.
- IDOR: wiki resource identity checks are role-based (viewer/editor/admin),
  not owner-based — there is no per-row "created_by" ownership concept in
  this app's design, so there is no ownership check to bypass. A user
  holding `wiki:write` can edit any page, by design (matches
  `docs/plugin-conventions.md`'s described permission grammar — this is
  the intended access model, not a gap).

No finding.

## A02:2021 — Cryptographic Failures

**Checked:** `src/plugins/api-gateway/src/session.ts` (HMAC-SHA256 session
signing), `src/plugins/api-gateway/src/csrf.ts` (token generation/
comparison), `src/plugins/rbac/src/bootstrap-admin.ts` (credential
generation), `src/plugins/api-gateway/src/session-config.ts`,
`.env.example`.

**Verdict: FINDING (fixed in this change) — see below. Everything else in
this category: OK.**

- Session ids: 256 bits of `randomBytes`, HMAC-SHA256-signed with
  `SESSION_SECRET`, verified with `timingSafeEqual` via a
  length-check-then-constant-time-compare helper (`signaturesMatch`,
  `session.ts` lines 69–73) that never lets a length mismatch fall through
  to `timingSafeEqual`'s own throw (which would otherwise leak length via
  which code path threw). No custom/weak crypto (no MD5/SHA1, no static
  IV, no `Math.random()` for anything security-relevant).
- CSRF tokens: same pattern — 256-bit random, constant-time compared
  (`csrf.ts`'s `tokensMatch`).
- Bootstrap-admin credential: `randomBytes(32)` token, never routed through
  the structured logger (which would otherwise be genuinely safe to log —
  see A09 — but this module deliberately bypasses it anyway since the
  _whole point_ is to reveal this one secret to a human operator once).
- Cookies: `httpOnly: true` unconditionally, `secure` config-driven
  (`COOKIE_SECURE`, defaults to `true`), `sameSite: "lax"`
  (`session.ts`'s `registerSessionCookies`) — matches spec.md's security
  baseline exactly.
- **FINDING (now fixed): `SESSION_SECRET` accepted its own
  `.env.example` placeholder value.**
  `SessionConfigSchema` (`session-config.ts`) only enforced
  `.min(16)` on `SESSION_SECRET`. `.env.example`'s placeholder,
  `"change-me-to-a-long-random-string"`, is 34 characters — long enough to
  pass that check outright. A deployment that runs `init.sh` (which copies
  `.env.example` to `.env` on first run) and never edits `SESSION_SECRET`
  before deploying would boot "successfully" while signing every session
  cookie with a value published in this repository's own git history —
  letting anyone who has read this repo forge arbitrary session ids
  (`issueSessionId`/`verifySessionId` in `session.ts` trust the secret
  completely; a known secret means a known-valid signature for any chosen
  id). Severity: **High** (full session-forgery / authentication bypass
  the moment a real deployment skips editing one `.env` line — a
  realistic, common misconfiguration, not a contrived scenario).
  **Fix applied:** `SessionConfigSchema.SESSION_SECRET` now also rejects
  that exact placeholder value (case-insensitively) via `.refine()`,
  failing fast with the same `ConfigError` a missing/too-short secret
  already produces (`src/plugins/api-gateway/src/session-config.ts`).
  Covered by two new tests in
  `tests/plugins/api-gateway/session-config.test.ts`.
- Related, lower-severity observation (not fixed — see rationale): the
  MySQL dev credential `.env.example`/`docker-compose.yml` ship
  (`DB_PASSWORD=change-me`) has the same "placeholder passes validation"
  shape (`database-mysql/src/config.ts`'s `DB_PASSWORD` is only
  `.min(1)`). This is meaningfully lower risk than `SESSION_SECRET` — it
  requires network access to the MySQL port (typically firewalled/
  internal, unlike the internet-facing HTTP session layer) to exploit, and
  every docker-compose-backed integration test in this repo
  (`tests/**/*.integration.test.ts`) hardcodes `DB_PASSWORD: "change-me"`
  to match the real local dev database, so rejecting that literal value at
  the schema level would break the local dev/test story, not just warn
  about production. Left as an operator-hygiene note (`docs/operator-guide.md`
  is the right place for a "change every default credential before
  deploying" reminder) rather than a schema-level fix.

## A03:2021 — Injection

**Checked:** every `dbQuery.query()` call site across
`src/plugins/*/src/*.ts` (Kysely usage), `src/plugins/wiki/src/search.ts`
(the one raw `sql` tagged-template use in the codebase), `src/plugins/database-mysql/src/migrator.ts`
(dynamic `import()` of migration files), a repo-wide grep for
`child_process`/`exec`/`spawn`.

**Verdict: OK.**

- Every database access in this codebase goes through Kysely's query
  builder (`db.selectFrom(...)`, `.insertInto(...)`, etc.), which
  parameterizes every value automatically — no string-concatenated SQL
  found anywhere in `src/`.
- The one place raw SQL text appears at all is `search.ts`'s
  `matchExpression()`, which builds `` sql`MATCH(title, content) AGAINST(${term} ...)` ``
  — Kysely's `sql` tagged template compiles every `${...}` to a bound `?`
  placeholder; `term` is never spliced into the SQL text. This repo also
  has a static ESLint rule (`eslint.config.js`'s `no-restricted-syntax`)
  specifically forbidding a template literal with interpolated
  expressions inside a `query()` callback, as a structural guard against
  exactly this class of bug — `search.ts`'s own doc comment explains why
  `matchExpression()` is deliberately built outside the callback to
  satisfy both the rule and its actual intent.
- `migrator.ts`'s `importMigrationModule()` dynamically `import()`s files
  discovered from a fixed, non-user-controlled directory
  (`listMigrationFiles(migrationsDir)`, where `migrationsDir` is always a
  hardcoded plugin-owned path, e.g. `DATABASE_MYSQL_MIGRATIONS_DIR`) — not
  attacker-reachable input, so this is not a code-injection surface.
- No `child_process`/`exec`/`spawn` calls anywhere in `src/` (grep
  confirmed; the `plugin-builder` CLI only runs `RegExp.exec()`, unrelated).
- No NoSQL/template-string HTML injection: see XSS finding below (A03
  covers injection broadly, but XSS is called out separately since OWASP
  tracks it under A03 in the 2021 edition — see "XSS" subsection at the
  end of this document).

## A04:2021 — Insecure Design

**Checked:** `src/plugins/api-gateway/src/rate-limit.ts` /
`rate-limit-config.ts`, `docs/rate-limiting.md`, `src/plugins/rbac/src/bootstrap-admin.ts`
(account-enumeration/lockout angle).

**Verdict: OK, with one contextual note.**

- Rate limiting (`@fastify/rate-limit`) is wired globally — every route,
  `/health` included, is covered by default (`RATE_LIMIT_MAX=300` per
  `RATE_LIMIT_WINDOW_MS=60000`, per-IP) unless a route opts into a
  stricter override; `docs/rate-limiting.md` documents the traffic
  reasoning and is itself kept in sync with the schema defaults by a
  dedicated test (`tests/plugins/api-gateway/rate-limiting-docs.test.ts`).
  This bounds brute-force/enumeration attempts against any route,
  including RBAC-protected ones, without any route-specific work.
- There is no traditional login endpoint (see A07) to brute-force or
  enumerate accounts against in the first place — the closest analog,
  bootstrap-admin provisioning (`bootstrap-admin.ts`), issues a
  256-bit random token once, out-of-band (console banner, not an HTTP
  response), so there's nothing an attacker can probe over HTTP to learn
  whether it succeeded.
- Contextual note, not a finding: because there is no login flow yet, this
  category is currently under-exercised by design. When a real
  authentication flow is added, it should be registered through
  `registerRoute()` with an explicit, _stricter_ per-route
  `rateLimit` override (the mechanism already exists — see
  `docs/rate-limiting.md` §3, "Per-route overrides for sensitive
  endpoints") rather than relying on the 300/min global default, which is
  sized for general API traffic, not credential-guessing resistance.

## A05:2021 — Security Misconfiguration

**Checked:** `src/plugins/api-gateway/src/security-headers.ts` (helmet
wiring), `src/plugins/api-gateway/src/error-handler.ts` (stack-trace
leakage), `.env.example`, `src/core/config.ts`'s `NODE_ENV` handling.

**Verdict: OK.**

- `@fastify/helmet` is wired globally (`registerSecurityHeaders`, awaited
  before any route registers — see that module's own docs on why await
  order matters for the `onRoute` hook) with CSP, HSTS, X-Frame-Options,
  X-Content-Type-Options, and the rest of helmet's default set. All three
  are independently configurable (`HELMET_ENABLED`/`HELMET_CSP_ENABLED`/
  `HELMET_HSTS_ENABLED`) but default _on_ — secure by default.
- `error-handler.ts`'s `registerErrorHandling` never echoes an internal
  error message to a client, in any environment — `toErrorEnvelope()`'s
  public `message` is always the generic `"An unexpected error occurred."`
  string; only `stack` is environment-gated (`includeStack: nodeEnv !==
"production"`), purely for local debugging. Full detail is always
  logged server-side via `request.log.error`, which itself is subject to
  `logger.ts`'s unconditional secret redaction (see A09).
- No debug/introspection endpoint is exposed over HTTP — `npm run
introspect` (`src/core/introspect.ts`) is a CLI command that boots its
  own kernel instance; it is not a registered route reachable from the
  network.
- `.env.example` ships conservative defaults (`COOKIE_SECURE` secure-true
  with an explicit dev-only escape hatch, `DB_SSL_REJECT_UNAUTHORIZED`
  true, helmet all on) — see A02 for the one placeholder-credential
  finding (fixed) and the DB-password observation (not fixed, rationale
  given there).

## A06:2021 — Vulnerable and Outdated Components

**Checked:** `docs/security.md` §1 (npm audit CI gate), a live
`npm audit --audit-level=high` run against this checkout, `package.json`
dependency placement.

**Verdict: OK — no high/critical findings; one moderate, dev-only finding
noted for completeness.**

- `npm audit --audit-level=high` (matching the exact CI gate command in
  `docs/security.md` §1.1) currently reports **zero** high/critical
  advisories.
- `npm audit` (no severity filter) reports 3 **moderate** advisories, all
  the same root cause: `uuid <11.1.1` (missing buffer bounds check,
  GHSA-w5hq-g745-h8pq), pulled in transitively via `hyperid` ->
  `autocannon`. `autocannon` is a `devDependency` only (`package.json`) —
  it is `scripts/load-test.ts`'s load-testing tool (see
  `docs/performance-baseline.md`), never shipped or run in production —
  so this has no production attack surface, and correctly stays below the
  `--audit-level=high` gate rather than needing a `--audit-level=moderate`
  tightening. No action taken; re-check when `autocannon` next publishes a
  release pulling in a patched `uuid`.
- This category is otherwise the CI gate's job by design (see
  `docs/security.md` §1 for the full remediation runbook) — this audit
  doesn't duplicate that process, only confirms it's actually catching
  something real today.

## A07:2021 — Identification and Authentication Failures

**Checked:** `src/plugins/api-gateway/src/session.ts`,
`src/plugins/api-gateway/src/rbac-protection.ts`'s own docs ("no separate
user-account system in this codebase yet"), a repo-wide grep for
password/bcrypt/argon2 usage and for actual `issueSessionCookie(` call
sites.

**Verdict: OK, given actual scope — one design gap called out, not fixed
(out of scope for this audit).**

- There is currently no username/password (or any other credential-based)
  login flow anywhere in `src/`: `issueSessionCookie()` is fully
  implemented and exported (`session.ts`) but has **zero real call
  sites** outside its own tests — confirmed by grepping for
  `issueSessionCookie(` across `src/`. `rbac-protection.ts`'s own module
  doc states this plainly: "There is no separate user-account system in
  this codebase yet." Consequently, there is no password-hashing question
  (no bcrypt/argon2/scrypt anywhere, and none needed yet), no session-
  fixation surface (nothing issues a _pre_-authentication session that
  persists across a login this app doesn't have), and no logout endpoint
  to audit either.
- What _is_ implemented is exercised correctly: `readSessionId`/
  `verifySessionId` reject a missing, malformed, or signature-mismatched
  cookie outright (`session.ts` lines 106–117, 185–194) — a tampered
  cookie is never treated as a valid session, and `rbac-protection.ts`
  treats "no valid session" as 401 before ever consulting `rbac:check`.
- This is flagged as a **design gap for future work**, not a fixable
  finding in this session: building a real authentication flow (password
  or otherwise) is a substantial feature in its own right, well outside
  "audit the app that exists today." When it lands, it should (a) call
  `issueSessionCookie` only after verifying a real credential, (b)
  register itself with a stricter per-route rate limit (see A04), and (c)
  invalidate/rotate the session id on privilege change, none of which is
  buildable in the abstract today.

## A08:2021 — Software and Data Integrity Failures

**Checked:** `src/plugins/database-mysql/src/migrator.ts` (checksum-
verified migration runner), `src/plugins/database-mysql/index.ts` /
`docs/operator-guide.md` §2.3 (how `db:migrate` is actually wired today),
`docs/security.md` §2 (gitleaks — cross-referenced, not re-audited).

**Verdict: FINDING — known, already-documented architectural limitation.
Not fixed in this change (see rationale). No new issue discovered beyond
what the codebase already tracks.**

- `migrator.ts`'s `verifyAppliedChecksums()` is a real, working integrity
  control: before running anything pending, it re-hashes every migration
  file on disk and compares it against the checksum recorded at
  apply-time (`schema_migrations.checksum`), refusing to proceed (and
  refusing `down()` too) on any mismatch or on an applied migration whose
  file is missing entirely — proven by
  `tests/plugins/database-mysql/migrator.integration.test.ts`'s tamper/
  restore suite.
- **The finding:** that verification is scoped incorrectly relative to
  how migrations are actually applied. Every plugin's migrations are
  recorded into _one global_ `schema_migrations` table
  (`MIGRATIONS_TABLE = "schema_migrations"`, shared across every caller),
  but `verifyAppliedChecksums(applied, files)` is only ever handed the
  _calling plugin's own_ `files` list (`listMigrationFiles(migrationsDir)`
  — a single plugin-owned directory, e.g.
  `DATABASE_MYSQL_MIGRATIONS_DIR`). The moment a second plugin's
  migrations are ever recorded in that shared table, any other plugin's
  next `runMigrationsUp`/`runMigrationsDown` call sees rows it cannot
  possibly find a matching file for (they belong to a different plugin's
  directory) and throws `MigrationError` ("missing its file on disk"),
  refusing to run anything — a false-positive integrity failure, not a
  real tampering event.
  This is exactly the currently-observed root cause of this repo's
  long-standing `tests/plugins/database-mysql/migrator.integration.test.ts`
  / `integration.test.ts` failures (11 tests as of this session's `init.sh`
  baseline) — the fixture suite's own temp-directory migrations don't
  include whatever real migration(s) `npm run migrate` already applied to
  the shared table earlier in the same `init.sh` run.
- **Why this is real, not just a test-hygiene issue:** `docs/operator-guide.md`
  §2.3 already states this in production terms: "as shipped today, **no
  plugin in this repo actually [wires `db:migrate` from its own
  `onEnable`]**... In practice, a new plugin that owns tables today must
  wire its own `db:migrate` call from `onEnable` itself." The moment a
  second plugin follows that documented, intended path, its very first
  migration attempt after any other plugin has migrated anything will
  throw and permanently block that plugin's schema from ever being
  created — a real, latent, currently-undetected-because-unexercised
  denial-of-service/data-integrity bug in the generic `db:migrate`
  capability. Confirmed empirically: the running dev database currently
  has exactly one migration applied (`database-mysql`'s own
  `database_mysql_audit_log`); `rbac`/`wiki`'s tables do not exist in it
  at all, because neither plugin's `onEnable` calls `db:migrate` yet —
  the bug hasn't fired in production only because nothing has triggered
  the multi-plugin case yet.
- **Why not fixed in this session:** this is an extensively pre-existing,
  independently rediscovered, and explicitly deferred issue —
  `claude-progress.txt` documents it across at least a dozen prior feature
  sessions (features #19, #27, #34, #38, #75, #77, #86, #87, #89, #98,
  #100, and others), each concluding it is "known, pre-existing, and
  explicitly NOT this feature's job to fix," with the correct remediation
  already named: a per-plugin-namespaced tracking table (e.g. a
  `plugin_id` column on `schema_migrations`, with `getAppliedMigrations`
  scoped by it). Implementing that fix now would mean an ALTER to the
  shared bookkeeping table's schema, changes to every `runMigrationsUp`/
  `runMigrationsDown` call site's recording logic, and re-verification of
  every migration-touching integration suite across `database-mysql`,
  `rbac`, and `wiki` — a foundational, wide-blast-radius change
  disproportionate to a self-audit feature, and explicitly out of scope
  per this repo's own long-established precedent for this exact issue.
  Recorded here, in the canonical security document, specifically so it
  is no longer only buried in `claude-progress.txt` history — whichever
  future feature finally owns fixing `migrator.ts`'s tracking-table
  scoping should start from this section.
- Severity: **Medium** (data-integrity control produces false-positive
  denial-of-service under a documented, intended usage pattern; not
  currently exploitable by an external attacker, and not currently
  triggered because that usage pattern isn't exercised yet — but it will
  break the first real feature that follows `operator-guide.md`'s own
  documented "intended path").
- Migration file provenance itself (not the tracking table) is sound:
  `assertTableNamespace`/`withTableNamespaceGuard` (`migrator.ts` lines
  203–299) reject any migration that tries to create a table outside its
  own plugin's namespace, closing off a separate class of cross-plugin
  data-integrity risk unrelated to the tracking-table finding above.
- Supply-chain integrity (signed commits, dependency pinning, secrets in
  history): covered by `docs/security.md` §2 (gitleaks) — not re-audited
  here.

## A09:2021 — Security Logging and Monitoring Failures

**Checked:** `src/core/logger.ts` (redaction), `src/core/audit.ts` /
`audit-mysql.ts`, `src/plugins/rbac/index.ts`'s `recordCheckDecision`,
`src/plugins/wiki/src/access.ts`'s `recordWikiAudit`/
`assertWikiAccessAudited`.

**Verdict: OK.**

- Every `rbac:check` decision — allow and deny — is recorded to the
  kernel audit trail (feature #38), persisted to MySQL once
  `database-mysql` is available (feature #29). Every wiki-level
  permission denial and every mutation (`create`/`update`/`delete`) gets
  its own audit entry with actor + page identity
  (`access.ts`'s `recordWikiAudit`/`assertWikiAccessAudited`), a second,
  complementary trail on top of `rbac:check`'s own generic one.
- `logger.ts`'s secret redaction is unconditional and has "no opt-out": a
  recursive walk redacts any key matching `password`/`secret`/`token`/
  `apikey`/`authorization` (case/punctuation-insensitive) at any nesting
  depth, across the logger's base context, child-logger bindings, and
  every individual log call's arguments — including values reached only
  through a custom `toJSON()`, and including `Error`/`AppError`
  properties (with `cause` dropped entirely rather than redacted
  imperfectly, since it can wrap arbitrary unvalidated data). This is
  exactly why `bootstrap-admin.ts` has to _deliberately bypass_ the
  structured logger to reveal its own credential once — strong evidence
  the redaction path is real and load-bearing, not decorative.
- Log injection: every log line is structured JSON (pino), with
  user-controlled strings placed as object _values_, never concatenated
  into free text that could break the surrounding structure — there is no
  printf-style message-building of the form `` `User ${input} did X` ``
  anywhere in the audit-relevant paths reviewed. A malicious value can
  populate a field's value but cannot forge a sibling field or fabricate
  an unrelated log line.
- Unexpected errors are always logged server-side with full detail
  (`error-handler.ts`'s `request.log.error({ err: error }, ...)`) even
  though the HTTP response never echoes that detail — see A05 — so a
  genuine failure is never silently invisible to an operator.

No finding.

## A10:2021 — Server-Side Request Forgery (SSRF)

**Checked:** repo-wide grep for `fetch(`/`axios`/`http.request`/
`https.request`/`got(` across `src/`.

**Verdict: OK — no applicable attack surface.**

- The only `fetch()` in the entire codebase is client-side JavaScript
  embedded in a generated HTML form template
  (`src/plugins/wiki/src/page-form.ts` — the browser's own same-origin
  form submission, not server-initiated). No server-side code in this
  application makes an outbound HTTP request driven, directly or
  indirectly, by user-supplied input (a URL, host, or otherwise). There is
  no webhook-registration, URL-preview/unfurl, image-proxy, or similar
  feature anywhere in this codebase that would create an SSRF surface.

---

## XSS (tracked under OWASP A03:2021 — Injection)

**Checked:** `src/plugins/html-renderer/src/escape.ts` (the renderer's
own auto-escaping), `src/plugins/wiki/src/search.ts`'s locally
re-implemented `escapeHtml`/`highlightAndEscape` (feature #92's search
snippets), `src/plugins/wiki/src/diff.ts` (feature #94's diff view).

**Verdict: OK.**

- `html-renderer`'s templates auto-escape interpolated values by default
  (feature #47's established convention, referenced throughout
  `claude-progress.txt` and relied on by `diff.ts`'s own module doc,
  which explicitly avoids any hand-rolled escaping in favor of that
  existing mechanism).
- `search.ts` cannot import `html-renderer`'s internal `escapeHtml`
  directly (cross-plugin `src/` imports are forbidden —
  `docs/plugin-conventions.md` §5), so it re-implements the same
  five-character HTML-entity escape locally (`HTML_ESCAPES`/`escapeHtml`,
  `search.ts` lines 209–220) — reviewed and confirmed to escape all five
  of `& < > " '`.
  `highlightAndEscape()` (lines 231–250) applies that escape to **both**
  halves of the output: the surrounding plain text _and_ the highlighted
  term itself, on every iteration of the match loop — not just one side,
  which was the specific risk called out for this review (a term or
  surrounding content containing `<script>` cannot inject markup into
  `snippetHtml` either way it enters the string). An empty search term
  degrades to a plain `escapeHtml(text)` call rather than looping
  indefinitely on a zero-length match.
- No other hand-rolled HTML-string-building was found outside these two
  reviewed, escape-covered paths.

No finding.

---

## Summary: fix backlog (ranked by severity)

| #   | Category                                                                                                                                                                                                                                                                             | Severity      | Status                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A02 — `SESSION_SECRET` accepted the `.env.example` placeholder value, permitting session forgery on an unedited deployment                                                                                                                                                           | High          | **Fixed this change** — `session-config.ts` now rejects the exact placeholder via `.refine()`; covered by 2 new tests.                                                                                                                                                                                                                       |
| 2   | A08 — `migrator.ts`'s shared `schema_migrations` tracking table causes a false-positive integrity failure (and would block real migrations) the moment a second plugin wires `db:migrate` from its own `onEnable`, per `docs/operator-guide.md` §2.3's own documented intended usage | Medium        | **Documented, not fixed** — pre-existing, extensively tracked in `claude-progress.txt` across a dozen+ prior sessions as explicitly out of scope per-feature; correct fix (a `plugin_id`-scoped tracking table) named here for whoever picks it up. Currently non-exploitable in production (no plugin exercises the multi-plugin path yet). |
| 3   | A02 — `DB_PASSWORD` accepts its own `.env.example`/`docker-compose.yml` placeholder (`change-me`)                                                                                                                                                                                    | Low           | **Not fixed** — lower risk (requires DB-network access, not internet-facing), and every docker-compose-backed integration test hardcodes this literal value, so a schema-level rejection would break the local dev/test story. Left as an operator-hygiene reminder.                                                                         |
| 4   | A06 — 3 moderate `npm audit` findings (`uuid` via `hyperid` via `autocannon`)                                                                                                                                                                                                        | Informational | **No action** — `autocannon` is dev-only (load testing), never shipped to production; below the `--audit-level=high` CI gate by design.                                                                                                                                                                                                      |
| 5   | A04/A07 — no per-route stricter rate limit exists yet for a future login/credential-verification endpoint, because no such endpoint exists yet                                                                                                                                       | Informational | **No action** — the mechanism (`docs/rate-limiting.md` §3) already exists for whoever builds that feature to use.                                                                                                                                                                                                                            |

## Re-verification

After applying fix #1 above:

- `npm run build` — clean.
- `npm run lint` — clean.
- Full suite (`npm test` / `npx vitest run`) re-run to confirm zero new
  regressions relative to `init.sh`'s own baseline for this session — see
  `claude-progress.txt`'s entry for this feature for the exact before/after
  counts. The only failures present in either run are the pre-existing,
  extensively-documented `tests/plugins/database-mysql/{integration,migrator.integration}.test.ts`
  failures this document's A08 section describes — identical before and
  after this feature's change, confirmed unrelated to it.

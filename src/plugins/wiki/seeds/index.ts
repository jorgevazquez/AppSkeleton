/**
 * Wiki seed content — starter Home page and platform documentation (feature
 * #99 — "Wiki seed content (starter Home page and platform documentation)").
 *
 * Registers one seed — `"wiki:starter-content"` — with the generic seed
 * mechanism `src/core/seed.ts` built for feature #25, exactly like
 * `rbac/seeds/index.ts`'s own `"rbac:default-roles"` seed (feature #37):
 * `src/cli/seed.ts`'s `loadPluginSeedModules()` discovers every plugin's own
 * `seeds/index.{ts,js,mjs,cjs}` and imports it purely for this file's
 * module-scope {@link registerSeed} call.
 *
 * ## Why this writes straight to the `wiki_*` tables, not through `pages.ts`
 *
 * `pages.ts`'s `WikiPagesStore` is built on top of the `db:query`
 * capability, which only exists once the kernel has loaded and wired
 * plugins together — a seed, like `rbac/seeds/index.ts`'s own, runs against
 * the plain `Kysely` handle `runSeeds()` hands every seed's `run(db)` (see
 * `core/seed.ts`'s `SeedFunction`/`SeedableDatabase`), with no capability
 * broker involved at all. So this file duplicates just the table names
 * (`NAMESPACES_TABLE`/`PAGES_TABLE`, mirroring `pages.ts`'s own
 * `NAMESPACES_TABLE`/`PAGES_TABLE` constants) rather than importing
 * `pages.ts` — this file sits alongside `src/`, not inside it, and must stay
 * a free-standing, dependency-light fixture (same rationale
 * `rbac/seeds/index.ts`'s own doc comment gives for its own table-name
 * duplication).
 *
 * ## Idempotency (feature #99 step 2)
 *
 * This seed's own `run(db)` does plain, non-upserting `INSERT`s — it does
 * NOT check whether the "main" namespace or the "home" page already exist
 * before inserting them. That is deliberate and mirrors
 * `rbac/seeds/index.ts`'s own precedent (feature #37 step 2) and
 * `tests/plugins/database-mysql/seed.integration.test.ts`'s original
 * feature #25 idempotency proof: idempotency is a property of
 * `runSeeds()`'s own bookkeeping (the `schema_seeds` tracking table, keyed
 * by this seed's registration key), not something every seed author must
 * hand-roll. Once `"wiki:starter-content"` is recorded as applied,
 * `runSeeds()` never calls this function again for that database — so
 * running the seed CLI twice never re-inserts the Home page. See
 * `tests/core/wiki-starter-content-seed.integration.test.ts` for the test
 * proving this (feature #99 step 3).
 *
 * ## The starter content
 *
 * Dogfoods `spec.md` itself, per feature #99 step 1: a Home page in the
 * `"main"` namespace (the same top-level namespace id
 * `tests/plugins/wiki/page-tree.test.ts` and
 * `tests/plugins/wiki/authorized-store.integration.test.ts` already use as
 * their own "main" fixture convention) links out to a handful of docs pages
 * in a child `"docs"` namespace, each summarizing one section of `spec.md`
 * (vision, kernel architecture, shipped plugins, security baseline) so the
 * wiki — spec.md's own "proof that the platform works end-to-end" — has
 * real starter content describing the platform it's running on, from the
 * very first `npm run seed`.
 */
import { registerSeed, type SeedableDatabase } from "../../../core/seed.js";
import type { Kysely } from "kysely";

/** Mirrors `pages.ts`'s own table-name constants — see this file's module doc for why they are duplicated, not imported. */
const NAMESPACES_TABLE = "wiki_namespaces";
const PAGES_TABLE = "wiki_pages";

/** This seed's own registration identity — `"wiki:starter-content"` once joined by `core/seed.ts`'s `seedKey`. */
export const WIKI_SEED_PLUGIN_ID = "wiki";
export const STARTER_CONTENT_SEED_NAME = "starter-content";

/** The top-level namespace the Home page lives in — matches this repo's existing "main" fixture convention. */
export const MAIN_NAMESPACE_ID = "main";
/** The child namespace the platform-documentation pages live in. */
export const DOCS_NAMESPACE_ID = "docs";
/** The Home page's slug within {@link MAIN_NAMESPACE_ID} — `tests/core/wiki-starter-content-seed.integration.test.ts` asserts on this directly. */
export const HOME_PAGE_SLUG = "home";

interface SeedNamespace {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly description: string | null;
}

interface SeedPage {
  readonly namespaceId: string;
  readonly slug: string;
  readonly title: string;
  readonly content: string;
}

/** The two starter namespaces — `"main"` (top-level, holds the Home page) and `"docs"` (nested under it, holds platform documentation). */
export const SEED_NAMESPACES: readonly SeedNamespace[] = [
  {
    id: MAIN_NAMESPACE_ID,
    parentId: null,
    name: "Main",
    description: "Top-level namespace.",
  },
  {
    id: DOCS_NAMESPACE_ID,
    parentId: MAIN_NAMESPACE_ID,
    name: "Documentation",
    description: "Platform documentation, dogfooding spec.md.",
  },
];

/** The starter pages — one Home page plus a handful of docs pages summarizing `spec.md`. */
export const SEED_PAGES: readonly SeedPage[] = [
  {
    namespaceId: MAIN_NAMESPACE_ID,
    slug: HOME_PAGE_SLUG,
    title: "Home",
    content: [
      "# Welcome to AppSkeleton",
      "",
      "AppSkeleton is a web application platform where **everything is a plugin**.",
      'The core ("kernel") contains no business logic at all — it only knows how',
      "to discover, validate, load, sandbox, sequence, and tear down plugins, and",
      "how to let plugins talk to each other through well-defined, permissioned",
      "contracts.",
      "",
      "This wiki is itself running on AppSkeleton — the `wiki` plugin is, per",
      '`spec.md`, "the proof that the platform works end-to-end": Markdown pages',
      "with revision history and diffing, a page tree, full-text search, and",
      "RBAC-gated permissions, all built entirely on top of the same kernel",
      "capabilities a third-party plugin author would use.",
      "",
      "## Platform documentation",
      "",
      "- **docs/architecture** — the kernel architecture and its non-negotiable",
      "  qualities (secure, robust, performant).",
      "- **docs/plugins** — the shipped plugins and what each one owns.",
      "- **docs/security** — the security baseline that applies everywhere.",
    ].join("\n"),
  },
  {
    namespaceId: DOCS_NAMESPACE_ID,
    slug: "architecture",
    title: "Kernel Architecture",
    content: [
      "# Kernel Architecture",
      "",
      "The kernel (`src/core`) is the only part of the system that is NOT a",
      "plugin. It provides:",
      "",
      "- **Plugin Manifest** — a `plugin.json` per plugin (validated by zod),",
      "  declaring semver-range dependencies on other plugins, capabilities",
      "  required/provided, and a lifecycle entry point.",
      "- **Plugin Registry & Loader** — discovers plugins under `src/plugins/*`,",
      "  topologically sorts by `depends_on`, and calls lifecycle hooks",
      "  (`onInstall`, `onEnable`, `onDisable`, `onUninstall`).",
      "- **Capability/Permission Broker** — a plugin only receives handles to",
      "  the capabilities it declared and that the operator has granted; no",
      "  global singletons reached via bare imports for cross-plugin access.",
      "- **Event Bus** — typed pub/sub so plugins can react to each other's",
      "  lifecycle and domain events without direct coupling.",
      "- **Config System** — layered config (defaults → env → operator",
      "  overrides), validated per-plugin against a zod schema.",
      "- **Structured Logger & Audit Trail** — every capability grant,",
      "  permission check, and mutating action is logged with",
      "  actor/target/outcome.",
      "- **Error Isolation** — a plugin that throws during load or in a",
      "  request handler is caught and logged; it must never crash the whole",
      "  process or leak stack traces to clients.",
      "",
      "Non-negotiable qualities, in priority order: **secure**, **robust**,",
      "**performant**.",
    ].join("\n"),
  },
  {
    namespaceId: DOCS_NAMESPACE_ID,
    slug: "plugins",
    title: "Shipped Plugins",
    content: [
      "# Shipped Plugins",
      "",
      "1. **rbac** — Role-based access control: roles, permissions",
      "   (`resource:action` grammar), role/user assignments, a `can(user,",
      "   action, resource)` check exposed as a capability, and an audit log",
      "   of access decisions.",
      "2. **database-mysql** — Owns the MySQL connection pool, a versioned",
      "   migration runner, a per-plugin table-namespace convention, and the",
      "   `db:query`/`db:transaction` capabilities other plugins consume — no",
      "   plugin talks to MySQL directly.",
      "3. **html-renderer** — A dependency-free templating engine: layouts,",
      "   partials, context-aware auto-escaping to prevent XSS by default, and",
      "   a `render:template` capability.",
      "4. **api-gateway** — The single place HTTP routes come into existence:",
      "   wraps Fastify and exposes an `http:route` capability, with request",
      "   validation, consistent error envelopes, rate limiting, and RBAC",
      "   middleware integration.",
      "5. **plugin-builder** — A meta-plugin that scaffolds new,",
      "   spec-compliant plugins for humans and AI coding agents alike.",
      "6. **wiki** — This application: Markdown pages, revision history and",
      "   diffing, a page tree, full-text search, and RBAC-gated",
      "   read/write/admin permissions per page or namespace.",
    ].join("\n"),
  },
  {
    namespaceId: DOCS_NAMESPACE_ID,
    slug: "security",
    title: "Security Baseline",
    content: [
      "# Security Baseline",
      "",
      "Applies everywhere in AppSkeleton:",
      "",
      "- All input validated at the boundary with zod/JSON-schema; never trust",
      "  client input, including plugin config loaded from disk.",
      "- Parameterized queries only — raw string concatenation is structurally",
      "  awkward on purpose.",
      "- Auto-escaping HTML renderer; explicit opt-out only, and audited.",
      "- Secrets only from environment/.env, never hard-coded, never logged.",
      "- CSRF protection on state-changing routes, secure session cookies",
      "  (`HttpOnly`, `Secure`, `SameSite=Lax` by default).",
      "- Rate limiting and request size limits on the API gateway by default.",
      "- Principle of least privilege for plugin capabilities — a plugin's",
      "  manifest is the ceiling of what it can ever do at runtime.",
      "- Dependency audit (`npm audit`) wired into CI.",
    ].join("\n"),
  },
];

/**
 * The seed's fixture logic — exported (not just registered) so a test can
 * call {@link registerSeed} with it directly (see
 * `tests/core/wiki-starter-content-seed.integration.test.ts`), the same way
 * `rbac/seeds/index.ts`'s own `seedDefaultRolesAndPermissions` is exported
 * for its sibling integration test.
 *
 * Inserts every {@link SEED_NAMESPACES} row, then every {@link SEED_PAGES}
 * row — all within the one transaction `runSeeds()` already wraps this call
 * in (see `core/seed.ts`'s `runSeeds`), so a failure partway through never
 * leaves a half-seeded database recorded as applied.
 */
export async function seedStarterContent(db: Kysely<SeedableDatabase>): Promise<void> {
  for (const namespace of SEED_NAMESPACES) {
    await db
      .insertInto(NAMESPACES_TABLE)
      .values({
        id: namespace.id,
        parent_id: namespace.parentId,
        name: namespace.name,
        description: namespace.description,
      })
      .execute();
  }

  for (const page of SEED_PAGES) {
    await db
      .insertInto(PAGES_TABLE)
      .values({
        namespace_id: page.namespaceId,
        slug: page.slug,
        title: page.title,
        content: page.content,
      })
      .execute();
  }
}

registerSeed(WIKI_SEED_PLUGIN_ID, STARTER_CONTENT_SEED_NAME, seedStarterContent);

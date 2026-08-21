/**
 * RBAC integration for the wiki plugin (feature #93 — "RBAC integration:
 * read/write/admin permissions per page or namespace").
 *
 * ## The `wiki:` permission grammar (step 1)
 *
 * Three actions, following the rbac plugin's own `resource:action` grammar
 * (`rbac/src/permission.ts`) and matching exactly the three permissions
 * `rbac/seeds/index.ts`'s default-roles seed already provisions:
 *
 *   - `wiki:read`  — view pages (viewer, editor, and admin all hold this).
 *   - `wiki:write` — create/edit pages (editor and admin).
 *   - `wiki:admin` — administer pages/namespaces: delete, move, manage
 *     page-level access (admin only).
 *
 * These three cover every namespace by default (step 2 — "default to
 * viewer-readable/editor-writable"): a fresh install's `viewer`/`editor`/
 * `admin` roles apply uniformly, everywhere, the moment `rbac`'s
 * `"rbac:default-roles"` seed has run, with zero wiki-specific
 * configuration required.
 *
 * ### Optional per-namespace override (step 2's "unless a namespace
 * overrides it")
 *
 * A namespace may be granted its *own*, more specific permission —
 * `wiki-<namespaceId>:<action>` (e.g. `"wiki-eng-internal:write"`) —
 * through the ordinary `rbac:manage` capability, exactly like any other
 * permission (see `rbac/src/manage.ts`). `<namespaceId>` sits inside the
 * *resource* segment, joined with a hyphen rather than a second colon, so
 * the resulting string still satisfies `rbac/src/permission.ts`'s
 * one-colon-only `resource:action` grammar (`PERMISSION_PATTERN`) — a
 * namespace-scoped wiki permission is therefore a perfectly ordinary
 * permission as far as `rbac:manage`/`rbac:check` are concerned. Nothing
 * about this grammar required any change to the rbac plugin itself.
 *
 * {@link checkWikiAccess} resolves `action` for a given `namespaceId` by
 * checking the namespace-scoped resource *first*: if some role the caller
 * holds was granted `wiki-<namespaceId>:<action>` directly, access is
 * allowed immediately — this is the "override" step 2 asks for. It is
 * deliberately *additive only*: it can grant a specific namespace's
 * trusted users more access than the global default (e.g. write access
 * scoped to a single namespace, without elevating those users globally),
 * but it can never be more restrictive than the default. If the
 * namespace-scoped check doesn't grant access (no such permission exists,
 * or the caller's roles don't hold it), {@link checkWikiAccess} falls
 * through to the global `wiki:<action>` default — so an install that never
 * configures any namespace override behaves exactly like the plain
 * viewer-readable/editor-writable default described above.
 *
 * There is no way for a namespace override to *deny* what the default
 * would otherwise allow: `rbac`'s policy engine (`rbac/src/policy.ts`) is
 * deny-by-default and purely additive across a user's roles — a grant
 * never revokes another grant (see that module's precedence rules 1–2) —
 * so "override" here can only ever mean "grant more," never "take away."
 */
import type { AuditSink } from "../../../core/audit.js";
import { AuthenticationError, AuthorizationError } from "../../../core/errors.js";
import type { RbacCheckCapability } from "../../rbac/index.js";

/** The three actions the wiki plugin's permission grammar supports (step 1). */
export type WikiAction = "read" | "write" | "admin";

/** The global, namespace-agnostic wiki resource — paired with an action as `"wiki:<action>"` (step 2's default). */
export const WIKI_RESOURCE = "wiki";

/**
 * Build the namespace-scoped resource string for `namespaceId` — see this
 * module's doc comment, "Optional per-namespace override." Joined with a
 * hyphen (not a colon): `rbac/src/permission.ts`'s `resource:action`
 * grammar tolerates exactly one colon per permission string, and its
 * `SEGMENT` pattern already allows internal hyphens, so encoding the
 * namespace inside the resource *segment* keeps a namespace-scoped wiki
 * permission a valid, ordinary permission — `rbac:manage` can grant it
 * with no changes to rbac itself.
 */
export function wikiNamespaceResource(namespaceId: string): string {
  return `wiki-${namespaceId}`;
}

/**
 * Deny-by-default check for `action` on the wiki, optionally scoped to
 * `namespaceId` — see this module's doc comment for the namespace-override
 * precedence (namespace-scoped resource checked first, global `wiki`
 * resource as fallback). `namespaceId` omitted entirely means "no
 * namespace context is available for this operation" (e.g. `listPages()`
 * with no namespace filter, listing across every namespace at once) — only
 * the global default is checked in that case, since there is no single
 * namespace-scoped resource to even ask about.
 *
 * A thin, stateless wrapper around `rbacCheck.check()` — every audit
 * logging / caching concern already lives in `rbac`'s own `check()`
 * implementation (feature #35/#38, `rbac/index.ts`), so a call through
 * here is audited/cached exactly like any other `rbac:check` consumer's
 * call, with no duplicate bookkeeping in this plugin.
 */
export function checkWikiAccess(
  rbacCheck: RbacCheckCapability,
  userId: string,
  action: WikiAction,
  namespaceId?: string,
): boolean {
  if (
    namespaceId !== undefined &&
    rbacCheck.check(userId, action, wikiNamespaceResource(namespaceId))
  ) {
    return true;
  }
  return rbacCheck.check(userId, action, WIKI_RESOURCE);
}

/**
 * {@link checkWikiAccess}, but throws instead of returning `false` — the
 * shape every mutating/restricted-read wiki operation actually wants (step
 * 1's "apply rbac:check on every mutating and restricted-read operation").
 * A TypeScript assertion function: after a call that doesn't throw,
 * `userId` is narrowed from `string | undefined` to `string` for the rest
 * of the caller's function body — every guarded store method in
 * `./authorized-store.ts` relies on this to avoid a second, redundant
 * `undefined` check before using `userId`.
 *
 * Mirrors api-gateway's own 401-vs-403 split
 * (`api-gateway/src/rbac-protection.ts`): `userId === undefined` (no
 * resolved caller identity at all) throws {@link AuthenticationError}
 * (401) without ever consulting `rbac:check` — there is no identity to ask
 * about. A resolved-but-unauthorized identity throws
 * {@link AuthorizationError} (403). Neither error's client-visible
 * `publicMessage` names the specific permission/namespace — same rationale
 * `AuthorizationError`'s own docs give (`core/errors.ts`); that detail
 * lives only in the thrown error's internal `message`.
 */
export function assertWikiAccess(
  rbacCheck: RbacCheckCapability,
  userId: string | undefined,
  action: WikiAction,
  namespaceId?: string,
): asserts userId is string {
  const namespaceSuffix = namespaceId !== undefined ? ` (namespace "${namespaceId}")` : "";

  if (userId === undefined) {
    throw new AuthenticationError(
      `Wiki "${action}" requires authentication${namespaceSuffix}, but no caller identity was provided.`,
    );
  }

  if (!checkWikiAccess(rbacCheck, userId, action, namespaceId)) {
    throw new AuthorizationError(
      `User "${userId}" does not hold "${action}" permission for the wiki${namespaceSuffix}.`,
    );
  }
}

/**
 * Wiki-level audit trail integration (feature #98 — "Wiki-level audit log
 * surfaced via the kernel audit trail"). This module's `assertWikiAccess`
 * above already goes through `rbac:check`'s own audit logging (feature
 * #38) for the raw allow/deny decision, but that entry's `target` is only
 * ever the resource string checked (`"wiki"` or `"wiki-<namespaceId>"`) —
 * it never carries a *page's* identity, since `rbac:check` has no concept
 * of a wiki page. This feature's own step 1 ("actor and page identity")
 * needs the latter, so `authorized-store.ts`/`index.ts` (the two modules
 * that actually know which page an operation is about) record their own,
 * additional wiki-specific entries via {@link recordWikiAudit} /
 * {@link assertWikiAccessAudited} below — a second, complementary trail,
 * not a replacement for `rbac:check`'s own.
 */

/** One page-identity target string, in a single consistent format every wiki audit entry (`authorized-store.ts`, `index.ts`) uses.
 *
 *  - Both `id` and `namespaceId`/`slug` known: `"wiki:page:<id>"` — the
 *    stable surrogate key is always preferred once it exists.
 *  - Only `namespaceId`/`slug` known (e.g. a `createPage` permission check,
 *    before the row — and its `id` — exists yet): `"wiki:page:<namespaceId>/<slug>"`.
 *  - Only `namespaceId` known (e.g. `listPages`/`search` with no single
 *    page in view): `"wiki:namespace:<namespaceId>"`.
 *  - Nothing known at all (e.g. `listPages()` across every namespace):
 *    the bare global resource, `"wiki"`.
 */
export function wikiAuditTarget(id?: number, namespaceId?: string, slug?: string): string {
  if (id !== undefined) {
    return `wiki:page:${id}`;
  }
  if (namespaceId !== undefined && slug !== undefined) {
    return `wiki:page:${namespaceId}/${slug}`;
  }
  if (namespaceId !== undefined) {
    return `wiki:namespace:${namespaceId}`;
  }
  return WIKI_RESOURCE;
}

/** Shape of one entry {@link recordWikiAudit} accepts — mirrors `core/audit.ts`'s `AuditEvent`, minus `timestamp` (stamped here, at record time, matching `rbac/index.ts`'s own `recordCheckDecision` precedent). */
export interface WikiAuditEventInput {
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly outcome: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Record one wiki-specific audit entry to `auditSink`, if one is wired —
 * a no-op otherwise (e.g. a unit test that builds an `AuthorizedWikiStore`
 * with no sink at all), exactly like `rbac/index.ts`'s own
 * `recordCheckDecision`. Every wiki mutation (`create`/`update`/`delete`)
 * and every permission denial is recorded in full — unlike `rbac:check`'s
 * own allow-sampling, there is no high-frequency "allowed" event to worry
 * about bounding here, since successful *reads* are deliberately never
 * recorded (see this feature's own step 1 wording — "create/update/delete/
 * permission-denied", not "every read").
 */
export function recordWikiAudit(
  auditSink: AuditSink | undefined,
  event: WikiAuditEventInput,
): void {
  if (!auditSink) {
    return;
  }
  auditSink.record({ ...event, timestamp: Date.now() });
}

/**
 * {@link assertWikiAccess}, plus recording a `"denied"` {@link
 * recordWikiAudit} entry (actor + page identity, per this feature's step 1)
 * on the way out whenever it throws — a 401 ({@link AuthenticationError},
 * no resolved caller identity at all) or a 403 ({@link AuthorizationError},
 * resolved-but-unauthorized) are both "permission-denied" for this
 * purpose. Recording happens *before* the error propagates, so a denial is
 * captured even though the caller never gets a return value back from this
 * assertion function. On success (no throw), nothing is recorded here —
 * successful reads stay silent (see {@link recordWikiAudit}'s docs); a
 * successful mutation's own `"created"`/`"updated"`/`"deleted"` entry is
 * recorded separately, by the caller, only after the underlying store call
 * itself has actually succeeded.
 */
export function assertWikiAccessAudited(
  auditSink: AuditSink | undefined,
  rbacCheck: RbacCheckCapability,
  userId: string | undefined,
  action: WikiAction,
  target: string,
  namespaceId?: string,
): asserts userId is string {
  try {
    assertWikiAccess(rbacCheck, userId, action, namespaceId);
  } catch (error) {
    recordWikiAudit(auditSink, {
      actor: userId ?? "anonymous",
      action: `wiki:${action}`,
      target,
      outcome: "denied",
      details: {
        kind: "wiki:permission-denied",
        ...(namespaceId !== undefined ? { namespaceId } : {}),
      },
    });
    throw error;
  }
}

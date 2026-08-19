/**
 * Wiki page slug parser/validator (feature #87, step 2 — "Enforce slug
 * format validation ... on create").
 *
 * A page slug is the final path segment of a page's URL
 * (`/wiki/<namespace>/<slug>`, per `migrations/0002_create_wiki_pages.ts`'s
 * own doc comment) and the value stored in `wiki_pages.slug`. This module
 * defines the one grammar every slug must satisfy before it is ever handed
 * to `pages.ts`'s `db:query`-backed store: lowercase-kebab-case, the exact
 * same `SEGMENT`-style grammar `rbac/src/permission.ts` uses for a single
 * `resource`/`action` segment (and `src/core/manifest.ts`'s
 * `CAPABILITY_PATTERN` uses for a capability segment) — a URL-safe,
 * unambiguous identifier with no uppercase, no whitespace, no leading/
 * trailing/doubled hyphens, and no path-separator characters that could be
 * confused with a namespace boundary.
 *
 * This is a plain, syntactic check with no database access — the exact same
 * "independent of feature #36's still-not-built authorization/duplicate-name
 * checks" split `rbac/src/store.ts`'s own doc comment draws between grammar
 * validity (checkable with no I/O) and business-rule validity (namespace
 * existence, duplicate-slug — both of which need a query, and both of which
 * `pages.ts` enforces itself, not this module).
 *
 * Kept as its own local grammar (not imported from `permission.ts` or
 * `manifest.ts`) for the same self-containment reason `permission.ts`'s own
 * `PERMISSION_PATTERN` doc comment gives: `docs/plugin-conventions.md`
 * section 5 forbids importing another plugin's internals, and this plugin
 * must not depend on kernel-internal regex constants drifting independently
 * either — duplicating the tiny pattern keeps this plugin fully
 * self-contained.
 */
import { ValidationError } from "../../../core/errors.js";
import { err, ok, type Result } from "../../../core/types.js";

/** A validated page slug. */
export type Slug = string;

/**
 * Lowercase-kebab-case: starts and ends with a letter or digit, single
 * hyphens between segments — identical shape to `rbac/src/permission.ts`'s
 * `SEGMENT`. No uppercase, no whitespace, no underscore, no `/`, no leading/
 * trailing/doubled hyphen.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Human-readable grammar description, reused in every validation error message. */
const SLUG_DESCRIPTION =
  'lowercase-kebab-case, letters/digits/single-hyphens only (e.g. "getting-started")';

/**
 * Test whether `input` is a syntactically valid slug, without producing a
 * parsed result or an error.
 */
export function isValidSlug(input: unknown): input is Slug {
  return typeof input === "string" && SLUG_PATTERN.test(input);
}

/**
 * Validate a page slug against the lowercase-kebab-case grammar. Never
 * throws: returns `Err<ValidationError>` (with the offending input attached
 * at `error.details.input`) on any violation — not a string, empty, too
 * long, uppercase characters, whitespace, or leading/trailing/double
 * hyphens.
 */
export function parseSlug(input: unknown): Result<Slug, ValidationError> {
  if (typeof input !== "string" || input.length === 0) {
    return err(
      new ValidationError(
        `Invalid slug: expected a non-empty string, got ${JSON.stringify(input)}`,
        {
          details: { input },
        },
      ),
    );
  }

  if (input.length > 255) {
    return err(
      new ValidationError(`Invalid slug "${input}": must be at most 255 characters long.`, {
        details: { input, length: input.length },
      }),
    );
  }

  if (!SLUG_PATTERN.test(input)) {
    return err(
      new ValidationError(`Invalid slug "${input}": must follow ${SLUG_DESCRIPTION}.`, {
        details: { input },
      }),
    );
  }

  return ok(input);
}

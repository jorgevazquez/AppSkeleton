/**
 * Permission-string parser/validator.
 *
 * RBAC permissions are written as `"resource:action"` strings (e.g.
 * `"wiki:read"`, `"user-profile:update"`) — the same `namespace:action`
 * grammar feature #15 documents (`docs/plugin-conventions.md`, not yet
 * written) for plugin capability strings, and the exact grammar already
 * enforced at runtime by `src/core/manifest.ts`'s `CAPABILITY_PATTERN`:
 * two lowercase-kebab-case segments separated by a single colon, each
 * segment starting with a letter. Reusing that grammar (rather than
 * inventing a parallel one) means an RBAC permission and a plugin
 * capability can be compared/reused without a translation step — e.g. the
 * rbac plugin's own manifest declares `rbac:check`/`rbac:manage`, which
 * are themselves valid permission strings under this parser.
 *
 * Wildcard permissions (e.g. `"wiki:*"`) are explicitly OUT of scope
 * here: feature #33 ("Policy evaluation engine") owns wildcard matching
 * and its precedence rules. This parser only accepts concrete, literal
 * `resource:action` strings — a `Permission`'s identity must always be
 * unambiguous.
 */
import { ValidationError } from "../../../core/errors.js";
import { err, ok, type Result } from "../../../core/types.js";
import type { Permission } from "./types.js";

/** A permission identifier in canonical `"resource:action"` string form. */
export type PermissionString = string;

/** The parsed, structured form of a valid permission string. */
export interface ParsedPermission {
  /** The resource segment (e.g. "wiki"). */
  readonly resource: string;
  /** The action segment (e.g. "read"). */
  readonly action: string;
}

/** Single lowercase-kebab-case segment: starts with a letter, digits allowed, single hyphens between parts. */
const SEGMENT = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";

/**
 * `resource:action`, each segment lowercase-kebab-case — identical grammar
 * to `src/core/manifest.ts`'s `CAPABILITY_PATTERN`, kept as its own
 * constant (rather than imported) so the rbac plugin stays self-contained
 * per spec.md's "no importing another plugin's internals directly — only
 * kernel-brokered capabilities" rule; `manifest.ts` is core kernel code,
 * not a plugin, so importing its pattern constant would be fine
 * mechanically, but duplicating the tiny regex keeps this module free of
 * any dependency on core internals that could drift independently.
 */
const PERMISSION_PATTERN = new RegExp(`^${SEGMENT}:${SEGMENT}$`);

/** Human-readable grammar description, reused in every validation error message. */
const PERMISSION_DESCRIPTION =
  '"resource:action" grammar, lowercase-kebab-case segments (e.g. "wiki:read")';

/**
 * Test whether `input` is a syntactically valid permission string, without
 * producing a parsed result or an error. Convenience wrapper around the
 * same grammar {@link parsePermissionString} enforces.
 */
export function isValidPermissionString(input: unknown): input is PermissionString {
  return typeof input === "string" && PERMISSION_PATTERN.test(input);
}

/**
 * Parse and validate a permission string against the `resource:action`
 * grammar. Never throws: returns `Err<ValidationError>` (with the
 * offending input attached at `error.details.input`) on any violation —
 * not a string, empty, wrong shape, extra/missing colon, uppercase
 * characters, leading/trailing/double hyphens, etc.
 */
export function parsePermissionString(input: unknown): Result<ParsedPermission, ValidationError> {
  if (typeof input !== "string" || input.length === 0) {
    return err(
      new ValidationError(
        `Invalid permission string: expected a non-empty string, got ${JSON.stringify(input)}`,
        { details: { input } },
      ),
    );
  }

  if (!PERMISSION_PATTERN.test(input)) {
    return err(
      new ValidationError(
        `Invalid permission string "${input}": must follow ${PERMISSION_DESCRIPTION}`,
        { details: { input } },
      ),
    );
  }

  const separatorIndex = input.indexOf(":");
  const resource = input.slice(0, separatorIndex);
  const action = input.slice(separatorIndex + 1);
  return ok({ resource, action });
}

/**
 * Build a full {@link Permission} record from a permission string,
 * validating it in the process — the only sanctioned way to construct a
 * `Permission`, so `id`/`resource`/`action` can never disagree with each
 * other (see types.ts).
 */
export function toPermission(
  id: PermissionString,
  description?: string,
): Result<Permission, ValidationError> {
  const parsed = parsePermissionString(id);
  if (!parsed.ok) {
    return parsed;
  }

  return ok(
    description === undefined
      ? { id, resource: parsed.value.resource, action: parsed.value.action }
      : { id, resource: parsed.value.resource, action: parsed.value.action, description },
  );
}

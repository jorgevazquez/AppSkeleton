/**
 * Plugin manifest schema (`plugin.json`) and validator.
 *
 * Every plugin under `src/plugins/*` ships a `plugin.json` describing it to
 * the kernel's registry/loader (see spec.md's "Plugin Manifest" section):
 *
 *   - `id`           — stable plugin identifier, lowercase-kebab-case,
 *                      matching its directory name (e.g. "database-mysql").
 *   - `version`      — the plugin's own semver version (e.g. "1.2.3").
 *   - `depends_on`   — a map of other plugin ids to the semver *range* of
 *                      that plugin's version this plugin is compatible with
 *                      (e.g. `{ "rbac": "^1.0.0" }`), mirroring npm's
 *                      `package.json#dependencies` convention.
 *   - `capabilities` — `{ provides, requires }`, each a list of capability
 *                      strings following the kernel's `namespace:action`
 *                      grammar (e.g. "db:query", "http:route",
 *                      "render:template", "rbac:check" — see spec.md).
 *                      `requires` is the ceiling of what the plugin may
 *                      ever be granted at runtime; `provides` lists the
 *                      extension points other plugins may hook into.
 *   - `entry_point`  — relative path to the plugin's lifecycle entry
 *                      module (e.g. "index.ts").
 *
 * `validateManifest()` never throws: it returns a {@link Result} so callers
 * (the plugin loader, `create-plugin` scaffolding, CI linting) are forced
 * to handle the failure case explicitly, per types.ts's documented intent
 * that manifest validation is exactly this kind of expected, recoverable
 * failure. Every violation in the input — not just the first — is
 * collected and returned as a typed {@link ManifestValidationIssue}.
 */
import semver from "semver";
import { z } from "zod";
import { ValidationError } from "./errors.js";
import { err, ok, type Result } from "./types.js";

/**
 * Lowercase-kebab-case: starts with a letter, digits allowed, single hyphens
 * between segments. Exported (not just used internally) so it is the single
 * source of truth other code — and `docs/plugin-conventions.md` via the test
 * that checks it, see `tests/core/plugin-conventions.test.ts` — can check
 * itself against, rather than a second, hand-copied regex silently drifting
 * from this one.
 */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const PLUGIN_ID_DESCRIPTION = 'lowercase-kebab-case (e.g. "database-mysql")';

/**
 * `namespace:action` (equivalently "resource:action" — see spec.md's rbac
 * section, which uses that name for the same grammar), each segment
 * lowercase-kebab-case — e.g. "db:query", "http:route". Exported for the
 * same doc-drift-prevention reason as {@link PLUGIN_ID_PATTERN} above; this
 * is the pattern `docs/plugin-conventions.md` documents and
 * `tests/core/plugin-conventions.test.ts` asserts the doc's copy matches
 * exactly.
 */
export const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*:[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const CAPABILITY_DESCRIPTION =
  '"namespace:action" grammar, lowercase-kebab-case segments (e.g. "db:query")';

/**
 * Relative path (no leading "/", no ".." traversal) ending in a JS/TS module
 * extension. Exported for the same doc-drift-prevention reason as
 * {@link PLUGIN_ID_PATTERN} above.
 */
export const ENTRY_POINT_PATTERN = /^(?!\/)(?!.*\.\.(?:\/|$))[A-Za-z0-9_./-]+\.(?:ts|js|mjs|cjs)$/;
export const ENTRY_POINT_DESCRIPTION =
  'a relative path with no leading "/" and no ".." segments, ending in .ts/.js/.mjs/.cjs (e.g. "index.ts")';

/**
 * The canonical SemVer 2.0.0 grammar, as published at https://semver.org — deliberately
 * matched by regex rather than delegated to `semver.valid()` (which is a *loose* parser by
 * design: it strips a leading "v" and silently drops build metadata from its "cleaned"
 * output), so a `version` field is only accepted in the exact, canonical form the spec
 * defines: no "v" prefix, optional prerelease, optional preserved build metadata.
 */
const SEMVER_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const PluginIdSchema = z
  .string()
  .min(1, "id is required")
  .regex(PLUGIN_ID_PATTERN, `id must be ${PLUGIN_ID_DESCRIPTION}`);

const SemverVersionSchema = z
  .string()
  .min(1, "version is required")
  .regex(SEMVER_VERSION_PATTERN, 'version must be a valid semver version (e.g. "1.2.3")');

const SemverRangeSchema = z
  .string()
  .min(1, "dependency range is required")
  .refine((value) => semver.validRange(value) !== null, {
    message:
      'dependency range must be a valid semver range (e.g. "^1.2.3", "~1.2.0", ">=1.0.0 <2.0.0")',
  });

const CapabilitySchema = z
  .string()
  .min(1, "capability is required")
  .regex(CAPABILITY_PATTERN, `capability must follow ${CAPABILITY_DESCRIPTION}`);

const EntryPointSchema = z
  .string()
  .min(1, "entry_point is required")
  .regex(ENTRY_POINT_PATTERN, `entry_point must be ${ENTRY_POINT_DESCRIPTION}`);

/** Machine-readable code for the custom (non-built-in-zod) manifest issues. */
const DUPLICATE_CAPABILITY_CODE = "duplicate_capability";

/** Flag repeated entries within a single capability list (provides or requires). */
function rejectDuplicateCapabilities(
  capabilities: string[],
  field: "provides" | "requires",
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  capabilities.forEach((capability, index) => {
    if (seen.has(capability)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field, index],
        message: `duplicate capability "${capability}" in capabilities.${field}`,
        params: { code: DUPLICATE_CAPABILITY_CODE },
      });
      return;
    }
    seen.add(capability);
  });
}

const CapabilitiesSchema = z
  .object({
    provides: z.array(CapabilitySchema).default([]),
    requires: z.array(CapabilitySchema).default([]),
  })
  .strict()
  .superRefine((capabilities, ctx) => {
    rejectDuplicateCapabilities(capabilities.provides, "provides", ctx);
    rejectDuplicateCapabilities(capabilities.requires, "requires", ctx);
  });

const DependsOnSchema = z.record(PluginIdSchema, SemverRangeSchema).default({});

/**
 * Zod schema for a plugin's `plugin.json` manifest. `.strict()` at every
 * object level rejects unknown fields outright — a typo, or a field from a
 * future manifest version, must fail loudly rather than being silently
 * ignored by an older kernel.
 */
export const PluginManifestSchema = z
  .object({
    id: PluginIdSchema,
    version: SemverVersionSchema,
    depends_on: DependsOnSchema,
    capabilities: CapabilitiesSchema.default({ provides: [], requires: [] }),
    entry_point: EntryPointSchema,
  })
  .strict();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** A single, typed manifest validation violation. */
export interface ManifestValidationIssue {
  /** Dot/bracket path to the offending field, e.g. "capabilities.provides[1]", or "(root)". */
  path: string;
  /** Machine-readable issue code: zod's own issue code, or a manifest-specific one. */
  code: string;
  /** Human-readable description of the violation. */
  message: string;
}

function formatIssuePath(path: (string | number)[]): string {
  if (path.length === 0) {
    return "(root)";
  }
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") {
      return `${acc}[${segment}]`;
    }
    return acc === "" ? segment : `${acc}.${segment}`;
  }, "");
}

function toIssueCode(issue: z.ZodIssue): string {
  if (issue.code === z.ZodIssueCode.custom) {
    const params = issue.params as Record<string, unknown> | undefined;
    const customCode = params?.["code"];
    if (typeof customCode === "string") {
      return customCode;
    }
  }
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return "unknown_field";
  }
  return issue.code;
}

function toManifestValidationIssue(issue: z.ZodIssue): ManifestValidationIssue {
  return {
    path: formatIssuePath(issue.path),
    code: toIssueCode(issue),
    message: issue.message,
  };
}

/**
 * Validate an unknown value as a plugin manifest. Never throws: on failure,
 * every violation found in `input` (zod's `safeParse` does not short-circuit
 * on the first issue) is collected into a typed {@link ManifestValidationIssue}
 * list and returned as `Err<ValidationError>`, with the full list attached
 * at `error.details.issues` — matching errors.ts's split between the
 * internal `message` (every violation, safe to log) and the generic
 * `publicMessage` (never leaks manifest content to an API caller).
 */
export function validateManifest(input: unknown): Result<PluginManifest, ValidationError> {
  const result = PluginManifestSchema.safeParse(input);
  if (result.success) {
    return ok(result.data);
  }

  const issues = result.error.issues.map(toManifestValidationIssue);
  const summary = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");

  return err(
    new ValidationError(`Invalid plugin manifest: ${summary}`, {
      details: { issues },
      cause: result.error,
    }),
  );
}

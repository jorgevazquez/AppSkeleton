/**
 * Shared plugin-manifest fixtures. Both `tests/core/manifest.test.ts`
 * (feature #4's `validateManifest()`) and
 * `tests/plugins/plugin-builder/manifest-schema.test.ts` (feature #74's
 * published JSON Schema) run against this one fixture list, so feature
 * #74's "validates the same fixtures the kernel validator does" is
 * literally true — not a second, hand-copied fixture list that could
 * silently drift from the first.
 */

/** A valid manifest, with any fields overridden — mirrors a real `plugin.json`. */
export function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "database-mysql",
    version: "1.2.3",
    depends_on: { rbac: "^1.0.0" },
    capabilities: {
      provides: ["db:query", "db:transaction"],
      requires: ["config:read"],
    },
    entry_point: "index.ts",
    ...overrides,
  };
}

export interface ManifestFixture {
  /** Human-readable label — doubles as the vitest case name. */
  readonly description: string;
  readonly input: unknown;
  /** Whether `validateManifest()` should accept this input. */
  readonly valid: boolean;
  /**
   * `false` only for the fixture whose rejection depends on the `semver`
   * package's `validRange()` (a malformed semver *range*, not a malformed
   * version) — that check has no static JSON Schema equivalent, so the
   * published schema is intentionally more permissive there. See
   * `src/plugins/plugin-builder/src/manifest-json-schema.ts`'s docs.
   * Every other fixture must produce the *same* valid/invalid verdict from
   * both the kernel validator and the exported JSON Schema. Defaults to
   * `true`.
   */
  readonly schemaParity?: boolean;
}

function missingField(field: string): Record<string, unknown> {
  const manifest = validManifest();
  delete manifest[field];
  return manifest;
}

export const MANIFEST_FIXTURES: readonly ManifestFixture[] = [
  // ---- valid ----
  { description: "fully populated manifest", input: validManifest(), valid: true },
  {
    description: "minimal manifest, defaulting depends_on and capabilities",
    input: { id: "wiki", version: "0.1.0", entry_point: "index.ts" },
    valid: true,
  },
  {
    description: "plugin id with multiple hyphenated segments and digits",
    input: validManifest({ id: "plugin-builder-v2" }),
    valid: true,
  },
  {
    description: "prerelease and build-metadata semver version",
    input: validManifest({ version: "2.0.0-beta.1+build.5" }),
    valid: true,
  },
  {
    description: "a variety of valid semver ranges in depends_on",
    input: validManifest({
      depends_on: {
        rbac: "^1.0.0",
        "database-mysql": "~2.3.1",
        "html-renderer": ">=1.0.0 <3.0.0",
        "api-gateway": "1.x",
        wiki: "*",
      },
    }),
    valid: true,
  },
  {
    description: "entry_point nested under a subdirectory",
    input: validManifest({ entry_point: "src/index.ts" }),
    valid: true,
  },
  {
    description: "empty provides/requires arrays",
    input: validManifest({ capabilities: { provides: [], requires: [] } }),
    valid: true,
  },
  {
    description: "same capability once in provides and once in requires (not a duplicate)",
    input: validManifest({ capabilities: { provides: ["rbac:check"], requires: ["rbac:check"] } }),
    valid: true,
  },

  // ---- invalid: bad semver version ----
  ...["1.2", "not-a-version", "1.2.3.4", "v1.2.3", ""].map((version) => ({
    description: `bad semver version (${JSON.stringify(version)})`,
    input: validManifest({ version }),
    valid: false,
  })),

  // ---- invalid: missing id ----
  { description: "manifest with no id field", input: missingField("id"), valid: false },
  { description: "empty-string id", input: validManifest({ id: "" }), valid: false },

  // ---- invalid: duplicate capability ----
  {
    description: "duplicate entry within capabilities.provides",
    input: validManifest({ capabilities: { provides: ["db:query", "db:query"], requires: [] } }),
    valid: false,
  },
  {
    description: "duplicate entry within capabilities.requires",
    input: validManifest({
      capabilities: { provides: [], requires: ["config:read", "config:read"] },
    }),
    valid: false,
  },

  // ---- invalid: malformed capability grammar ----
  ...[
    "dbquery", // no colon
    "db:", // empty action segment
    ":query", // empty namespace segment
    "db::query", // double colon
    "db:query:extra", // too many segments
    "DB:QUERY", // must be lowercase
    "db query", // space instead of colon
  ].map((capability) => ({
    description: `malformed capability grammar (${JSON.stringify(capability)})`,
    input: validManifest({ capabilities: { provides: [capability], requires: [] } }),
    valid: false,
  })),

  // ---- invalid: unknown field ----
  {
    description: "unrecognized top-level field",
    input: validManifest({ unexpectedField: "surprise" }),
    valid: false,
  },
  {
    description: "unrecognized field nested under capabilities",
    input: validManifest({ capabilities: { provides: [], requires: [], extra: true } }),
    valid: false,
  },

  // ---- invalid: additional variants ----
  {
    description: "malformed semver range in depends_on",
    input: validManifest({ depends_on: { rbac: "not-a-range" } }),
    valid: false,
    schemaParity: false,
  },
  {
    description: "plugin id with uppercase letters",
    input: validManifest({ id: "Database-Mysql" }),
    valid: false,
  },
  {
    description: "plugin id with underscores",
    input: validManifest({ id: "database_mysql" }),
    valid: false,
  },
  {
    description: "absolute entry_point path",
    input: validManifest({ entry_point: "/etc/passwd.ts" }),
    valid: false,
  },
  {
    description: "directory-traversal entry_point path",
    input: validManifest({ entry_point: "../../etc/passwd.ts" }),
    valid: false,
  },
  {
    description: "entry_point with an unsupported extension",
    input: validManifest({ entry_point: "index.py" }),
    valid: false,
  },
  { description: "non-object input", input: "not a manifest", valid: false },
  {
    description: "manifest missing entry_point",
    input: missingField("entry_point"),
    valid: false,
  },
];

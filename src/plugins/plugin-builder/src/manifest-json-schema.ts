/**
 * JSON Schema export of the kernel's plugin manifest zod schema (feature
 * #74 — "Publish the plugin.json JSON Schema for external/programmatic
 * reuse"). The manifest *shape* is defined exactly once, in
 * `src/core/manifest.ts`'s `PluginManifestSchema` (feature #4) — this
 * module never redeclares a field, pattern, or required list by hand; it
 * mechanically derives a standalone JSON Schema (draft-07) from that same
 * zod schema via `zod-to-json-schema`, so the published document cannot
 * silently drift from what the kernel's own `validateManifest()` actually
 * enforces. `tests/plugins/plugin-builder/manifest-schema.test.ts` fails
 * the moment the checked-in `schemas/plugin-manifest.schema.json` stops
 * matching what {@link generatePluginManifestJsonSchema} produces right
 * now, catching exactly that drift.
 *
 * Two pieces of manifest.ts's validation logic are not expressible as
 * static JSON Schema, and are handled deliberately rather than silently
 * dropped or approximated with a second, hand-written regex (which would
 * itself become the kind of hand-duplicated source of truth this feature
 * exists to avoid):
 *
 *   - `capabilities.provides` / `capabilities.requires` duplicate-entry
 *     rejection (manifest.ts's `rejectDuplicateCapabilities`, applied via
 *     `.superRefine()`) *is* exactly representable as JSON Schema's
 *     `uniqueItems: true` — both mean "no two array entries are equal" —
 *     so {@link withUniqueCapabilityLists} adds it below.
 *   - `depends_on`'s values (semver *ranges*, e.g. "^1.2.3") are validated
 *     by manifest.ts via the `semver` npm package's `semver.validRange()`
 *     (`SemverRangeSchema`'s `.refine()`), not a regex. Full semver-range
 *     grammar (comparator sets, "||", x-ranges, hyphen ranges, ...) has no
 *     static JSON Schema equivalent, so the exported schema only requires
 *     a non-empty string there. A consumer wanting full-fidelity
 *     `depends_on` validation must still run the value through an actual
 *     semver-range parser — this document is a *shape*-level contract, not
 *     a re-implementation of the kernel validator. (See
 *     `tests/fixtures/plugin-manifests.ts`'s `schemaParity: false` fixture
 *     for the one case this affects.)
 */
import { zodToJsonSchema } from "zod-to-json-schema";
import { PluginManifestSchema } from "../../../core/manifest.js";

/** Stable `$id` for the published document, so external consumers can pin to it. */
export const PLUGIN_MANIFEST_JSON_SCHEMA_ID =
  "https://appskeleton.dev/schemas/plugin-manifest.schema.json";

/** Loosely-typed JSON Schema node — just enough structure to reach into `properties`. */
type JsonSchemaNode = Record<string, unknown>;

/**
 * The two array fields whose kernel-side "no duplicate entries" rule
 * (superRefine, see manifest.ts) maps exactly onto JSON Schema's
 * `uniqueItems` keyword.
 */
const CAPABILITY_LIST_FIELDS = ["provides", "requires"] as const;

/** Mutates `schema` in place, adding `uniqueItems: true` to the capability list fields. */
function withUniqueCapabilityLists(schema: JsonSchemaNode): JsonSchemaNode {
  const properties = schema["properties"] as Record<string, JsonSchemaNode> | undefined;
  const capabilities = properties?.["capabilities"] as JsonSchemaNode | undefined;
  const capabilityProperties = capabilities?.["properties"] as
    Record<string, JsonSchemaNode> | undefined;

  for (const field of CAPABILITY_LIST_FIELDS) {
    const listSchema = capabilityProperties?.[field];
    if (listSchema) {
      listSchema["uniqueItems"] = true;
    }
  }

  return schema;
}

/**
 * Generate the standalone JSON Schema document for a plugin's `plugin.json`,
 * straight from `PluginManifestSchema` (src/core/manifest.ts — the single
 * source of truth, feature #4). Deterministic: two calls produce deep-equal
 * output, which is what lets the drift test above compare the checked-in
 * file against a fresh call.
 */
export function generatePluginManifestJsonSchema(): JsonSchemaNode {
  const schema = withUniqueCapabilityLists(
    zodToJsonSchema(PluginManifestSchema, {
      $refStrategy: "none",
      target: "jsonSchema7",
    }) as JsonSchemaNode,
  );

  return {
    ...schema,
    $id: PLUGIN_MANIFEST_JSON_SCHEMA_ID,
    title: "AppSkeleton plugin manifest (plugin.json)",
    description:
      "Shape-level JSON Schema for a plugin's plugin.json, generated from the kernel's zod " +
      "PluginManifestSchema (src/core/manifest.ts, feature #4) via zod-to-json-schema — see " +
      "src/plugins/plugin-builder/src/manifest-json-schema.ts for how, and its documented " +
      "limitation: depends_on values accept any non-empty string, since full semver-range " +
      "validation has no static JSON Schema equivalent and is not re-implemented here. Treat " +
      "this document as a shape-level contract; validateManifest() in the kernel remains " +
      "authoritative.",
  };
}

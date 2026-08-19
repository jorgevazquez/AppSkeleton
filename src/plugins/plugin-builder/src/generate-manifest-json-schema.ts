#!/usr/bin/env -S npx tsx
/**
 * Regenerates `schemas/plugin-manifest.schema.json` from the kernel's
 * `PluginManifestSchema` (see manifest-json-schema.ts's docs — feature #74).
 * Run via `npm run generate:manifest-schema` any time
 * `src/core/manifest.ts`'s manifest shape changes;
 * `tests/plugins/plugin-builder/manifest-schema.test.ts` fails the build if
 * the checked-in file ever drifts from what this script would produce, so
 * the exported schema can never go stale silently.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePluginManifestJsonSchema } from "./manifest-json-schema.js";

/** Where the generated document lives, relative to this file — not to `cwd`. */
export const MANIFEST_JSON_SCHEMA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "schemas",
  "plugin-manifest.schema.json",
);

/**
 * The exact file contents `MANIFEST_JSON_SCHEMA_PATH` should hold right
 * now: pretty-printed, trailing newline. Exported so the drift test can
 * compare it against the checked-in file without re-deriving the
 * formatting rules itself.
 */
export function renderManifestJsonSchema(): string {
  return `${JSON.stringify(generatePluginManifestJsonSchema(), null, 2)}\n`;
}

async function main(): Promise<void> {
  await writeFile(MANIFEST_JSON_SCHEMA_PATH, renderManifestJsonSchema(), "utf-8");
  console.log(`Wrote ${MANIFEST_JSON_SCHEMA_PATH}`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((cause: unknown) => {
    console.error("Failed to generate the plugin manifest JSON Schema:", cause);
    process.exit(1);
  });
}

/**
 * Capability index doc generator (feature #82 — "Capability index doc
 * generator (which plugin provides/consumes what)"). Scans every shipped
 * plugin's `plugin.json` (feature #17/#31/#45/#57's manifests, and every
 * other plugin under `src/plugins/*`) and emits a single Markdown document,
 * `docs/capability-index.md`, describing:
 *
 *   1. Per-plugin: which capabilities it `provides` and which it `requires`.
 *   2. Per-capability: which plugin(s) provide it and which consume it — the
 *      cross-index a per-plugin table alone can't answer at a glance ("who
 *      provides `db:query`?").
 *
 * This mirrors `generate-manifest-json-schema.ts` (feature #74)'s shape
 * exactly, on purpose: derive a document mechanically from the single
 * source of truth (each plugin's own `plugin.json`, validated by the same
 * `validateManifest()` the kernel loader and conventions linter already
 * trust — see `core/manifest.ts` / `core/registry.ts`), expose a pure
 * `render*()` function the checked-in file must equal *right now*, and let
 * `tests/plugins/plugin-builder/capability-index.test.ts` fail the build
 * the moment the two drift — the same "regenerate and diff" mechanism
 * feature #74 established, wired into CI via `npm test`
 * (`.github/workflows/ci.yml`'s "Unit + integration tests" step already
 * runs every `*.test.ts`, this one included).
 *
 * Run `npm run generate:capability-index` any time a plugin's
 * `capabilities.provides`/`requires` changes.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ValidationError } from "../../../core/errors.js";
import { validateManifest, type PluginManifest } from "../../../core/manifest.js";
import { scanPluginDirectories } from "../../../core/registry.js";
import { isErr } from "../../../core/types.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** `src/plugins/plugin-builder/src` -> repo root. */
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..", "..", "..");

/** This repo's real plugin-owned-files root — same default `generate-plugin.ts` (feature #75) uses. */
export const DEFAULT_PLUGINS_ROOT = path.join(REPO_ROOT, "src", "plugins");

/** Where the generated document lives, relative to this file — not to `cwd`. */
export const CAPABILITY_INDEX_DOC_PATH = path.join(REPO_ROOT, "docs", "capability-index.md");

/** One shipped plugin's id plus its declared capability lists, ready for rendering. */
export interface CapabilityIndexEntry {
  /** The plugin's directory name / manifest `id` (the two are enforced equal — see conventions-linter.ts's `id_directory_mismatch` check). */
  readonly pluginId: string;
  readonly provides: readonly string[];
  readonly requires: readonly string[];
}

/**
 * Scan `pluginsRoot` (default: this repo's real `src/plugins`) and return
 * one {@link CapabilityIndexEntry} per plugin directory, sorted by plugin
 * id. Every manifest is run through the kernel's own
 * {@link validateManifest} — the same validator the loader and conventions
 * linter trust — so this document can never describe a plugin whose
 * `plugin.json` the kernel would actually reject. A missing/malformed/
 * invalid manifest throws rather than silently skipping the plugin: unlike
 * `scanPluginDirectories`'s own graceful-degradation default (a broken
 * plugin must not crash the *kernel*), a generator whose whole job is
 * documenting "every shipped plugin's declared capabilities" must never
 * quietly omit one — an omission here would be a doc that looks complete
 * but isn't, exactly the silent-drift failure mode this feature exists to
 * prevent.
 */
export async function collectCapabilityIndexEntries(
  pluginsRoot: string = DEFAULT_PLUGINS_ROOT,
): Promise<CapabilityIndexEntry[]> {
  const { entries, skipped } = await scanPluginDirectories(pluginsRoot);

  if (skipped.length > 0) {
    const summary = skipped.map((skip) => `"${skip.name}" (${skip.reason})`).join(", ");
    throw new Error(
      `Cannot build the capability index: ${skipped.length} director${skipped.length === 1 ? "y" : "ies"} ` +
        `under "${pluginsRoot}" could not be scanned: ${summary}.`,
    );
  }

  const results: CapabilityIndexEntry[] = [];
  for (const entry of entries) {
    const validated = validateManifest(entry.manifest);
    if (isErr(validated)) {
      throw new ValidationError(
        `Cannot build the capability index: "${entry.name}"'s plugin.json failed validation: ${validated.error.message}`,
        { cause: validated.error },
      );
    }
    const manifest: PluginManifest = validated.value;
    results.push({
      pluginId: manifest.id,
      provides: manifest.capabilities.provides,
      requires: manifest.capabilities.requires,
    });
  }

  return results.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}

/** Render a Markdown table cell for a capability list: backtick-quoted, comma-separated, or an italic placeholder when empty. */
function formatCapabilityCell(capabilities: readonly string[]): string {
  if (capabilities.length === 0) {
    return "_(none)_";
  }
  return capabilities.map((capability) => `\`${capability}\``).join(", ");
}

/** Every distinct capability id named by any entry's `provides` or `requires`, sorted. */
function collectCapabilityIds(entries: readonly CapabilityIndexEntry[]): string[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    for (const capability of entry.provides) {
      ids.add(capability);
    }
    for (const capability of entry.requires) {
      ids.add(capability);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function renderPerPluginTable(entries: readonly CapabilityIndexEntry[]): string {
  const header = "| Plugin | Provides | Requires |\n| --- | --- | --- |";
  const rows = entries.map(
    (entry) =>
      `| \`${entry.pluginId}\` | ${formatCapabilityCell(entry.provides)} | ${formatCapabilityCell(entry.requires)} |`,
  );
  return [header, ...rows].join("\n");
}

function renderCapabilityCrossIndexTable(entries: readonly CapabilityIndexEntry[]): string {
  const capabilityIds = collectCapabilityIds(entries);
  const header = "| Capability | Provided by | Required by |\n| --- | --- | --- |";

  const rows = capabilityIds.map((capabilityId) => {
    const providers = entries
      .filter((entry) => entry.provides.includes(capabilityId))
      .map((entry) => `\`${entry.pluginId}\``);
    const consumers = entries
      .filter((entry) => entry.requires.includes(capabilityId))
      .map((entry) => `\`${entry.pluginId}\``);
    return (
      `| \`${capabilityId}\` | ${providers.length > 0 ? providers.join(", ") : "_(none)_"} | ` +
      `${consumers.length > 0 ? consumers.join(", ") : "_(none)_"} |`
    );
  });

  if (rows.length === 0) {
    return `${header}\n| _(no capabilities declared)_ | | |`;
  }
  return [header, ...rows].join("\n");
}

/**
 * The exact file contents {@link CAPABILITY_INDEX_DOC_PATH} should hold
 * right now, given `entries` — pure formatting, no I/O, so
 * `capability-index.test.ts` can assert "every shipped plugin's declared
 * capabilities" appear without touching the filesystem twice.
 */
export function renderCapabilityIndexDoc(entries: readonly CapabilityIndexEntry[]): string {
  return `${[
    "# Capability index",
    "",
    "**Generated — do not hand-edit.** Run `npm run generate:capability-index` after changing " +
      "any plugin's `capabilities.provides`/`capabilities.requires` (see " +
      "`src/plugins/plugin-builder/src/generate-capability-index.ts`, feature #82). " +
      "`tests/plugins/plugin-builder/capability-index.test.ts` fails the build if this file " +
      "ever drifts from what that script would produce.",
    "",
    "## By plugin",
    "",
    renderPerPluginTable(entries),
    "",
    "## By capability",
    "",
    renderCapabilityCrossIndexTable(entries),
    "",
  ].join("\n")}`;
}

/** Scan `pluginsRoot` and render the capability index document in one call — what `main()` writes to disk. */
export async function generateCapabilityIndexDoc(
  pluginsRoot: string = DEFAULT_PLUGINS_ROOT,
): Promise<string> {
  const entries = await collectCapabilityIndexEntries(pluginsRoot);
  return renderCapabilityIndexDoc(entries);
}

async function main(): Promise<void> {
  const rendered = await generateCapabilityIndexDoc();
  await writeFile(CAPABILITY_INDEX_DOC_PATH, rendered, "utf-8");
  console.log(`Wrote ${CAPABILITY_INDEX_DOC_PATH}`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((cause: unknown) => {
    console.error("Failed to generate the capability index:", cause);
    process.exit(1);
  });
}

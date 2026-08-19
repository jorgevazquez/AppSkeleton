/**
 * Pure, side-effect-free template renderers for `create-plugin` (feature
 * #75 — "create-plugin generator: scaffolds manifest, lifecycle stubs,
 * src/, tests/"). Every function here takes a validated plugin id (and,
 * where relevant, a human-readable description) and returns a file's exact
 * string contents; none of them touch the filesystem — that is
 * `generate-plugin.ts`'s job, kept separate so the templates themselves can
 * be unit-tested (and re-rendered/diffed) without any I/O.
 *
 * Every shape produced here follows `docs/ai-plugin-authoring.md` — in
 * particular §2 (explicit-empty `depends_on`/`capabilities`, `"index.ts"`
 * entry point), §4 (all four lifecycle hooks, each optional but included
 * here as stubs), and §6.2 (the manifest-discoverability test, copied
 * verbatim with `<id>` substituted). The manifest shape itself is never
 * hand-duplicated beyond the five field names the schema requires — the
 * *values* rendered here are exactly what `src/core/manifest.ts`'s
 * `PluginManifestSchema` accepts, and `generate-plugin.ts` re-validates the
 * rendered manifest through the kernel's own `validateManifest()` before
 * ever writing it to disk, so this template cannot silently drift from the
 * validator it targets.
 */
import type { PluginManifest } from "../../../core/manifest.js";

/**
 * The capability ids a freshly scaffolded plugin should declare upfront —
 * both fields optional (each defaults to `[]`, the same "explicit-empty"
 * shape `docs/ai-plugin-authoring.md` §2 requires). Feature #76's CLI
 * collects these via `--provides`/`--requires` flags (or an interactive
 * prompt) and passes them straight through; validity (the
 * `CAPABILITY_PATTERN` grammar, no duplicates) is not re-checked here —
 * `generatePlugin` re-validates the whole rendered manifest through the
 * kernel's own `validateManifest()` before writing anything, so a bad
 * capability string is caught there rather than duplicated as a second
 * check in this template.
 */
export interface PluginCapabilitiesInput {
  provides?: string[];
  requires?: string[];
}

/** The `plugin.json` this generator emits for a freshly scaffolded plugin, before validation. */
export function buildPluginManifest(
  id: string,
  capabilities?: PluginCapabilitiesInput,
): PluginManifest {
  return {
    id,
    version: "0.1.0",
    depends_on: {},
    capabilities: {
      provides: capabilities?.provides ?? [],
      requires: capabilities?.requires ?? [],
    },
    entry_point: "index.ts",
  };
}

/** Pretty-printed `plugin.json` file contents (trailing newline, matching every shipped plugin's file). */
export function renderPluginManifestJson(manifest: PluginManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * A `description` is only ever embedded in prose (this doc comment, the
 * generated README) — `plugin.json` has no `description` field (the schema
 * is `.strict()`, see manifest.ts's docs and
 * `docs/ai-plugin-authoring.md` §2's explicit warning not to add one).
 * Escape the one sequence that could break out of a `/** ... *‍/` block
 * comment or terminate Markdown prose unexpectedly, so an arbitrary
 * caller-supplied description can never corrupt the generated file's
 * syntax.
 */
function sanitizeProse(description: string): string {
  return description.trim().replace(/\*\//g, "*​/");
}

/**
 * `src/plugins/<id>/index.ts` — the module named by the manifest's
 * `entry_point`. Exports all four lifecycle hooks (`docs/ai-plugin-
 * authoring.md` §4) as stubs — every one is optional per the
 * `PluginModule` interface (`src/core/loader.ts`), but a freshly scaffolded
 * plugin ships all four so an author sees exactly where each kind of setup
 * belongs, and deletes what it doesn't need — plus an empty `provides`,
 * ready for this plugin's first capability.
 */
export function renderPluginIndexTs(id: string, description: string): string {
  const safeDescription = sanitizeProse(description);
  return `/**
 * ${id} plugin lifecycle module.
 *
 * ${safeDescription}
 *
 * Scaffolded by the plugin-builder \`create-plugin\` generator (feature
 * #75) — see docs/ai-plugin-authoring.md for the full manifest/lifecycle/
 * capability contract this stub follows. Every hook below is optional
 * (\`PluginModule\`, src/core/loader.ts) and currently only logs — replace
 * each stub with real setup/teardown as this plugin grows, and delete any
 * hook you end up not needing.
 */
import type { PluginLifecycleContext } from "../../core/loader.js";

/**
 * Runs first, synchronously (or returning a Promise the loader awaits).
 * Use for fail-fast setup — reading/validating config, wiring
 * \`context.auditSink\` into local state — that should abort the load
 * loudly if misconfigured. See docs/ai-plugin-authoring.md §4.
 */
export function onInstall(context: PluginLifecycleContext): void {
  context.logger.info({ plugin: context.manifest.id }, "${id} installed");
}

/**
 * Runs second, after \`onInstall\`. Use for anything asynchronous: opening
 * a connection, running this plugin's own migrations, obtaining a
 * capability it requires at startup.
 */
export function onEnable(context: PluginLifecycleContext): void {
  context.logger.info({ plugin: context.manifest.id }, "${id} enabled");
}

/**
 * Runs on teardown (\`kernel.disablePlugin(...)\` or process shutdown),
 * before \`onUninstall\`. Release exactly what \`onEnable\` acquired.
 */
export function onDisable(context: PluginLifecycleContext): void {
  context.logger.info({ plugin: context.manifest.id }, "${id} disabled");
}

/** Runs last, after \`onDisable\`. */
export function onUninstall(context: PluginLifecycleContext): void {
  context.logger.info({ plugin: context.manifest.id }, "${id} uninstalled");
}

/**
 * Capability implementations this plugin provides, keyed by capability id
 * (must match \`plugin.json\`'s \`capabilities.provides\` — see
 * docs/ai-plugin-authoring.md §5). Empty until this plugin declares and
 * implements its first capability; build entries at module scope unless
 * constructing one genuinely needs something only available inside a
 * lifecycle hook (docs/ai-plugin-authoring.md §4's \`provides\` guidance).
 */
export const provides: Readonly<Record<string, unknown>> = {};
`;
}

/**
 * `src/plugins/<id>/README.md`. Every shipped plugin in this repo has one
 * (`docs/ai-plugin-authoring.md` §3); this is the same "deliberately empty
 * at scaffold time" boilerplate every hand-scaffolded plugin in this repo
 * (rbac, database-mysql, html-renderer, api-gateway, wiki, plugin-builder
 * itself) already carries, so a generated plugin reads identically to one
 * scaffolded by hand.
 */
export function renderPluginReadme(id: string, description: string): string {
  const safeDescription = sanitizeProse(description);
  return `# ${id} plugin

${safeDescription}

Deliberately empty at scaffold time — built out by its entries in
\`feature_list.json\`. Must be a self-contained plugin: \`plugin.json\`
manifest, lifecycle entry point, \`src/\`, \`tests/\`. No importing another
plugin's internals directly — only kernel-brokered capabilities. See
\`docs/ai-plugin-authoring.md\` for the full authoring guide.
`;
}

/**
 * `tests/plugins/<id>/manifest.test.ts` — `docs/ai-plugin-authoring.md`
 * §6.2's template, copied verbatim with `<id>` substituted (the doc
 * explicitly instructs authors to copy this pattern rather than
 * reinventing it; the generator now does that substitution mechanically).
 */
export function renderManifestTestTs(id: string): string {
  return `import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../../../src/core/manifest.js";
import { scanPluginDirectories } from "../../../src/core/registry.js";
import { isOk } from "../../../src/core/types.js";

const PLUGINS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/plugins",
);

describe("${id} plugin manifest", () => {
  it("is discoverable by the plugin registry scan", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "${id}");
    expect(entry).toBeDefined();
    expect(entry?.manifestPath).toBe(path.join(PLUGINS_ROOT, "${id}", "plugin.json"));
    expect(entry?.manifest).not.toBeNull();
  });

  it("has a manifest that passes the kernel's manifest validator", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "${id}");
    const result = validateManifest(entry?.manifest);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.id).toBe("${id}");
      expect(result.value.entry_point).toBe("index.ts");
    }
  });
});
`;
}

/**
 * Placeholder committed at `src/plugins/<id>/src/.gitkeep` so the
 * (initially empty) implementation directory feature #75 requires actually
 * exists on disk and survives a git commit — git does not track empty
 * directories, and `docs/ai-plugin-authoring.md` §9 confirms nothing about
 * `entry_point` resolution requires this directory to be non-empty, so a
 * placeholder is all it needs until the plugin grows real modules under
 * it.
 */
export function renderSrcPlaceholder(): string {
  return "";
}

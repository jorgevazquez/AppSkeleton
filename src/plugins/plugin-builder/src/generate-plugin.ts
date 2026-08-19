/**
 * `create-plugin` generator (feature #75 — "create-plugin generator:
 * scaffolds manifest, lifecycle stubs, src/, tests/"), the programmatic
 * core spec.md's plugin-builder section calls out as "a `create-plugin`
 * generator (CLI + programmatic API) that emits a valid skeleton
 * (manifest, lifecycle stubs, test stub)". {@link generatePlugin} is that
 * programmatic API; feature #76's CLI is a thin wrapper over it, and
 * feature #80's "usable by another plugin or an AI agent" requirement is
 * satisfied by this function already taking a plain, typed options object
 * with no CLI/stdin coupling.
 *
 * What it emits, given a plugin id and a one-line description, following
 * `docs/ai-plugin-authoring.md`'s directory layout (§3) exactly:
 *
 *   - `<pluginsRoot>/<id>/plugin.json`         — the manifest (§2)
 *   - `<pluginsRoot>/<id>/index.ts`            — lifecycle stubs (§4)
 *   - `<pluginsRoot>/<id>/src/.gitkeep`        — the (initially empty) `src/`
 *   - `<pluginsRoot>/<id>/README.md`           — scaffold boilerplate (§3)
 *   - `<testsRoot>/<id>/manifest.test.ts`      — the discoverability test (§6.2)
 *
 * `pluginsRoot`/`testsRoot` default to this repo's real `src/plugins` and
 * `tests/plugins` (resolved relative to this module's own file location,
 * the same pattern `generate-manifest-json-schema.ts` uses, so it is
 * correct regardless of `cwd`) but are overridable — feature #75 step 3's
 * own test, and feature #80's programmatic-API test, both generate into an
 * isolated temp directory rather than touching the real tree.
 *
 * Before writing anything, the rendered manifest is re-validated through
 * the kernel's own {@link validateManifest} — the same function the
 * loader/registry use at runtime — so "the generated output passes the
 * kernel's manifest validator unmodified" (feature #75 step 2) is not just
 * an assumption about the template but an assertion this function makes
 * about its own output before ever touching disk. Nothing is written if
 * that check (or the `id` pattern check, or the existing-directory check)
 * fails: `generatePlugin` either writes the complete, valid skeleton or
 * writes nothing at all.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ValidationError } from "../../../core/errors.js";
import {
  PLUGIN_ID_PATTERN,
  validateManifest,
  type PluginManifest,
} from "../../../core/manifest.js";
import { err, ok, type Result } from "../../../core/types.js";
import {
  buildPluginManifest,
  renderManifestTestTs,
  renderPluginIndexTs,
  renderPluginManifestJson,
  renderPluginReadme,
  renderSrcPlaceholder,
} from "./plugin-templates.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** `src/plugins/plugin-builder/src` -> repo root. */
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..", "..", "..");

/** This repo's real plugin-owned-files root, used as {@link GeneratePluginOptions.pluginsRoot}'s default. */
export const DEFAULT_PLUGINS_ROOT = path.join(REPO_ROOT, "src", "plugins");
/** This repo's real plugin-tests root, used as {@link GeneratePluginOptions.testsRoot}'s default. */
export const DEFAULT_TESTS_ROOT = path.join(REPO_ROOT, "tests", "plugins");

export interface GeneratePluginOptions {
  /** Plugin id: must be lowercase-kebab-case (`PLUGIN_ID_PATTERN`) and becomes the directory name under both roots. */
  id: string;
  /**
   * One-line, human-readable description of what the plugin does. Never
   * written into `plugin.json` (the schema has no such field — see
   * manifest.ts's docs); embedded only in the generated `index.ts` doc
   * comment and `README.md`.
   */
  description: string;
  /** Root directory under which `<id>/` is created for the plugin's own files. Default: {@link DEFAULT_PLUGINS_ROOT}. */
  pluginsRoot?: string;
  /** Root directory under which `<id>/` is created for the plugin's test file. Default: {@link DEFAULT_TESTS_ROOT}. */
  testsRoot?: string;
}

/** One file this generator wrote, for callers that want to log/inspect/verify exactly what happened. */
export interface GeneratedPluginFile {
  /** Absolute path on disk. */
  path: string;
  /** Exact contents written. */
  contents: string;
}

export interface GeneratedPlugin {
  id: string;
  /** The validated manifest that was written to `plugin.json` — guaranteed to already pass {@link validateManifest}. */
  manifest: PluginManifest;
  /** Absolute path to `<pluginsRoot>/<id>`. */
  pluginDir: string;
  /** Absolute path to `<testsRoot>/<id>`. */
  testDir: string;
  /** Every file written, in write order. */
  files: GeneratedPluginFile[];
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
      return false;
    }
    throw cause;
  }
}

/**
 * Scaffold a new, spec-compliant plugin directory (plus its parallel test
 * directory) from templates. Never throws for an ordinary "bad input" or
 * "already exists" failure — those come back as `Err(ValidationError)`, per
 * this codebase's `Result` convention (types.ts) for expected, recoverable
 * failures; only an unexpected filesystem error (permissions, disk full)
 * propagates as a thrown rejection.
 */
export async function generatePlugin(
  options: GeneratePluginOptions,
): Promise<Result<GeneratedPlugin, ValidationError>> {
  const { id } = options;
  const description = options.description.trim();
  const pluginsRoot = options.pluginsRoot ?? DEFAULT_PLUGINS_ROOT;
  const testsRoot = options.testsRoot ?? DEFAULT_TESTS_ROOT;

  if (!PLUGIN_ID_PATTERN.test(id)) {
    return err(
      new ValidationError(
        `create-plugin: "${id}" is not a valid plugin id — must be lowercase-kebab-case ` +
          `(PLUGIN_ID_PATTERN: ${PLUGIN_ID_PATTERN.source}).`,
      ),
    );
  }

  if (description.length === 0) {
    return err(new ValidationError("create-plugin: description must not be empty."));
  }

  const pluginDir = path.join(pluginsRoot, id);
  const testDir = path.join(testsRoot, id);

  if (await pathExists(pluginDir)) {
    return err(
      new ValidationError(
        `create-plugin: "${pluginDir}" already exists — refusing to overwrite an existing plugin.`,
      ),
    );
  }
  if (await pathExists(testDir)) {
    return err(
      new ValidationError(
        `create-plugin: "${testDir}" already exists — refusing to overwrite existing tests.`,
      ),
    );
  }

  const manifest = buildPluginManifest(id);

  // The template only ever produces field *values* the schema already accepts (§2), but this
  // re-validation is what actually backs feature #75 step 2's requirement — the generator
  // asserts its own output against the kernel's real validator rather than merely assuming its
  // template is correct, and refuses to write anything if that assertion ever fails.
  const validated = validateManifest(manifest);
  if (!validated.ok) {
    return err(
      new ValidationError(
        `create-plugin: internal error — generated manifest for "${id}" failed the kernel's ` +
          `own validator: ${validated.error.message}`,
        { cause: validated.error },
      ),
    );
  }

  const files: GeneratedPluginFile[] = [
    {
      path: path.join(pluginDir, "plugin.json"),
      contents: renderPluginManifestJson(validated.value),
    },
    { path: path.join(pluginDir, "index.ts"), contents: renderPluginIndexTs(id, description) },
    { path: path.join(pluginDir, "README.md"), contents: renderPluginReadme(id, description) },
    { path: path.join(pluginDir, "src", ".gitkeep"), contents: renderSrcPlaceholder() },
    { path: path.join(testDir, "manifest.test.ts"), contents: renderManifestTestTs(id) },
  ];

  await mkdir(path.join(pluginDir, "src"), { recursive: true });
  await mkdir(testDir, { recursive: true });

  for (const file of files) {
    await writeFile(file.path, file.contents, "utf-8");
  }

  return ok({
    id,
    manifest: validated.value,
    pluginDir,
    testDir,
    files,
  });
}

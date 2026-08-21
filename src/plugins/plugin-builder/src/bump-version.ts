/**
 * `plugin.json` version bump helper (feature #84 — "Plugin manifest version
 * bump helper"). A small, side-effect-scoped utility that reads a plugin's
 * `plugin.json`, computes the result of moving its `version` field forward
 * to a caller-supplied target, and only ever writes that result back to disk
 * once it has cleared two independent checks:
 *
 *   1. The candidate manifest (current manifest with `version` replaced by
 *      `targetVersion`) still passes the kernel's own {@link validateManifest}
 *      — the same validator the loader/registry use, so a bump can never
 *      produce a `plugin.json` the kernel itself would then refuse to load.
 *      This is also what rejects a non-canonical-semver target (e.g. a "v"
 *      prefix, or a loose form like "1.2") without this module duplicating
 *      manifest.ts's semver regex.
 *   2. The target is strictly greater (per `semver.gt`, feature #74's same
 *      `semver` dependency already used by manifest.ts/graph.ts) than the
 *      manifest's *current* version — "bump" means forward progress; a
 *      target equal to or lower than the current version is rejected rather
 *      than silently accepted as a same-version no-op or a downgrade.
 *
 * Nothing is written to disk unless both checks pass — this function either
 * updates the file to the exact validated result or leaves it byte-for-byte
 * untouched, mirroring `generate-plugin.ts`'s "write everything or write
 * nothing" contract.
 */
import { readFile, writeFile } from "node:fs/promises";
import semver from "semver";
import { ValidationError } from "../../../core/errors.js";
import { validateManifest, type PluginManifest } from "../../../core/manifest.js";
import { err, ok, type Result } from "../../../core/types.js";
import { renderPluginManifestJson } from "./plugin-templates.js";

/** Options for {@link bumpPluginVersion}. */
export interface BumpPluginVersionOptions {
  /** Path (absolute, or relative to `cwd`) to the `plugin.json` file to bump. */
  manifestPath: string;
  /** The new `version` value to bump to. Must be valid canonical semver and strictly greater than the file's current version. */
  targetVersion: string;
}

/** What a successful {@link bumpPluginVersion} call produced. */
export interface BumpPluginVersionResult {
  /** The full manifest as written back to `manifestPath`, already re-validated. */
  manifest: PluginManifest;
  /** The `version` the file had before this bump. */
  previousVersion: string;
  /** The `version` now on disk — equal to the requested `targetVersion`. */
  newVersion: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bump a plugin's `plugin.json` `version` field to `targetVersion`, writing
 * the change back to `manifestPath` only if the target is both valid
 * (canonical semver, and the resulting manifest still passes
 * {@link validateManifest}) and strictly newer than the file's current
 * version. Never throws for an ordinary "bad input"/"can't move forward"
 * failure — those come back as `Err(ValidationError)`, per this codebase's
 * `Result` convention (types.ts); only an unexpected filesystem error
 * propagates as a thrown rejection.
 */
export async function bumpPluginVersion(
  options: BumpPluginVersionOptions,
): Promise<Result<BumpPluginVersionResult, ValidationError>> {
  const { manifestPath, targetVersion } = options;

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch (cause) {
    return err(
      new ValidationError(
        `bump-version: could not read "${manifestPath}": ${describeError(cause)}`,
        { cause },
      ),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return err(
      new ValidationError(
        `bump-version: "${manifestPath}" is not valid JSON: ${describeError(cause)}`,
        { cause },
      ),
    );
  }

  const current = validateManifest(parsed);
  if (!current.ok) {
    return err(
      new ValidationError(
        `bump-version: "${manifestPath}" does not currently pass the manifest validator: ` +
          `${current.error.message}`,
        { cause: current.error },
      ),
    );
  }

  const previousVersion = current.value.version;
  const candidate: unknown = { ...current.value, version: targetVersion };

  const next = validateManifest(candidate);
  if (!next.ok) {
    return err(
      new ValidationError(
        `bump-version: target version "${targetVersion}" is invalid for "${manifestPath}": ` +
          `${next.error.message}`,
        { cause: next.error },
      ),
    );
  }

  if (!semver.gt(next.value.version, previousVersion)) {
    return err(
      new ValidationError(
        `bump-version: target version "${targetVersion}" must be greater than the current ` +
          `version "${previousVersion}" of "${manifestPath}".`,
      ),
    );
  }

  await writeFile(manifestPath, renderPluginManifestJson(next.value), "utf-8");

  return ok({
    manifest: next.value,
    previousVersion,
    newVersion: next.value.version,
  });
}

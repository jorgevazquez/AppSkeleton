/**
 * Plugin directory discovery and scanning.
 *
 * The first job of the kernel's Plugin Registry (spec.md: "discovers
 * plugins under `src/plugins/*`, topologically sorts by `depends_on`,
 * validates manifests, instantiates in dependency order, ...") is purely
 * mechanical: walk the plugins root, and for each immediate subdirectory
 * read and JSON-parse its `plugin.json`. {@link scanPluginDirectories} does
 * exactly that step and nothing more — it does NOT validate the manifest
 * against {@link "./manifest.js".PluginManifestSchema} (see manifest.ts's
 * `validateManifest()` for that), does NOT resolve `depends_on`, and does
 * NOT instantiate anything. Those are the loader's job, built on top of
 * this scan.
 *
 * Per spec.md's "graceful degradation" baseline ("a broken plugin must not
 * crash the kernel or unrelated plugins"), a single plugin directory that
 * is missing its manifest, has a manifest that isn't valid JSON, or can't
 * be read for some other reason (permissions, a `plugin.json` that is
 * actually a directory, ...) is never fatal to the scan as a whole: it is
 * recorded in the result's `skipped` list (with a machine-readable reason
 * and a human-readable message) and logged as a warning, and the scan
 * continues with the next directory. The only case that IS fatal is the
 * plugins root itself being unreadable (missing, not a directory, no
 * permission) — that is a kernel-level misconfiguration, not a
 * per-plugin problem, so it throws a {@link PluginLoadError}.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PluginLoadError } from "./errors.js";
import { createLogger, type Logger } from "./logger.js";

/** Name of the manifest file every plugin directory is expected to contain. */
export const MANIFEST_FILENAME = "plugin.json";

/**
 * One successfully-read plugin directory: its location plus the raw
 * (parsed-but-unvalidated) contents of its `plugin.json`. Pass `manifest`
 * to {@link "./manifest.js".validateManifest} to get a typed, validated
 * {@link "./manifest.js".PluginManifest}.
 */
export interface PluginScanEntry {
  /** The plugin directory's name, e.g. "database-mysql". */
  name: string;
  /** Absolute path to the plugin's directory. */
  directoryPath: string;
  /** Absolute path to the plugin's `plugin.json`. */
  manifestPath: string;
  /** Parsed JSON contents of `plugin.json` — NOT validated against the manifest schema. */
  manifest: unknown;
}

/** Why a directory under the plugins root was skipped rather than scanned. */
export type PluginScanSkipReason =
  "not_a_directory" | "missing_manifest" | "malformed_manifest" | "unreadable_manifest";

/** A directory under the plugins root that was skipped, and why. */
export interface PluginScanSkip {
  /** The skipped entry's name, e.g. "notes.txt" or "half-built-plugin". */
  name: string;
  /** Absolute path to the skipped entry. */
  directoryPath: string;
  /** Machine-readable reason code. */
  reason: PluginScanSkipReason;
  /** Human-readable explanation, also what gets logged. */
  message: string;
}

/** Result of scanning a plugins root directory. */
export interface PluginScanResult {
  /** One entry per plugin directory whose `plugin.json` was found and is valid JSON. */
  entries: PluginScanEntry[];
  /** One entry per directory-root child that was skipped, with a reason. */
  skipped: PluginScanSkip[];
}

export interface ScanPluginDirectoriesOptions {
  /**
   * Logger used to report skipped directories. Defaults to a fresh logger
   * (`createLogger({ context: { module: "plugin-registry" } })`) — pass an
   * explicit one to route scan warnings through a plugin- or
   * request-scoped logger, or to capture output in tests.
   */
  logger?: Logger;
}

/** Narrow an unknown error to a Node.js errno exception (has a string `code`). */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Walk the immediate subdirectories of `pluginsRoot` and read each one's
 * `plugin.json`. Returns the raw (unvalidated) manifest + directory path
 * for every directory that has one, plus a `skipped` list — with reasons —
 * for anything that could not be scanned.
 *
 * A missing/unreadable/malformed `plugin.json` in an individual plugin
 * directory is skipped and logged, never thrown. `pluginsRoot` itself not
 * existing (or not being a readable directory) throws a
 * {@link PluginLoadError}, since that means the kernel has nothing to scan
 * at all — a misconfiguration, not a per-plugin failure.
 */
export async function scanPluginDirectories(
  pluginsRoot: string,
  options: ScanPluginDirectoriesOptions = {},
): Promise<PluginScanResult> {
  const logger = options.logger ?? createLogger({ context: { module: "plugin-registry" } });

  let dirents;
  try {
    dirents = await readdir(pluginsRoot, { withFileTypes: true });
  } catch (cause) {
    throw new PluginLoadError(
      `Could not read plugins root directory at "${pluginsRoot}": ${describeError(cause)}`,
      { cause },
    );
  }

  const entries: PluginScanEntry[] = [];
  const skipped: PluginScanSkip[] = [];

  const sortedNames = dirents.map((dirent) => dirent.name).sort((a, b) => a.localeCompare(b));

  for (const name of sortedNames) {
    const directoryPath = path.join(pluginsRoot, name);
    const dirent = dirents.find((candidate) => candidate.name === name);

    if (!dirent?.isDirectory()) {
      skipped.push(
        recordSkip(logger, {
          name,
          directoryPath,
          reason: "not_a_directory",
          message: `Skipping "${name}" under "${pluginsRoot}": not a directory.`,
        }),
      );
      continue;
    }

    const manifestPath = path.join(directoryPath, MANIFEST_FILENAME);

    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf-8");
    } catch (cause) {
      if (isErrnoException(cause) && cause.code === "ENOENT") {
        skipped.push(
          recordSkip(logger, {
            name,
            directoryPath,
            reason: "missing_manifest",
            message: `Skipping plugin directory "${name}": no ${MANIFEST_FILENAME} found.`,
          }),
        );
        continue;
      }

      skipped.push(
        recordSkip(logger, {
          name,
          directoryPath,
          reason: "unreadable_manifest",
          message: `Skipping plugin directory "${name}": could not read ${MANIFEST_FILENAME} (${describeError(cause)}).`,
        }),
      );
      continue;
    }

    let manifest: unknown;
    try {
      manifest = JSON.parse(raw);
    } catch (cause) {
      skipped.push(
        recordSkip(logger, {
          name,
          directoryPath,
          reason: "malformed_manifest",
          message: `Skipping plugin directory "${name}": ${MANIFEST_FILENAME} is not valid JSON (${describeError(cause)}).`,
        }),
      );
      continue;
    }

    entries.push({ name, directoryPath, manifestPath, manifest });
  }

  logger.info(
    { pluginsRoot, found: entries.length, skipped: skipped.length },
    "Plugin directory scan complete.",
  );

  return { entries, skipped };
}

/** Log a skip at "warn" and return it, so call sites can `skipped.push(recordSkip(...))` in one line. */
function recordSkip(logger: Logger, skip: PluginScanSkip): PluginScanSkip {
  logger.warn(
    { plugin: skip.name, directoryPath: skip.directoryPath, reason: skip.reason },
    skip.message,
  );
  return skip;
}

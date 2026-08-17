import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { PluginLoadError } from "../../src/core/errors.js";
import { createLogger } from "../../src/core/logger.js";
import { scanPluginDirectories, type PluginScanSkipReason } from "../../src/core/registry.js";

/** In-memory sink for a pino logger's raw ndjson output, mirroring logger.test.ts's helper. */
function createCapturingLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({ stream, level: "trace" });
  return {
    logger,
    lines: (): Record<string, unknown>[] =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function makePluginsRoot(): string {
  return mkdtempSync(join(tmpdir(), "appskeleton-registry-"));
}

/** Create a plugin subdirectory. `manifest` is JSON.stringify'd unless it's already a raw string (for malformed-JSON fixtures); omit it entirely to simulate a missing manifest. */
function writePluginDir(
  root: string,
  name: string,
  manifest?: string | Record<string, unknown>,
  extraFiles: Record<string, string> = {},
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) {
    const contents = typeof manifest === "string" ? manifest : JSON.stringify(manifest);
    writeFileSync(join(dir, "plugin.json"), contents);
  }
  for (const [fileName, contents] of Object.entries(extraFiles)) {
    writeFileSync(join(dir, fileName), contents);
  }
  return dir;
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "example-plugin",
    version: "1.0.0",
    entry_point: "index.ts",
    ...overrides,
  };
}

describe("scanPluginDirectories — valid plugins", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("returns a raw manifest + directory path pair for a single valid plugin", async () => {
    root = makePluginsRoot();
    writePluginDir(root, "rbac", validManifest({ id: "rbac" }));

    const result = await scanPluginDirectories(root);

    expect(result.skipped).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      name: "rbac",
      directoryPath: join(root, "rbac"),
      manifestPath: join(root, "rbac", "plugin.json"),
      manifest: validManifest({ id: "rbac" }),
    });
  });

  it("discovers multiple valid plugin directories, sorted by name", async () => {
    root = makePluginsRoot();
    writePluginDir(root, "wiki", validManifest({ id: "wiki" }));
    writePluginDir(root, "api-gateway", validManifest({ id: "api-gateway" }));
    writePluginDir(root, "database-mysql", validManifest({ id: "database-mysql" }));

    const result = await scanPluginDirectories(root);

    expect(result.skipped).toEqual([]);
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "api-gateway",
      "database-mysql",
      "wiki",
    ]);
    expect(result.entries.every((entry) => typeof entry.manifest === "object")).toBe(true);
  });

  it("returns the manifest raw/unvalidated — a manifest missing required fields is still returned", async () => {
    root = makePluginsRoot();
    writePluginDir(root, "incomplete", { id: "incomplete" }); // missing version/entry_point

    const result = await scanPluginDirectories(root);

    expect(result.skipped).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.manifest).toEqual({ id: "incomplete" });
  });

  it("returns an empty result for an empty plugins root", async () => {
    root = makePluginsRoot();

    const result = await scanPluginDirectories(root);

    expect(result).toEqual({ entries: [], skipped: [] });
  });
});

describe("scanPluginDirectories — missing manifest", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("skips (does not crash on) a plugin directory with no plugin.json", async () => {
    root = makePluginsRoot();
    writePluginDir(root, "no-manifest", undefined, { "README.md": "# no manifest here" });

    const result = await scanPluginDirectories(root);

    expect(result.entries).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      name: "no-manifest",
      directoryPath: join(root, "no-manifest"),
      reason: "missing_manifest" satisfies PluginScanSkipReason,
    });
    expect(result.skipped[0]?.message).toContain("no-manifest");
  });

  it("logs a warning naming the directory and reason", async () => {
    root = makePluginsRoot();
    writePluginDir(root, "no-manifest");
    const { logger, lines } = createCapturingLogger();

    await scanPluginDirectories(root, { logger });

    const warnLine = lines().find((line) => line["level"] === 40);
    expect(warnLine).toBeDefined();
    expect(warnLine?.["plugin"]).toBe("no-manifest");
    expect(warnLine?.["reason"]).toBe("missing_manifest");
  });
});

describe("scanPluginDirectories — malformed manifest", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("skips (does not crash on) a plugin.json that is not valid JSON", async () => {
    root = makePluginsRoot();
    writePluginDir(root, "broken-json", "{ this is not json");

    const result = await scanPluginDirectories(root);

    expect(result.entries).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      name: "broken-json",
      directoryPath: join(root, "broken-json"),
      reason: "malformed_manifest" satisfies PluginScanSkipReason,
    });
  });

  it("logs a warning for the malformed manifest", async () => {
    root = makePluginsRoot();
    writePluginDir(root, "broken-json", "not json at all");
    const { logger, lines } = createCapturingLogger();

    await scanPluginDirectories(root, { logger });

    const warnLine = lines().find((line) => line["level"] === 40);
    expect(warnLine).toBeDefined();
    expect(warnLine?.["plugin"]).toBe("broken-json");
    expect(warnLine?.["reason"]).toBe("malformed_manifest");
  });

  it("treats an empty plugin.json file as malformed, not valid", async () => {
    root = makePluginsRoot();
    writePluginDir(root, "empty-file", "");

    const result = await scanPluginDirectories(root);

    expect(result.entries).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("malformed_manifest");
  });
});

describe("scanPluginDirectories — mixed fixture tree (valid + missing + malformed)", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("scans every directory independently without crashing on the bad ones", async () => {
    root = makePluginsRoot();
    writePluginDir(root, "good-plugin", validManifest({ id: "good-plugin" }));
    writePluginDir(root, "missing-manifest-plugin", undefined, { "README.md": "wip" });
    writePluginDir(root, "malformed-manifest-plugin", "{ oops,,");
    writePluginDir(root, "another-good-plugin", validManifest({ id: "another-good-plugin" }));

    const result = await scanPluginDirectories(root);

    expect(result.entries.map((entry) => entry.name).sort()).toEqual([
      "another-good-plugin",
      "good-plugin",
    ]);
    const skippedByName = Object.fromEntries(
      result.skipped.map((skip) => [skip.name, skip.reason]),
    );
    expect(skippedByName).toEqual({
      "missing-manifest-plugin": "missing_manifest",
      "malformed-manifest-plugin": "malformed_manifest",
    });
  });

  it("skips a non-directory entry found directly under the plugins root", async () => {
    root = makePluginsRoot();
    writePluginDir(root, "good-plugin", validManifest({ id: "good-plugin" }));
    writeFileSync(join(root, "stray-file.txt"), "not a plugin directory");

    const result = await scanPluginDirectories(root);

    expect(result.entries.map((entry) => entry.name)).toEqual(["good-plugin"]);
    expect(result.skipped).toEqual([
      {
        name: "stray-file.txt",
        directoryPath: join(root, "stray-file.txt"),
        reason: "not_a_directory",
        message: expect.stringContaining("stray-file.txt") as unknown as string,
      },
    ]);
  });
});

describe("scanPluginDirectories — plugins root itself is unreadable", () => {
  it("throws a PluginLoadError when the plugins root does not exist", async () => {
    const missingRoot = join(tmpdir(), "appskeleton-registry-does-not-exist");

    await expect(scanPluginDirectories(missingRoot)).rejects.toThrow(PluginLoadError);
  });

  it("the PluginLoadError names the missing path", async () => {
    const missingRoot = join(tmpdir(), "appskeleton-registry-does-not-exist");

    try {
      await scanPluginDirectories(missingRoot);
      expect.fail("expected scanPluginDirectories to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginLoadError);
      const loadError = error as PluginLoadError;
      expect(loadError.code).toBe("PLUGIN_LOAD_ERROR");
      expect(loadError.message).toContain(missingRoot);
    }
  });
});

describe("scanPluginDirectories — default logger", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("works without an explicit logger option", async () => {
    root = makePluginsRoot();
    writePluginDir(root, "good-plugin", validManifest({ id: "good-plugin" }));
    writePluginDir(root, "no-manifest");

    await expect(scanPluginDirectories(root)).resolves.toMatchObject({
      entries: [{ name: "good-plugin" }],
      skipped: [{ name: "no-manifest", reason: "missing_manifest" }],
    });
  });
});

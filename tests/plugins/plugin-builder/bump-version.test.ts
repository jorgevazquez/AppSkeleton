import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateManifest } from "../../../src/core/manifest.js";
import { isErr, isOk } from "../../../src/core/types.js";
import { bumpPluginVersion } from "../../../src/plugins/plugin-builder/src/bump-version.js";

/**
 * Feature #84 step 2: "Write a test asserting an invalid target version is
 * rejected and a valid one updates the file correctly."
 */

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

/** Write a fresh, valid `plugin.json` (version "1.2.3") into a temp dir and return its path. */
function freshManifestFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "appskeleton-bump-version-"));
  tmpDirs.push(dir);
  const manifestPath = join(dir, "plugin.json");
  const manifest = {
    id: "sample-widget",
    version: "1.2.3",
    depends_on: {},
    capabilities: { provides: [], requires: [] },
    entry_point: "index.ts",
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  return manifestPath;
}

describe("bumpPluginVersion — rejects an invalid target version", () => {
  it("rejects a non-semver target and leaves the file untouched", async () => {
    const manifestPath = freshManifestFile();
    const before = readFileSync(manifestPath, "utf-8");

    const result = await bumpPluginVersion({ manifestPath, targetVersion: "not-a-version" });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.message).toContain("not-a-version");
    }
    expect(readFileSync(manifestPath, "utf-8")).toBe(before);
  });

  it("rejects a target version that is not greater than the current version", async () => {
    const manifestPath = freshManifestFile();
    const before = readFileSync(manifestPath, "utf-8");

    const same = await bumpPluginVersion({ manifestPath, targetVersion: "1.2.3" });
    expect(isErr(same)).toBe(true);

    const lower = await bumpPluginVersion({ manifestPath, targetVersion: "1.0.0" });
    expect(isErr(lower)).toBe(true);
    if (isErr(lower)) {
      expect(lower.error.message).toContain("greater than the current version");
    }

    expect(readFileSync(manifestPath, "utf-8")).toBe(before);
  });
});

describe("bumpPluginVersion — accepts a valid target version", () => {
  it("updates the file's version field and re-validates the result", async () => {
    const manifestPath = freshManifestFile();

    const result = await bumpPluginVersion({ manifestPath, targetVersion: "1.3.0" });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.previousVersion).toBe("1.2.3");
      expect(result.value.newVersion).toBe("1.3.0");
      expect(result.value.manifest.version).toBe("1.3.0");
    }

    const onDisk: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect((onDisk as { version: string }).version).toBe("1.3.0");

    const revalidated = validateManifest(onDisk);
    expect(isOk(revalidated)).toBe(true);

    // Every other field is preserved verbatim — only `version` changed.
    expect((onDisk as { id: string }).id).toBe("sample-widget");
    expect((onDisk as { entry_point: string }).entry_point).toBe("index.ts");
  });

  it("preserves the trailing newline / pretty-printed formatting convention", async () => {
    const manifestPath = freshManifestFile();

    await bumpPluginVersion({ manifestPath, targetVersion: "2.0.0" });

    const contents = readFileSync(manifestPath, "utf-8");
    expect(contents.endsWith("\n")).toBe(true);
    expect(contents).toBe(`${JSON.stringify(JSON.parse(contents), null, 2)}\n`);
  });
});

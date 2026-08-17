import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../../../src/core/manifest.js";
import { scanPluginDirectories } from "../../../src/core/registry.js";
import { isOk } from "../../../src/core/types.js";

/** Real `src/plugins` root — this test exercises the actual shipped plugin.json, not a fixture. */
const PLUGINS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/plugins",
);

describe("rbac plugin manifest", () => {
  it("is discoverable by the plugin registry scan", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);

    const entry = entries.find((candidate) => candidate.name === "rbac");
    expect(entry).toBeDefined();
    expect(entry?.manifestPath).toBe(path.join(PLUGINS_ROOT, "rbac", "plugin.json"));
    expect(entry?.manifest).not.toBeNull();
  });

  it("has a manifest that passes the kernel's manifest validator", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "rbac");
    expect(entry).toBeDefined();

    const result = validateManifest(entry?.manifest);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.id).toBe("rbac");
      expect(result.value.entry_point).toBe("index.ts");
    }
  });

  it("declares rbac:check and rbac:manage as provided capabilities", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "rbac");
    const result = validateManifest(entry?.manifest);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.capabilities.provides).toEqual(
        expect.arrayContaining(["rbac:check", "rbac:manage"]),
      );
      expect(result.value.capabilities.provides).toHaveLength(2);
    }
  });
});

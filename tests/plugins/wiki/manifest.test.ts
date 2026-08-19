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

describe("wiki plugin manifest", () => {
  it("is discoverable by the plugin registry scan", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);

    const entry = entries.find((candidate) => candidate.name === "wiki");
    expect(entry).toBeDefined();
    expect(entry?.manifestPath).toBe(path.join(PLUGINS_ROOT, "wiki", "plugin.json"));
    expect(entry?.manifest).not.toBeNull();
  });

  it("has a manifest that passes the kernel's manifest validator", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "wiki");
    expect(entry).toBeDefined();

    const result = validateManifest(entry?.manifest);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.id).toBe("wiki");
      expect(result.value.entry_point).toBe("index.ts");
    }
  });

  it("declares no provided capabilities of its own yet — it is a consumer app built on other plugins", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "wiki");
    const result = validateManifest(entry?.manifest);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.capabilities.provides).toEqual([]);
    }
  });

  it("declares rbac:check, db:query, render:template, and http:route as required capabilities", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "wiki");
    const result = validateManifest(entry?.manifest);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.capabilities.requires).toEqual(
        expect.arrayContaining(["rbac:check", "db:query", "render:template", "http:route"]),
      );
      expect(result.value.capabilities.requires).toHaveLength(4);
    }
  });

  it("does not hard-depend on any plugin by id — it consumes capabilities only, per broker.ts's optional-capability model", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "wiki");
    const result = validateManifest(entry?.manifest);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.depends_on).toEqual({});
    }
  });
});

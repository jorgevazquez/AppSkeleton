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

describe("html-renderer plugin manifest", () => {
  it("is discoverable by the plugin registry scan", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);

    const entry = entries.find((candidate) => candidate.name === "html-renderer");
    expect(entry).toBeDefined();
    expect(entry?.manifestPath).toBe(path.join(PLUGINS_ROOT, "html-renderer", "plugin.json"));
    expect(entry?.manifest).not.toBeNull();
  });

  it("has a manifest that passes the kernel's manifest validator", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "html-renderer");
    expect(entry).toBeDefined();

    const result = validateManifest(entry?.manifest);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.id).toBe("html-renderer");
      expect(result.value.entry_point).toBe("index.ts");
    }
  });

  it("declares render:template and html:error-pages as its provided capabilities", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "html-renderer");
    const result = validateManifest(entry?.manifest);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      // html:error-pages (feature #116) joined render:template here once
      // `./index.ts` started exposing `./src/error-pages.ts`'s
      // renderNotFoundPage/renderServerErrorPage (feature #55) as a second
      // capability, for api-gateway's error handler to consume.
      expect(result.value.capabilities.provides).toEqual(
        expect.arrayContaining(["render:template", "html:error-pages"]),
      );
      expect(result.value.capabilities.provides).toHaveLength(2);
      expect(result.value.capabilities.requires).toHaveLength(0);
    }
  });
});

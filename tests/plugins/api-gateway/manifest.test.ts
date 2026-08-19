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

describe("api-gateway plugin manifest", () => {
  it("is discoverable by the plugin registry scan", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);

    const entry = entries.find((candidate) => candidate.name === "api-gateway");
    expect(entry).toBeDefined();
    expect(entry?.manifestPath).toBe(path.join(PLUGINS_ROOT, "api-gateway", "plugin.json"));
    expect(entry?.manifest).not.toBeNull();
  });

  it("has a manifest that passes the kernel's manifest validator", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "api-gateway");
    expect(entry).toBeDefined();

    const result = validateManifest(entry?.manifest);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.id).toBe("api-gateway");
      expect(result.value.entry_point).toBe("index.ts");
    }
  });

  it("declares http:route as its sole provided capability", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "api-gateway");
    const result = validateManifest(entry?.manifest);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.capabilities.provides).toEqual(expect.arrayContaining(["http:route"]));
      expect(result.value.capabilities.provides).toHaveLength(1);
    }
  });

  it("declares rbac:check, render:template, and html:error-pages as required capabilities it may consume", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "api-gateway");
    const result = validateManifest(entry?.manifest);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      // html:error-pages (feature #116) joined render:template here once
      // ./src/error-handler.ts started consuming it (best-effort, see that
      // module's own docs) for the styled 404/500 pages.
      expect(result.value.capabilities.requires).toEqual(
        expect.arrayContaining(["rbac:check", "render:template", "html:error-pages"]),
      );
      expect(result.value.capabilities.requires).toHaveLength(3);
    }
  });

  it("does not hard-depend on the rbac or html-renderer plugins, since it consumes their capabilities optionally", async () => {
    const { entries } = await scanPluginDirectories(PLUGINS_ROOT);
    const entry = entries.find((candidate) => candidate.name === "api-gateway");
    const result = validateManifest(entry?.manifest);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      // `depends_on` is a hard, load-order-enforcing plugin dependency (see
      // graph.ts's `missing_dependency` check) — api-gateway must load and
      // pass manifest validation even if rbac/html-renderer are never
      // installed. Optional consumption of their capabilities is expressed
      // solely via `capabilities.requires` + broker.ts's `obtain()`, which
      // gracefully returns `Err` (reason "no_provider") rather than ever
      // throwing when a declared-but-optional capability has no provider.
      expect(result.value.depends_on).toEqual({});
    }
  });
});

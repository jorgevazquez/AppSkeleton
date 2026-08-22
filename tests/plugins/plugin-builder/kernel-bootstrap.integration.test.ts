import { describe, expect, it } from "vitest";
import { bootstrapKernel } from "../../../src/server/index.js";

/**
 * Feature #120's smoke suite (`scripts/smoke-test.ts`) is the first thing
 * in this repo's own history to boot the *real*, dynamically-discovered
 * `bootstrapKernel()` and assert every shipped plugin — `plugin-builder`
 * included — actually loads. Doing so surfaced a real, previously-invisible
 * gap: `plugin-builder/plugin.json` has declared `entry_point: "index.ts"`
 * since it was first scaffolded, but no root `index.ts` ever backed it (see
 * that plugin's own README, "Deliberately empty at scaffold time"), so
 * every real boot silently reported it `"failed"` — invisible until now
 * because every other suite exercising `plugin-builder` imports its
 * `src/*.ts` tooling directly as plain TypeScript utilities, never through
 * the kernel. `../../../src/plugins/plugin-builder/index.ts` closes that
 * gap with a minimal lifecycle stub (mirroring `hello-world`'s own
 * generated one); this suite is this repo's permanent regression guard
 * against it silently going missing again — mirrors
 * `tests/plugins/hello-world/kernel-bootstrap.integration.test.ts`'s own
 * first test.
 */
describe("plugin-builder — real kernel bootstrap", () => {
  it("loads successfully at kernel bootstrap and appears in kernel introspection as loaded", async () => {
    // Same real-tree, deterministic-env bootstrap path
    // tests/core/smoke.test.ts and hello-world's own sibling suite use: no
    // pluginsRoot override, so this scans and loads the actual shipped
    // src/plugins directory (plugin-builder included) exactly as a real
    // boot would.
    const kernel = await bootstrapKernel({ env: {} });
    try {
      const report = kernel.introspect();
      const pluginBuilder = report.plugins.find((plugin) => plugin.id === "plugin-builder");

      expect(pluginBuilder).toBeDefined();
      expect(pluginBuilder?.status).toBe("loaded");
      expect(pluginBuilder?.version).toBe("0.1.0");
      expect(pluginBuilder?.capabilities).toEqual({ provides: [], requires: [], granted: [] });
      expect(pluginBuilder?.error).toBeUndefined();
    } finally {
      await kernel.httpApp?.close();
    }
  });
});

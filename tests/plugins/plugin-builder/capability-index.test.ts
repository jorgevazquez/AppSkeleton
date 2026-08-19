import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_INDEX_DOC_PATH,
  collectCapabilityIndexEntries,
  generateCapabilityIndexDoc,
  renderCapabilityIndexDoc,
} from "../../../src/plugins/plugin-builder/src/generate-capability-index.js";

describe("capability index doc generator (feature #82)", () => {
  it("the checked-in docs/capability-index.md is exactly what generateCapabilityIndexDoc() produces right now — the generator's own 'regenerate and diff' drift check, run as part of `npm test` in CI", async () => {
    const committed = await readFile(CAPABILITY_INDEX_DOC_PATH, "utf-8");
    expect(committed).toBe(await generateCapabilityIndexDoc());
  });

  it("includes every shipped plugin's declared provides/requires capabilities", async () => {
    const entries = await collectCapabilityIndexEntries();
    // Sanity check: this repo actually ships plugins with capabilities to
    // index, so the assertions below aren't vacuously true.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.provides.length > 0)).toBe(true);
    expect(entries.some((entry) => entry.requires.length > 0)).toBe(true);

    const rendered = renderCapabilityIndexDoc(entries);

    for (const entry of entries) {
      expect(rendered).toContain(`\`${entry.pluginId}\``);
      for (const capability of entry.provides) {
        expect(rendered).toContain(`\`${capability}\``);
      }
      for (const capability of entry.requires) {
        expect(rendered).toContain(`\`${capability}\``);
      }
    }
  });

  it("the per-plugin table names every plugin exactly once, each on its own row", async () => {
    const entries = await collectCapabilityIndexEntries();
    const rendered = renderCapabilityIndexDoc(entries);

    for (const entry of entries) {
      const rowPattern = new RegExp(`^\\| \`${entry.pluginId}\` \\|`, "m");
      expect(rendered).toMatch(rowPattern);
    }
  });

  it("the by-capability cross index correctly attributes providers and consumers", async () => {
    const entries = await collectCapabilityIndexEntries();
    const rendered = renderCapabilityIndexDoc(entries);

    for (const entry of entries) {
      for (const capability of entry.provides) {
        const capabilityRow = rendered
          .split("\n")
          .find((line) => line.startsWith(`| \`${capability}\` |`));
        expect(capabilityRow, `expected a row for capability "${capability}"`).toBeDefined();
        expect(capabilityRow).toContain(`\`${entry.pluginId}\``);
      }
    }
  });

  it("renders an empty-capabilities plugin with the '(none)' placeholder, not empty table cells", () => {
    const rendered = renderCapabilityIndexDoc([
      { pluginId: "no-capabilities-plugin", provides: [], requires: [] },
    ]);
    expect(rendered).toContain("| `no-capabilities-plugin` | _(none)_ | _(none)_ |");
  });
});

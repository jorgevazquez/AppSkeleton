import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_PATTERN,
  ENTRY_POINT_PATTERN,
  PLUGIN_ID_PATTERN,
} from "../../src/core/manifest.js";

/**
 * `docs/plugin-conventions.md` (feature #15) documents the manifest's naming
 * regexes by quoting them verbatim in fenced code blocks, specifically so it
 * cannot silently drift from `src/core/manifest.ts`'s actual zod validator —
 * see that doc's "Source of truth" note. This suite is the enforcement half
 * of that promise: it extracts each documented regex straight out of the
 * Markdown file and asserts it is byte-for-byte identical to the exported
 * pattern the validator itself uses. If a future change to manifest.ts's
 * `CAPABILITY_PATTERN` (or the id/entry-point patterns) isn't mirrored in
 * the doc, this test fails.
 */

const DOC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/plugin-conventions.md",
);

const docSource = readFileSync(DOC_PATH, "utf8");

/** `docSource` with Markdown blockquote `"> "` line prefixes stripped, for prose substring/regex checks that shouldn't care about quoting/line-wrapping. */
const docProse = docSource.replace(/^>\s?/gm, "");

/**
 * Pull the content of a fenced code block tagged with `language` out of the
 * doc, e.g. for a block written as:
 *
 * ```capability-grammar-regex
 * ^[a-z]...$
 * ```
 *
 * `extractFencedBlock(docSource, "capability-grammar-regex")` returns
 * `"^[a-z]...$"`. Throws if no such block exists, so a typo'd language tag
 * fails loudly instead of the test silently checking nothing.
 */
function extractFencedBlock(source: string, language: string): string {
  const pattern = new RegExp("```" + language + "\\n([\\s\\S]*?)```", "m");
  const match = pattern.exec(source);
  if (!match || match[1] === undefined) {
    throw new Error(`docs/plugin-conventions.md has no \`\`\`${language} fenced block`);
  }
  return match[1].trim();
}

describe("docs/plugin-conventions.md — capability grammar regex matches the validator", () => {
  it("documents the exact same capability-grammar regex source as CAPABILITY_PATTERN", () => {
    const documented = extractFencedBlock(docSource, "capability-grammar-regex");
    expect(documented).toBe(CAPABILITY_PATTERN.source);
  });

  it("the documented pattern still round-trips as a valid, working regex", () => {
    const documented = extractFencedBlock(docSource, "capability-grammar-regex");
    const reconstructed = new RegExp(documented);

    expect(reconstructed.test("db:query")).toBe(true);
    expect(reconstructed.test("http:route")).toBe(true);
    expect(reconstructed.test("dbquery")).toBe(false);
    expect(reconstructed.test("db:")).toBe(false);
    expect(reconstructed.test("Db:Query")).toBe(false);
  });
});

describe("docs/plugin-conventions.md — other naming-rule regexes match the validator", () => {
  it("documents the exact same plugin-id regex source as PLUGIN_ID_PATTERN", () => {
    const documented = extractFencedBlock(docSource, "plugin-id-regex");
    expect(documented).toBe(PLUGIN_ID_PATTERN.source);
  });

  it("documents the exact same entry-point regex source as ENTRY_POINT_PATTERN", () => {
    const documented = extractFencedBlock(docSource, "entry-point-regex");
    expect(documented).toBe(ENTRY_POINT_PATTERN.source);
  });
});

describe("docs/plugin-conventions.md — content sanity", () => {
  it("documents the import-rules / forbidden-cross-plugin-imports section", () => {
    expect(docSource).toMatch(/forbidden cross-plugin imports/i);
    expect(docProse).toMatch(/no plugin imports another plugin's\s+internals directly/i);
  });

  it("documents the manifest shape's required fields", () => {
    for (const field of ["id", "version", "depends_on", "entry_point"]) {
      expect(docSource).toContain(`\`${field}\``);
    }
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_PATTERN,
  ENTRY_POINT_PATTERN,
  PLUGIN_ID_PATTERN,
  validateManifest,
} from "../../src/core/manifest.js";
import { isOk } from "../../src/core/types.js";

/**
 * `docs/ai-plugin-authoring.md` (feature #78) is an AI-agent-facing plugin
 * authoring guide. Like `docs/plugin-conventions.md` (feature #15) — see
 * `tests/core/plugin-conventions.test.ts` — its regex blocks are quoted
 * verbatim from `src/core/manifest.ts`'s exported patterns rather than
 * hand-copied, specifically so this doc cannot silently drift from the
 * validator it describes. It additionally embeds several complete
 * `plugin.json` examples (the "canonical patterns" from the real `rbac`
 * and `database-mysql` plugins, plus the worked `greeter` example) as
 * fenced ```json blocks; this suite also asserts every one of those
 * parses as JSON and actually passes the kernel's own manifest validator,
 * so the doc's worked example can never rot into something that looks
 * plausible but would actually be rejected.
 */

const DOC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/ai-plugin-authoring.md",
);

const docSource = readFileSync(DOC_PATH, "utf8");

/**
 * Pull the content of every fenced code block tagged with `language` out of
 * the doc, e.g. every ```json block. Returns one string per match, in
 * document order.
 */
function extractFencedBlocks(source: string, language: string): string[] {
  const pattern = new RegExp("```" + language + "\\n([\\s\\S]*?)```", "gm");
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const content = match[1];
    if (content !== undefined) {
      blocks.push(content.trim());
    }
  }
  return blocks;
}

function extractFencedBlock(source: string, language: string): string {
  const [first] = extractFencedBlocks(source, language);
  if (first === undefined) {
    throw new Error(`docs/ai-plugin-authoring.md has no \`\`\`${language} fenced block`);
  }
  return first;
}

describe("docs/ai-plugin-authoring.md — naming-rule regexes match the validator", () => {
  it("documents the exact same plugin-id regex source as PLUGIN_ID_PATTERN", () => {
    expect(extractFencedBlock(docSource, "plugin-id-regex")).toBe(PLUGIN_ID_PATTERN.source);
  });

  it("documents the exact same entry-point regex source as ENTRY_POINT_PATTERN", () => {
    expect(extractFencedBlock(docSource, "entry-point-regex")).toBe(ENTRY_POINT_PATTERN.source);
  });

  it("documents the exact same capability-grammar regex source as CAPABILITY_PATTERN", () => {
    expect(extractFencedBlock(docSource, "capability-grammar-regex")).toBe(
      CAPABILITY_PATTERN.source,
    );
  });
});

describe("docs/ai-plugin-authoring.md — every embedded plugin.json example is actually valid", () => {
  const jsonBlocks = extractFencedBlocks(docSource, "json");

  it("has at least the four expected manifest examples (minimal, rbac, database-mysql, greeter)", () => {
    expect(jsonBlocks.length).toBeGreaterThanOrEqual(4);
  });

  it("every ```json block parses as JSON and passes the kernel's manifest validator", () => {
    for (const block of jsonBlocks) {
      const parsed: unknown = JSON.parse(block);
      const result = validateManifest(parsed);
      if (!isOk(result)) {
        throw new Error(
          "docs/ai-plugin-authoring.md contains a fenced json block that fails " +
            `validateManifest(): ${result.error.message}\nBlock:\n${block}`,
        );
      }
      expect(isOk(result)).toBe(true);
    }
  });

  it("the rbac example matches the real src/plugins/rbac/plugin.json", () => {
    const rbacManifestPath = path.resolve(
      path.dirname(DOC_PATH),
      "../src/plugins/rbac/plugin.json",
    );
    const real: unknown = JSON.parse(readFileSync(rbacManifestPath, "utf8"));
    const documented = jsonBlocks.find((block) => {
      const parsed = JSON.parse(block) as { id?: string };
      return parsed.id === "rbac";
    });
    expect(documented).toBeDefined();
    expect(JSON.parse(documented as string)).toEqual(real);
  });

  it("the database-mysql example matches the real src/plugins/database-mysql/plugin.json", () => {
    const realManifestPath = path.resolve(
      path.dirname(DOC_PATH),
      "../src/plugins/database-mysql/plugin.json",
    );
    const real: unknown = JSON.parse(readFileSync(realManifestPath, "utf8"));
    const documented = jsonBlocks.find((block) => {
      const parsed = JSON.parse(block) as { id?: string };
      return parsed.id === "database-mysql";
    });
    expect(documented).toBeDefined();
    expect(JSON.parse(documented as string)).toEqual(real);
  });

  it("the greeter worked example provides exactly greet:hello and requires nothing", () => {
    const documented = jsonBlocks.find((block) => {
      const parsed = JSON.parse(block) as { id?: string };
      return parsed.id === "greeter";
    });
    expect(documented).toBeDefined();
    const parsed = JSON.parse(documented as string) as {
      capabilities: { provides: string[]; requires: string[] };
    };
    expect(parsed.capabilities.provides).toEqual(["greet:hello"]);
    expect(parsed.capabilities.requires).toEqual([]);
  });
});

describe("docs/ai-plugin-authoring.md — content sanity", () => {
  it("references both canonical plugins by name, per feature #78 step 2", () => {
    expect(docSource).toMatch(/\brbac\b/);
    expect(docSource).toMatch(/\bdatabase-mysql\b/);
  });

  it("documents the manifest shape's required fields", () => {
    for (const field of ["id", "version", "depends_on", "capabilities", "entry_point"]) {
      expect(docSource).toContain(`\`${field}\``);
    }
  });

  it("documents the forbidden cross-plugin import rule", () => {
    expect(docSource).toMatch(/must never import/i);
    expect(docSource).toMatch(/src\/plugins\/<other-id>/);
  });

  it("carries a doc validation log recording the feature #78 step 3 dry run", () => {
    expect(docSource).toMatch(/## Appendix: doc validation log/);
    expect(docSource).toMatch(/dry-run agent/i);
  });
});

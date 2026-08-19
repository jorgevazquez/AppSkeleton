/**
 * Unit tests for `src/plugins/wiki/src/diff.ts`'s `diffLines` (feature #94's
 * own minimal scope for the `diff` HTTP route — see that module's doc
 * comment) and `compileDiffTemplate` (feature #90 step 2 — safe rendering
 * through html-renderer). No database or capability plumbing required —
 * both are pure functions, matching this plugin's existing "zero-I/O logic
 * tested in isolation" precedent (`markdown.test.ts`, `page-tree.test.ts`).
 *
 * `compileDiffTemplate`'s own end-to-end "and therefore feature #47's
 * escaping actually applies, and an XSS payload is neutralized" claim is
 * covered separately, through the real capability broker and a real
 * `GET .../diff` HTTP round-trip, in
 * `tests/plugins/wiki/http-routes.integration.test.ts`'s "an XSS-style
 * payload in a revision's content is neutralized in the rendered HTML"
 * case — mirroring `markdown.test.ts`/`markdown-render.integration.test.ts`'s
 * own unit/integration split.
 */
import { describe, expect, it } from "vitest";
import { compileDiffTemplate, diffLines } from "../../../src/plugins/wiki/src/diff.js";

describe("diffLines", () => {
  it("returns every line as unchanged when the two inputs are identical", () => {
    const result = diffLines("alpha\nbeta\ngamma", "alpha\nbeta\ngamma");
    expect(result).toEqual([
      { type: "unchanged", value: "alpha" },
      { type: "unchanged", value: "beta" },
      { type: "unchanged", value: "gamma" },
    ]);
  });

  it("identifies a single changed line as one removal and one addition (feature #90's own required case)", () => {
    const result = diffLines(
      "line one\nline two\nline three",
      "line one\nline two changed\nline three",
    );
    expect(result).toEqual([
      { type: "unchanged", value: "line one" },
      { type: "removed", value: "line two" },
      { type: "added", value: "line two changed" },
      { type: "unchanged", value: "line three" },
    ]);
  });

  it("identifies a pure addition at the end", () => {
    const result = diffLines("alpha\nbeta", "alpha\nbeta\ngamma");
    expect(result).toEqual([
      { type: "unchanged", value: "alpha" },
      { type: "unchanged", value: "beta" },
      { type: "added", value: "gamma" },
    ]);
  });

  it("identifies a pure removal from the middle", () => {
    const result = diffLines("alpha\nbeta\ngamma", "alpha\ngamma");
    expect(result).toEqual([
      { type: "unchanged", value: "alpha" },
      { type: "removed", value: "beta" },
      { type: "unchanged", value: "gamma" },
    ]);
  });

  it("treats an entirely-replaced document as all-removed followed by all-added", () => {
    const result = diffLines("old content", "new content");
    expect(result).toEqual([
      { type: "removed", value: "old content" },
      { type: "added", value: "new content" },
    ]);
  });

  it("handles an empty before (everything added)", () => {
    const result = diffLines("", "alpha\nbeta");
    expect(result).toEqual([
      { type: "removed", value: "" },
      { type: "added", value: "alpha" },
      { type: "added", value: "beta" },
    ]);
  });

  it("handles an empty after (everything removed)", () => {
    const result = diffLines("alpha\nbeta", "");
    expect(result).toEqual([
      { type: "removed", value: "alpha" },
      { type: "removed", value: "beta" },
      { type: "added", value: "" },
    ]);
  });

  it("handles two empty strings", () => {
    expect(diffLines("", "")).toEqual([{ type: "unchanged", value: "" }]);
  });

  it("normalizes CRLF/CR/LF line endings the same way", () => {
    const result = diffLines("alpha\r\nbeta\rgamma", "alpha\nbeta\ngamma");
    expect(result).toEqual([
      { type: "unchanged", value: "alpha" },
      { type: "unchanged", value: "beta" },
      { type: "unchanged", value: "gamma" },
    ]);
  });

  it("is deterministic across repeated calls on the same inputs", () => {
    const before = "a\nb\nc\nd";
    const after = "a\nx\nc\ny";
    const first = diffLines(before, after);
    const second = diffLines(before, after);
    expect(second).toEqual(first);
  });
});

describe("compileDiffTemplate", () => {
  it("emits one fixed-class placeholder div per diff line, in order", () => {
    const lines = diffLines(
      "line one\nline two\nline three",
      "line one\nline two changed\nline three",
    );
    const { source, context } = compileDiffTemplate(lines);

    expect(source).toBe(
      '<div class="diff">' +
        '<div class="diff-line diff-unchanged">{{line0}}</div>' +
        '<div class="diff-line diff-removed">{{line1}}</div>' +
        '<div class="diff-line diff-added">{{line2}}</div>' +
        '<div class="diff-line diff-unchanged">{{line3}}</div>' +
        "</div>",
    );
    expect(context).toEqual({
      line0: "line one",
      line1: "line two",
      line2: "line two changed",
      line3: "line three",
    });
  });

  it("never splices a diffed line's own text into the template source (data, not a raw string)", () => {
    // The whole point of feature #90 step 2: a line that looks like markup
    // or template syntax must only ever appear as a {{lineN}} *context*
    // value, never concatenated into the *source* string itself — otherwise
    // it would be parsed as real template syntax rather than escaped data.
    const lines = diffLines(
      "safe",
      "<script>alert(1)</script>\n{{#each secrets}}{{this}}{{/each}}",
    );
    const { source, context } = compileDiffTemplate(lines);

    expect(source).not.toContain("<script>");
    expect(source).not.toContain("{{#each secrets}}");
    expect(Object.values(context)).toContain("<script>alert(1)</script>");
    expect(Object.values(context)).toContain("{{#each secrets}}{{this}}{{/each}}");
  });

  it("produces an empty diff div for two identical empty inputs", () => {
    const { source, context } = compileDiffTemplate(diffLines("", ""));
    expect(source).toBe(
      '<div class="diff"><div class="diff-line diff-unchanged">{{line0}}</div></div>',
    );
    expect(context).toEqual({ line0: "" });
  });
});

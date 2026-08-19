/**
 * Unit tests for `src/plugins/wiki/src/diff.ts`'s `diffLines` (feature #94's
 * own minimal scope for the `diff` HTTP route — see that module's doc
 * comment). No database or capability plumbing required — `diffLines` is a
 * pure function over two strings, matching this plugin's existing
 * "zero-I/O logic tested in isolation" precedent (`markdown.test.ts`,
 * `page-tree.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { diffLines } from "../../../src/plugins/wiki/src/diff.js";

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

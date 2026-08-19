/**
 * Pure, dependency-free line-based diff between two strings — feature #94's
 * ("Wiki HTTP routes via api-gateway") own minimal scope for the `diff`
 * HTTP route: a real, working implementation to register today, so
 * `GET /api/v1/wiki/pages/:id/diff` has something genuine to serve. The
 * dedicated feature #90 ("Diff view between two revisions") is expected to
 * build on this — e.g. rendering the result safely through html-renderer —
 * without needing to touch the algorithm itself.
 *
 * No I/O, no wiki-specific types — this module only ever sees two raw
 * strings (typically two `Revision.content`/`Page.content` values, see
 * `../index.ts`'s diff route handler) and returns a line-by-line edit
 * script. Kept standalone/pure specifically so it can be unit-tested with
 * hand-built fixtures, no database or capability plumbing required (the
 * same "zero-I/O logic tested in isolation" precedent `markdown.ts`'s
 * `parseMarkdown`/`page-tree.ts`'s `buildNamespaceTree` already set in this
 * plugin).
 */

/** Whether a line in the diff was present in both inputs, only the "before" side, or only the "after" side. */
export type DiffLineType = "unchanged" | "added" | "removed";

/** One line of a {@link diffLines} result. */
export interface DiffLine {
  readonly type: DiffLineType;
  readonly value: string;
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Line-based diff of `before` -> `after`, via the classic longest-common-
 * subsequence backtrack: an unchanged line is one that appears in the LCS
 * of both inputs' line arrays; everything else is either `removed` (only in
 * `before`) or `added` (only in `after`), interleaved in the order needed
 * to reconstruct `after` from `before`.
 *
 * O(before's line count * after's line count) time and space (a full DP
 * table) — fine for wiki-page-sized content (typically well under a few
 * thousand lines each); this is not intended for diffing very large
 * documents. Deterministic: when a line could equally be attributed to
 * either side at a given step (`lcs[i+1][j] === lcs[i][j+1]`), this always
 * prefers `removed` before `added`, so the same two inputs always produce
 * the exact same edit script.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const m = a.length;
  const n = b.length;

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      const nextRow = lcs[i + 1] as number[];
      row[j] =
        a[i] === b[j]
          ? (nextRow[j + 1] as number) + 1
          : Math.max(nextRow[j] as number, row[j + 1] as number);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      result.push({ type: "unchanged", value: a[i] as string });
      i++;
      j++;
    } else {
      const dropDown = (lcs[i + 1] as number[])[j] as number;
      const dropRight = (lcs[i] as number[])[j + 1] as number;
      if (dropDown >= dropRight) {
        result.push({ type: "removed", value: a[i] as string });
        i++;
      } else {
        result.push({ type: "added", value: b[j] as string });
        j++;
      }
    }
  }
  while (i < m) {
    result.push({ type: "removed", value: a[i] as string });
    i++;
  }
  while (j < n) {
    result.push({ type: "added", value: b[j] as string });
    j++;
  }
  return result;
}

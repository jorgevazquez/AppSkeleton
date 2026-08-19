/**
 * Pure, dependency-free line-based diff between two strings — feature #94's
 * ("Wiki HTTP routes via api-gateway") own minimal scope for the `diff`
 * HTTP route: a real, working implementation to register today, so
 * `GET /api/v1/wiki/pages/:id/diff` has something genuine to serve.
 *
 * Feature #90 ("Diff view between two revisions") builds directly on top of
 * that algorithm without touching it: {@link diffLines} (step 1, unchanged)
 * plus {@link renderDiffToHtml} (step 2 — a safe HTML rendering of a
 * {@link diffLines} result, via html-renderer's real `render:template`
 * capability).
 *
 * ## Step 2: safe rendering, the same "data, not a raw string" shape
 * `markdown.ts` already established
 *
 * A diff's line *values* are exactly as attacker-controlled as a page's
 * Markdown source is (`diffLines` is fed two `Revision.content`/
 * `Page.content` values — anyone who can create or edit a page controls
 * both). {@link renderDiffToHtml} therefore follows `markdown.ts`'s
 * `compileMarkdownTemplate`/`renderMarkdownToHtml` pattern exactly: it
 * builds an html-renderer template *source* string out of nothing but this
 * module's own fixed literal tag/class text (`<div class="diff-line
 * diff-added">`, ...) plus one `{{lineN}}` placeholder per diff line, and a
 * separate {@link TemplateContext} mapping each placeholder to that line's
 * raw, unescaped `value`. No diffed line value is ever concatenated into
 * the template source itself, so a line of content that happens to look
 * like `<script>...</script>` or `{{#each secrets}}...{{/each}}` can never
 * be interpreted as markup or template syntax — it only ever flows through
 * as an opaque `{{lineN}}` variable value, which html-renderer's compile-
 * time HTML-context scanner (`html-context.ts`) escapes with `escapeHtml`
 * the same way it would for any other template variable placed in a tag
 * body. This module supplies no escaping of its own, exactly like
 * `markdown.ts` — every safety property comes from feature #47's existing,
 * independently-tested auto-escaping machinery.
 */

import type { ValidationError } from "../../../core/errors.js";
import type { Result } from "../../../core/types.js";
import type { RenderTemplateCapability, TemplateContext } from "../../html-renderer/index.js";

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

// ---------------------------------------------------------------------------
// Step 2: diff -> html-renderer template source + data context
// ---------------------------------------------------------------------------

/**
 * Fixed, literal CSS class per {@link DiffLineType} — never derived from
 * diffed content, only ever from this closed union's three known member
 * values, so it is safe to splice directly into the template *source*
 * string (see this module's doc comment's "Step 2" section).
 */
const DIFF_LINE_CLASS: Record<DiffLineType, string> = {
  unchanged: "diff-line diff-unchanged",
  added: "diff-line diff-added",
  removed: "diff-line diff-removed",
};

/**
 * Convert a {@link diffLines} result into an html-renderer template source
 * (built entirely from this module's own fixed literal tag/class text) plus
 * a {@link TemplateContext} carrying every diffed line's raw text as a
 * `{{lineN}}` variable value. Mirrors `markdown.ts`'s
 * `compileMarkdownTemplate` — see this module's doc comment for why this
 * shape is what keeps a diffed line's content from ever being interpreted
 * as markup or template syntax.
 */
export function compileDiffTemplate(lines: readonly DiffLine[]): {
  readonly source: string;
  readonly context: TemplateContext;
} {
  const context: TemplateContext = {};

  const body = lines
    .map((line, index) => {
      const placeholder = `line${index}`;
      context[placeholder] = line.value;
      return `<div class="${DIFF_LINE_CLASS[line.type]}">{{${placeholder}}}</div>`;
    })
    .join("");

  return { source: `<div class="diff">${body}</div>`, context };
}

/**
 * Render a {@link diffLines} result to safe HTML through html-renderer's
 * real `render:template` capability (step 2). `render` is that
 * capability's own `render()` function — a caller obtains it via
 * `context.capabilities.obtain<RenderTemplateCapability>("render:template")`
 * and passes its `.render` method straight through, exactly like
 * `markdown.ts`'s `renderMarkdownToHtml` takes its `render` parameter
 * rather than reaching for a module-level singleton.
 *
 * Returns the same `Result<string, ValidationError>` shape `render()`
 * itself returns — in practice always `Ok`, since every template this
 * function generates is built from fixed, well-formed literal tag text
 * (see {@link compileDiffTemplate}), but the `Result` is still propagated
 * rather than unwrapped here so a caller never has to guess.
 */
export function renderDiffToHtml(
  lines: readonly DiffLine[],
  render: RenderTemplateCapability["render"],
): Result<string, ValidationError> {
  const { source, context } = compileDiffTemplate(lines);
  return render(source, context);
}

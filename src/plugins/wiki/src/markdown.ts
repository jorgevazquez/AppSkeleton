/**
 * Safe Markdown-to-HTML rendering for wiki page content (feature #88 —
 * "Markdown-to-HTML rendering via html-renderer's render:template").
 *
 * A wiki page's `content` column (see `./pages.ts`/`./types.ts`) is stored
 * as Markdown source, entirely attacker-controlled (anyone who can create
 * or edit a page writes it). This module turns that source into HTML that
 * is safe to send to a browser, using html-renderer's own `render:template`
 * capability (feature #52) to do the actual escaping — never a
 * hand-rolled escaper of this module's own.
 *
 * ## Step 1: a safe parser, no raw HTML passthrough
 *
 * {@link parseMarkdown} is a small, dependency-free block/inline Markdown
 * parser (headings, paragraphs, blockquotes, ordered/unordered lists,
 * fenced code blocks, thematic breaks; inline `**strong**`, `*emphasis*`,
 * `` `code` ``, `[link](url)`, `![image](url)`). It recognizes exactly
 * those constructs and nothing else — a literal `<script>`, `<img
 * onerror=...>`, or any other raw HTML tag typed into the source does not
 * match any of this grammar's productions, so it falls through to plain
 * inline text (an {@link MdTextNode}) like any other character run. There
 * is no "raw HTML block" or "inline HTML span" production in this
 * grammar — unlike CommonMark's default `html: true` behavior (and unlike
 * most off-the-shelf Markdown libraries, which pass raw HTML straight into
 * their output by default), this parser cannot emit a tag it did not
 * itself decide to emit.
 *
 * ## Step 1 (continued): fed into render:template as data, not a raw string
 *
 * {@link compileMarkdownTemplate} converts the parsed {@link MdBlockNode}
 * tree into two things: a small, *fixed* html-renderer template source
 * string built entirely out of this module's own literal tag text
 * (`<h1>`, `<p>`, `<a href="...">`, ...) plus `{{mdN}}` variable
 * placeholders — never out of the Markdown author's own text — and a
 * {@link TemplateContext} mapping each placeholder to the corresponding
 * raw (unescaped) piece of Markdown-author text (a paragraph's words, a
 * link's href, a code span's contents, ...). That template source is then
 * compiled and rendered through html-renderer's real `render:template`
 * capability ({@link renderMarkdownToHtml} takes its `render` function as
 * a parameter, exactly like `./pages.ts` takes its `db:query` handle —
 * this module never imports html-renderer's `src/` internals, only its
 * public `RenderTemplateCapability` type from `../../html-renderer/index.js`,
 * per `docs/plugin-conventions.md` section 5's type-only-import carve-out).
 *
 * This is the crux of "as data, not as a raw string": if a page's
 * Markdown source were instead concatenated directly into a template
 * *source* string and handed to `compileTemplate`, any `{{...}}`-shaped
 * text an author happened to type (accidentally, or as a deliberate
 * template-injection attempt — e.g. `{{#each secrets}}{{this}}{{/each}}`)
 * would be parsed and *executed* as real template syntax. Routing every
 * piece of author text through the context object instead means it is
 * only ever read back as an opaque string value by `{{mdN}}` — it can
 * never be interpreted as template markup, no matter what it contains.
 *
 * ## Step 2: feature #47's auto-escaping still applies
 *
 * Because every `{{mdN}}` placeholder is an ordinary template variable —
 * not a `{{{raw ...}}}` tag — html-renderer's compile-time HTML-context
 * scanner (`html-context.ts`) sees exactly the same fixed literal markup
 * this module emits and picks the matching escaper per feature #47's
 * rules with zero special-casing needed here: text inside a tag body
 * (paragraph/heading/emphasis/code text) is escaped with `escapeHtml`,
 * and a `{{mdN}}` placed inside `<a href="...">`/`<img src="...">` is
 * escaped with `escapeUrl` (which also rejects `javascript:`/`data:`/...
 * schemes outright) because the scanner recognizes `href`/`src` as
 * URL-bearing attributes the same way it would for any other template
 * author's markup. This module supplies no escaping of its own — every
 * safety property comes from feature #47's existing, independently-tested
 * machinery, applied to Markdown-author text exactly as it would be to
 * any other template variable.
 *
 * ## Deliberately out of scope
 *
 * This is not a CommonMark-conformant parser — no lazy paragraph
 * continuation across list items, no nested multi-paragraph list items, no
 * link reference definitions, no HTML entity decoding, no setext headings.
 * It covers the common Markdown authors actually reach for; extending the
 * grammar is a later feature's job if ever needed. What it does not
 * compromise on, ever, is safety: anything this parser doesn't recognize
 * as a specific construct is plain text, and all plain text is escaped.
 */
import type { ValidationError } from "../../../core/errors.js";
import type { Result } from "../../../core/types.js";
import type { RenderTemplateCapability, TemplateContext } from "../../html-renderer/index.js";

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export interface MdTextNode {
  readonly kind: "text";
  readonly value: string;
}
export interface MdCodeSpanNode {
  readonly kind: "code";
  readonly value: string;
}
export interface MdStrongNode {
  readonly kind: "strong";
  readonly children: readonly MdInlineNode[];
}
export interface MdEmphasisNode {
  readonly kind: "emphasis";
  readonly children: readonly MdInlineNode[];
}
export interface MdLinkNode {
  readonly kind: "link";
  readonly href: string;
  readonly children: readonly MdInlineNode[];
}
export interface MdImageNode {
  readonly kind: "image";
  readonly src: string;
  readonly alt: string;
}

/** Inline-level Markdown AST node — a run of formatted text within a block. */
export type MdInlineNode =
  MdTextNode | MdCodeSpanNode | MdStrongNode | MdEmphasisNode | MdLinkNode | MdImageNode;

export interface MdHeadingNode {
  readonly kind: "heading";
  /** 1-6, from the number of leading `#` characters. */
  readonly level: number;
  readonly children: readonly MdInlineNode[];
}
export interface MdParagraphNode {
  readonly kind: "paragraph";
  readonly children: readonly MdInlineNode[];
}
export interface MdBlockquoteNode {
  readonly kind: "blockquote";
  readonly children: readonly MdBlockNode[];
}
export interface MdListNode {
  readonly kind: "list";
  readonly ordered: boolean;
  /** Each item's inline content. A single-line-per-item model — see module doc's "Deliberately out of scope". */
  readonly items: readonly (readonly MdInlineNode[])[];
}
export interface MdCodeBlockNode {
  readonly kind: "codeBlock";
  readonly value: string;
  readonly lang?: string;
}
export interface MdThematicBreakNode {
  readonly kind: "thematicBreak";
}

/** Block-level Markdown AST node — the top-level shape {@link parseMarkdown} returns a list of. */
export type MdBlockNode =
  | MdHeadingNode
  | MdParagraphNode
  | MdBlockquoteNode
  | MdListNode
  | MdCodeBlockNode
  | MdThematicBreakNode;

// ---------------------------------------------------------------------------
// Inline parser
// ---------------------------------------------------------------------------

/** ASCII punctuation `\x` may escape to a literal `x` (CommonMark's escapable-punctuation set, the common subset). */
const ESCAPABLE_PATTERN = /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/;

interface DelimitedMatch {
  readonly text: string;
  readonly url: string;
  readonly end: number;
}

/**
 * `text[i]` must be `"["`. Tries to parse a `[label](url)` span starting
 * there (no nested `[`/`(` support — the first matching `]`/`)` wins,
 * which covers ordinary usage without a full bracket-matching parser).
 * Returns `undefined` if the shape doesn't hold (unclosed `[`, no `(url)`
 * immediately following), so the caller falls back to treating `[` as a
 * literal character.
 */
function parseLinkSpan(text: string, i: number): DelimitedMatch | undefined {
  const closeBracket = text.indexOf("]", i + 1);
  if (closeBracket === -1 || text.charAt(closeBracket + 1) !== "(") {
    return undefined;
  }
  const closeParen = text.indexOf(")", closeBracket + 2);
  if (closeParen === -1) {
    return undefined;
  }
  return {
    text: text.slice(i + 1, closeBracket),
    url: text.slice(closeBracket + 2, closeParen).trim(),
    end: closeParen + 1,
  };
}

/** Find the closing single-character emphasis marker for an opening one at `start`. Rejects an empty span. */
function findEmphasisEnd(text: string, start: number, marker: string): number {
  const end = text.indexOf(marker, start);
  return end > start ? end : -1;
}

/**
 * Parse `text` (already isolated to a single logical line/paragraph — no
 * block-level structure left to find) into inline nodes. Recognizes
 * backslash escapes, `` `code` `` spans, `**strong**`/`__strong__`,
 * `*emphasis*`/`_emphasis_`, `![alt](src)` images, and `[text](href)`
 * links; everything else — including any literal `<...>` HTML-looking
 * text — becomes plain {@link MdTextNode} text (see module doc's "no raw
 * HTML passthrough" section).
 */
export function parseInline(text: string): MdInlineNode[] {
  const nodes: MdInlineNode[] = [];
  let buffer = "";
  let i = 0;

  function flush(): void {
    if (buffer.length > 0) {
      nodes.push({ kind: "text", value: buffer });
      buffer = "";
    }
  }

  while (i < text.length) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);

    if (ch === "\\" && ESCAPABLE_PATTERN.test(next)) {
      buffer += next;
      i += 2;
      continue;
    }

    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        nodes.push({ kind: "code", value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if ((ch === "*" || ch === "_") && next === ch) {
      const marker = ch + ch;
      const end = text.indexOf(marker, i + 2);
      if (end !== -1 && end > i + 2) {
        flush();
        nodes.push({ kind: "strong", children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      const end = findEmphasisEnd(text, i + 1, ch);
      if (end !== -1) {
        flush();
        nodes.push({ kind: "emphasis", children: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    if (ch === "!" && next === "[") {
      const span = parseLinkSpan(text, i + 1);
      if (span !== undefined) {
        flush();
        nodes.push({ kind: "image", src: span.url, alt: span.text });
        i = span.end;
        continue;
      }
    }

    if (ch === "[") {
      const span = parseLinkSpan(text, i);
      if (span !== undefined) {
        flush();
        nodes.push({ kind: "link", href: span.url, children: parseInline(span.text) });
        i = span.end;
        continue;
      }
    }

    buffer += ch;
    i++;
  }

  flush();
  return nodes;
}

// ---------------------------------------------------------------------------
// Block parser
// ---------------------------------------------------------------------------

const BLANK_LINE_PATTERN = /^\s*$/;
const HEADING_PATTERN = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)[ \t]*$/;
const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const BLOCKQUOTE_PATTERN = /^ {0,3}>[ \t]?(.*)$/;
const UNORDERED_LIST_PATTERN = /^ {0,3}[-*+][ \t]+(.*)$/;
const ORDERED_LIST_PATTERN = /^ {0,3}\d+[.)][ \t]+(.*)$/;
const THEMATIC_BREAK_PATTERN = /^(-{3,}|\*{3,}|_{3,})$/;

function isThematicBreak(line: string): boolean {
  const collapsed = line.trim().replace(/[ \t]+/g, "");
  return collapsed.length >= 3 && THEMATIC_BREAK_PATTERN.test(collapsed);
}

/** Whether `line` opens some other block type — used to stop a lazily-collected paragraph before it swallows the next block. */
function startsNewBlock(line: string): boolean {
  return (
    BLANK_LINE_PATTERN.test(line) ||
    isThematicBreak(line) ||
    HEADING_PATTERN.test(line) ||
    FENCE_OPEN_PATTERN.test(line) ||
    BLOCKQUOTE_PATTERN.test(line) ||
    UNORDERED_LIST_PATTERN.test(line) ||
    ORDERED_LIST_PATTERN.test(line)
  );
}

/** Parse a flat line array into a block-node tree. Recurses for blockquote contents. */
function parseBlockLines(lines: readonly string[]): MdBlockNode[] {
  const blocks: MdBlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (BLANK_LINE_PATTERN.test(line)) {
      i++;
      continue;
    }

    if (isThematicBreak(line)) {
      blocks.push({ kind: "thematicBreak" });
      i++;
      continue;
    }

    const headingMatch = HEADING_PATTERN.exec(line);
    if (headingMatch) {
      const marker = headingMatch[1] ?? "#";
      const text = (headingMatch[2] ?? "").trim();
      blocks.push({ kind: "heading", level: marker.length, children: parseInline(text) });
      i++;
      continue;
    }

    const fenceOpenMatch = FENCE_OPEN_PATTERN.exec(line);
    if (fenceOpenMatch) {
      const fenceChar = (fenceOpenMatch[1] ?? "`").charAt(0);
      const fenceLen = (fenceOpenMatch[1] ?? "`").length;
      const lang = fenceOpenMatch[2];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const candidate = lines[i] ?? "";
        const closeMatch = FENCE_CLOSE_PATTERN.exec(candidate);
        const closeFence = closeMatch?.[1] ?? "";
        if (closeFence.charAt(0) === fenceChar && closeFence.length >= fenceLen) {
          i++;
          break;
        }
        codeLines.push(candidate);
        i++;
      }
      blocks.push({
        kind: "codeBlock",
        value: codeLines.join("\n"),
        ...(lang !== undefined && lang.length > 0 ? { lang } : {}),
      });
      continue;
    }

    if (BLOCKQUOTE_PATTERN.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const match = BLOCKQUOTE_PATTERN.exec(lines[i] ?? "");
        if (!match) {
          break;
        }
        inner.push(match[1] ?? "");
        i++;
      }
      blocks.push({ kind: "blockquote", children: parseBlockLines(inner) });
      continue;
    }

    if (UNORDERED_LIST_PATTERN.test(line) || ORDERED_LIST_PATTERN.test(line)) {
      const ordered = ORDERED_LIST_PATTERN.test(line);
      const pattern = ordered ? ORDERED_LIST_PATTERN : UNORDERED_LIST_PATTERN;
      const items: (readonly MdInlineNode[])[] = [];
      while (i < lines.length) {
        const match = pattern.exec(lines[i] ?? "");
        if (!match) {
          break;
        }
        items.push(parseInline(match[1] ?? ""));
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (i < lines.length && !startsNewBlock(lines[i] ?? "")) {
      paragraphLines.push(lines[i] ?? "");
      i++;
    }
    if (paragraphLines.length === 0) {
      // Defensive: every branch above already consumes any line matching
      // startsNewBlock, so this is unreachable in practice — but guards
      // against an infinite loop rather than assuming that invariant holds.
      paragraphLines.push(line);
      i++;
    }
    blocks.push({ kind: "paragraph", children: parseInline(paragraphLines.join(" ")) });
  }

  return blocks;
}

/**
 * Parse Markdown `source` into a block-node AST. See the module doc's
 * "Step 1" section for the safety guarantee this grammar provides (no
 * production for raw HTML — anything unrecognized is plain text).
 */
export function parseMarkdown(source: string): MdBlockNode[] {
  return parseBlockLines(source.split(/\r\n|\r|\n/));
}

// ---------------------------------------------------------------------------
// AST -> html-renderer template source + data context
// ---------------------------------------------------------------------------

/** What {@link compileMarkdownTemplate} produces: an html-renderer template source and the data context to render it with. */
export interface MarkdownTemplate {
  readonly source: string;
  readonly context: TemplateContext;
}

/**
 * Convert a parsed Markdown AST into an html-renderer template source
 * (built entirely from this module's own fixed literal tag text) plus a
 * {@link TemplateContext} carrying every piece of Markdown-author text as
 * a `{{mdN}}` variable value. See the module doc's "Step 1 (continued)"
 * and "Step 2" sections for why this shape is what makes feature #47's
 * auto-escaping apply automatically, with zero escaping logic here.
 */
export function compileMarkdownTemplate(blocks: readonly MdBlockNode[]): MarkdownTemplate {
  const context: TemplateContext = {};
  let counter = 0;

  function placeholder(value: string): string {
    const name = `md${counter}`;
    counter++;
    context[name] = value;
    return `{{${name}}}`;
  }

  function renderInline(nodes: readonly MdInlineNode[]): string {
    return nodes.map(renderInlineNode).join("");
  }

  function renderInlineNode(node: MdInlineNode): string {
    switch (node.kind) {
      case "text":
        return placeholder(node.value);
      case "code":
        return `<code>${placeholder(node.value)}</code>`;
      case "strong":
        return `<strong>${renderInline(node.children)}</strong>`;
      case "emphasis":
        return `<em>${renderInline(node.children)}</em>`;
      case "link":
        return `<a href="${placeholder(node.href)}">${renderInline(node.children)}</a>`;
      case "image":
        return `<img src="${placeholder(node.src)}" alt="${placeholder(node.alt)}">`;
    }
  }

  function renderBlock(node: MdBlockNode): string {
    switch (node.kind) {
      case "heading": {
        const tag = `h${node.level}`;
        return `<${tag}>${renderInline(node.children)}</${tag}>`;
      }
      case "paragraph":
        return `<p>${renderInline(node.children)}</p>`;
      case "blockquote":
        return `<blockquote>${node.children.map(renderBlock).join("")}</blockquote>`;
      case "list": {
        const tag = node.ordered ? "ol" : "ul";
        const items = node.items.map((item) => `<li>${renderInline(item)}</li>`).join("");
        return `<${tag}>${items}</${tag}>`;
      }
      case "codeBlock": {
        const codePlaceholder = placeholder(node.value);
        if (node.lang !== undefined) {
          const langPlaceholder = placeholder(node.lang);
          return `<pre><code class="language-${langPlaceholder}">${codePlaceholder}</code></pre>`;
        }
        return `<pre><code>${codePlaceholder}</code></pre>`;
      }
      case "thematicBreak":
        return "<hr>";
    }
  }

  const source = blocks.map(renderBlock).join("");
  return { source, context };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse `markdown` and render it to safe HTML through html-renderer's real
 * `render:template` capability. `render` is that capability's own
 * `render()` function (see `RenderTemplateCapability` in
 * `../../html-renderer/index.ts`) — a caller obtains it via
 * `context.capabilities.obtain<RenderTemplateCapability>("render:template")`
 * and passes its `.render` method straight through, exactly like
 * `./pages.ts`'s `createWikiPagesStore` takes its `db:query` handle as a
 * parameter rather than reaching for a module-level singleton.
 *
 * Returns the same `Result<string, ValidationError>` shape `render()`
 * itself returns — in practice always `Ok`, since every template this
 * module generates is built from fixed, well-formed literal tag text (see
 * {@link compileMarkdownTemplate}), but the `Result` is still propagated
 * rather than unwrapped here so a caller never has to guess.
 */
export function renderMarkdownToHtml(
  markdown: string,
  render: RenderTemplateCapability["render"],
): Result<string, ValidationError> {
  const { source, context } = compileMarkdownTemplate(parseMarkdown(markdown));
  return render(source, context);
}

/**
 * Unit tests for `markdown.ts`'s pure parser and template-generation layer
 * (feature #88, step 1 — "Implement a safe Markdown parser ... producing
 * an AST or HTML string fed into render:template as data, not as a raw
 * string").
 *
 * These tests never touch html-renderer at all — they only exercise
 * `parseMarkdown`/`parseInline` (the AST) and `compileMarkdownTemplate`
 * (the AST -> template-source + data-context conversion), proving the two
 * safety properties this module's design rests on entirely with plain
 * data assertions:
 *
 *   1. A literal `<...>`-shaped run of text in Markdown source never
 *      becomes a real AST tag node — it is always plain `MdTextNode` text
 *      (no raw-HTML-passthrough production exists in the grammar).
 *   2. Every piece of Markdown-author text ends up as a `{{mdN}}`
 *      placeholder's *context value*, never spliced into the generated
 *      template *source* string itself — so `source` never contains the
 *      author's own text verbatim, only this module's own fixed tag
 *      shapes and placeholder tokens.
 *
 * The end-to-end "and therefore feature #47's escaping actually applies,
 * and an XSS payload is neutralized" claim is covered separately in
 * `markdown-render.integration.test.ts`, which drives real compiled
 * html-renderer output through the real capability broker.
 */
import { describe, expect, it } from "vitest";
import {
  compileMarkdownTemplate,
  parseInline,
  parseMarkdown,
  type MdBlockNode,
} from "../../../src/plugins/wiki/src/markdown.js";

describe("parseInline", () => {
  it("parses plain text as a single text node", () => {
    expect(parseInline("hello world")).toEqual([{ kind: "text", value: "hello world" }]);
  });

  it("parses **strong** and *emphasis*", () => {
    expect(parseInline("**bold**")).toEqual([
      { kind: "strong", children: [{ kind: "text", value: "bold" }] },
    ]);
    expect(parseInline("*italic*")).toEqual([
      { kind: "emphasis", children: [{ kind: "text", value: "italic" }] },
    ]);
    expect(parseInline("__bold__")).toEqual([
      { kind: "strong", children: [{ kind: "text", value: "bold" }] },
    ]);
    expect(parseInline("_italic_")).toEqual([
      { kind: "emphasis", children: [{ kind: "text", value: "italic" }] },
    ]);
  });

  it("parses an inline code span verbatim, with no nested inline parsing inside it", () => {
    expect(parseInline("`*not emphasis*`")).toEqual([{ kind: "code", value: "*not emphasis*" }]);
  });

  it("parses a link", () => {
    expect(parseInline("[click me](https://example.com/x)")).toEqual([
      {
        kind: "link",
        href: "https://example.com/x",
        children: [{ kind: "text", value: "click me" }],
      },
    ]);
  });

  it("parses an image", () => {
    expect(parseInline("![alt text](https://example.com/x.png)")).toEqual([
      { kind: "image", src: "https://example.com/x.png", alt: "alt text" },
    ]);
  });

  it("honors a backslash escape for markdown-significant punctuation", () => {
    expect(parseInline("\\*not emphasis\\*")).toEqual([{ kind: "text", value: "*not emphasis*" }]);
  });

  it("treats an unmatched delimiter as literal text rather than throwing", () => {
    expect(parseInline("a * b")).toEqual([{ kind: "text", value: "a * b" }]);
    expect(parseInline("[no closing paren")).toEqual([
      { kind: "text", value: "[no closing paren" },
    ]);
  });

  describe("no raw HTML passthrough (step 1)", () => {
    it("treats a literal <script> tag in the source as plain text, never a distinct node", () => {
      const nodes = parseInline("hello <script>alert(1)</script> world");
      expect(nodes).toEqual([{ kind: "text", value: "hello <script>alert(1)</script> world" }]);
    });

    it("treats an <img onerror=...> payload as plain text", () => {
      const nodes = parseInline('<img src=x onerror="alert(1)">');
      expect(nodes).toEqual([{ kind: "text", value: '<img src=x onerror="alert(1)">' }]);
    });
  });
});

describe("parseMarkdown (block level)", () => {
  it("parses an ATX heading", () => {
    expect(parseMarkdown("## Hello")).toEqual<MdBlockNode[]>([
      { kind: "heading", level: 2, children: [{ kind: "text", value: "Hello" }] },
    ]);
  });

  it("parses a paragraph made of consecutive non-blank lines, joined with a space", () => {
    expect(parseMarkdown("line one\nline two")).toEqual<MdBlockNode[]>([
      { kind: "paragraph", children: [{ kind: "text", value: "line one line two" }] },
    ]);
  });

  it("parses a blank-line-separated pair of paragraphs as two blocks", () => {
    const blocks = parseMarkdown("first\n\nsecond");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ kind: "paragraph", children: [{ kind: "text", value: "first" }] });
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      children: [{ kind: "text", value: "second" }],
    });
  });

  it("parses an unordered and an ordered list", () => {
    expect(parseMarkdown("- a\n- b")).toEqual<MdBlockNode[]>([
      {
        kind: "list",
        ordered: false,
        items: [[{ kind: "text", value: "a" }], [{ kind: "text", value: "b" }]],
      },
    ]);
    expect(parseMarkdown("1. a\n2. b")).toEqual<MdBlockNode[]>([
      {
        kind: "list",
        ordered: true,
        items: [[{ kind: "text", value: "a" }], [{ kind: "text", value: "b" }]],
      },
    ]);
  });

  it("parses a blockquote, recursing into its own contents", () => {
    expect(parseMarkdown("> quoted text")).toEqual<MdBlockNode[]>([
      {
        kind: "blockquote",
        children: [{ kind: "paragraph", children: [{ kind: "text", value: "quoted text" }] }],
      },
    ]);
  });

  it("parses a thematic break", () => {
    expect(parseMarkdown("---")).toEqual<MdBlockNode[]>([{ kind: "thematicBreak" }]);
  });

  it("parses a fenced code block, capturing an optional language and leaving the body unparsed", () => {
    const source = ["```js", "const x = 1;", "**not bold**", "```"].join("\n");
    expect(parseMarkdown(source)).toEqual<MdBlockNode[]>([
      { kind: "codeBlock", value: "const x = 1;\n**not bold**", lang: "js" },
    ]);
  });

  it("stops a paragraph before the next block instead of swallowing it", () => {
    const blocks = parseMarkdown("a paragraph\n# then a heading");
    expect(blocks).toEqual<MdBlockNode[]>([
      { kind: "paragraph", children: [{ kind: "text", value: "a paragraph" }] },
      { kind: "heading", level: 1, children: [{ kind: "text", value: "then a heading" }] },
    ]);
  });
});

describe("compileMarkdownTemplate (step 1: data, not a raw string)", () => {
  it("turns a paragraph's text into a placeholder tag whose value lives only in the context", () => {
    const { source, context } = compileMarkdownTemplate(parseMarkdown("hello world"));
    expect(source).toBe("<p>{{md0}}</p>");
    expect(context).toEqual({ md0: "hello world" });
  });

  it("places link text and href into separate placeholders, href inside the href attribute", () => {
    const { source, context } = compileMarkdownTemplate(
      parseMarkdown("[click me](https://example.com/x)"),
    );
    expect(source).toBe('<p><a href="{{md0}}">{{md1}}</a></p>');
    expect(context).toEqual({ md0: "https://example.com/x", md1: "click me" });
  });

  it("never embeds the author's own text verbatim in the generated source, even when it looks like template syntax", () => {
    const payload = "{{#each secrets}}{{this}}{{/each}}";
    const { source, context } = compileMarkdownTemplate(parseMarkdown(payload));
    expect(source).not.toContain("secrets");
    expect(source).not.toContain("#each");
    expect(source).toBe("<p>{{md0}}</p>");
    expect(context).toEqual({ md0: payload });
  });

  it("never embeds raw-HTML-looking Markdown text verbatim in the generated source", () => {
    const payload = "<script>alert(1)</script>";
    const { source, context } = compileMarkdownTemplate(parseMarkdown(payload));
    expect(source).not.toContain("<script>");
    expect(source).toBe("<p>{{md0}}</p>");
    expect(context).toEqual({ md0: payload });
  });

  it("renders headings, lists, blockquotes, and code blocks with the expected fixed structure", () => {
    const source = [
      "# Title",
      "",
      "- one",
      "- two",
      "",
      "> quoted",
      "",
      "```",
      "code()",
      "```",
    ].join("\n");
    const { source: templateSource, context } = compileMarkdownTemplate(parseMarkdown(source));
    expect(templateSource).toBe(
      "<h1>{{md0}}</h1>" +
        "<ul><li>{{md1}}</li><li>{{md2}}</li></ul>" +
        "<blockquote><p>{{md3}}</p></blockquote>" +
        "<pre><code>{{md4}}</code></pre>",
    );
    expect(context).toEqual({
      md0: "Title",
      md1: "one",
      md2: "two",
      md3: "quoted",
      md4: "code()",
    });
  });
});

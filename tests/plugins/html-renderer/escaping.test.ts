/**
 * Integration tests for feature #47 ("Context-aware auto-escaping") through
 * the public `compileTemplate`/`render` API — i.e. what a template author
 * actually sees, not the internal escaper/scanner units (see escape.test.ts
 * for those). Covers: (1) each of the four contexts picks the escaper the
 * doc comment promises, (2) there is no template syntax to opt out of
 * escaping, and (3) adversarial payloads (`<script>`, `" onmouseover=`,
 * `javascript:` URLs) come out inert in every context.
 */
import { describe, expect, it } from "vitest";
import { unwrap } from "../../../src/core/types.js";
import { escapeAttr } from "../../../src/plugins/html-renderer/src/escape.js";
import { compileTemplate } from "../../../src/plugins/html-renderer/src/template.js";

function render(source: string, context?: Record<string, unknown>): string {
  const compiled = unwrap(compileTemplate(source));
  return compiled.render(context);
}

const SCRIPT_PAYLOAD = "<script>alert(1)</script>";
const ATTR_BREAKOUT_PAYLOAD = `" onmouseover="alert(1)`;
const JS_URL_PAYLOAD = "javascript:alert(1)";

describe("HTML body context", () => {
  it("escapes a <script> payload interpolated as plain body text", () => {
    const out = render("<div>{{x}}</div>", { x: SCRIPT_PAYLOAD });
    expect(out).toBe("<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>");
    expect(out).not.toContain("<script>");
  });

  it("escapes an attribute-breakout payload interpolated as plain body text", () => {
    const out = render("<p>{{x}}</p>", { x: ATTR_BREAKOUT_PAYLOAD });
    expect(out).not.toContain('"');
    expect(out).toContain("&quot;");
  });

  it("escapes text at the top level with no surrounding tag", () => {
    const out = render("hello {{x}}", { x: "<b>bold</b>" });
    expect(out).toBe("hello &lt;b&gt;bold&lt;/b&gt;");
  });

  it("escapes text inside a conditional's consequent branch", () => {
    const out = render("<div>{{#if show}}{{x}}{{/if}}</div>", {
      show: true,
      x: SCRIPT_PAYLOAD,
    });
    expect(out).not.toContain("<script>");
  });

  it("escapes text inside an each loop body", () => {
    const out = render("<ul>{{#each items}}<li>{{this}}</li>{{/each}}</ul>", {
      items: [SCRIPT_PAYLOAD],
    });
    expect(out).toBe("<ul><li>&lt;script&gt;alert(1)&lt;/script&gt;</li></ul>");
  });
});

describe("HTML attribute context", () => {
  it("escapes a value in a double-quoted attribute", () => {
    const out = render(`<div title="{{x}}">body</div>`, { x: ATTR_BREAKOUT_PAYLOAD });
    expect(out).not.toContain('" onmouseover="');
    // Reparsing risk: the reconstructed markup must not gain a new onmouseover attribute.
    expect(out).not.toMatch(/onmouseover\s*=\s*"alert/);
  });

  it("escapes a value in a single-quoted attribute", () => {
    const out = render(`<div title='{{x}}'>body</div>`, {
      x: `' onmouseover='alert(1)`,
    });
    expect(out).not.toMatch(/onmouseover\s*=\s*'alert/);
  });

  it("escapes a value in an unquoted attribute", () => {
    const out = render(`<div title={{x}}>body</div>`, { x: "x onmouseover=alert(1)" });
    expect(out).not.toContain(" onmouseover=alert(1)");
  });

  it("escapes a <script> payload placed in an attribute value", () => {
    const out = render(`<div title="{{x}}">body</div>`, { x: SCRIPT_PAYLOAD });
    expect(out).not.toContain("<script>");
  });

  it("does not affect a second, later attribute in the same tag", () => {
    const out = render(`<a title="{{x}}" data-id="7">t</a>`, { x: "safe" });
    expect(out).toBe(`<a title="safe" data-id="7">t</a>`);
  });

  it("escapes an attribute value that follows another already-closed attribute", () => {
    const out = render(`<a data-id="7" title="{{x}}">t</a>`, {
      x: ATTR_BREAKOUT_PAYLOAD,
    });
    expect(out).not.toMatch(/onmouseover\s*=\s*"alert/);
  });

  it("treats an ordinary (non-url, non-event) attribute as attribute context, not URL context", () => {
    // A javascript: string is not itself dangerous in a plain (non-executing) attribute —
    // it should come through attribute-escaped, not blocked/replaced like the "url" escaper would.
    const out = render(`<div title="{{x}}">t</div>`, { x: JS_URL_PAYLOAD });
    expect(out).toContain("javascript");
    expect(out).not.toContain("about:invalid");
  });
});

describe("URL attribute context", () => {
  it("passes through a safe https URL in href (escaped for the attribute, not blocked)", () => {
    const out = render(`<a href="{{x}}">link</a>`, { x: "https://example.com/page" });
    expect(out).toBe(`<a href="${escapeAttr("https://example.com/page")}">link</a>`);
    // Not rejected as a dangerous scheme: none of the letters of the blocked-URL placeholder appear.
    expect(out).not.toContain("blocked");
  });

  it("blocks a javascript: URL in href", () => {
    const out = render(`<a href="{{x}}">link</a>`, { x: JS_URL_PAYLOAD });
    // The scheme is rejected outright and replaced by a placeholder before attribute-escaping —
    // none of the original payload's letters (which attribute-escaping would otherwise preserve
    // verbatim, since it only encodes non-alphanumeric characters) survive.
    expect(out).not.toContain("javascript");
    expect(out).not.toContain("alert");
  });

  it("blocks a javascript: URL in src", () => {
    const out = render(`<img src="{{x}}">`, { x: JS_URL_PAYLOAD });
    expect(out).not.toContain("javascript");
    expect(out).not.toContain("alert");
  });

  it("blocks an obfuscated javascript: URL (embedded tab) in href", () => {
    const out = render(`<a href="{{x}}">link</a>`, { x: "java\tscript:alert(1)" });
    expect(out).not.toContain("alert");
  });

  it("blocks a data: URL in href", () => {
    const out = render(`<a href="{{x}}">link</a>`, {
      x: "data:text/html,<script>alert(1)</script>",
    });
    expect(out).not.toContain("alert");
  });

  it("still neutralizes quote-breakout characters in an otherwise-safe URL", () => {
    const out = render(`<a href="{{x}}">link</a>`, {
      x: `https://example.com/?x=1" onmouseover="alert(1)`,
    });
    // The payload's embedded `"` must not survive as a real quote character — only the
    // template's own two literal quotes (opening and closing the href attribute) may remain.
    expect(out.split('"').length - 1).toBe(2);
    expect(out).not.toMatch(/onmouseover\s*=\s*"alert/);
    // The URL's own safe characters (letters/digits) still make it through, attribute-escaped.
    expect(out).toContain(escapeAttr("https://example.com/?x=1"));
  });

  it("passes through a relative URL in href (escaped for the attribute, not blocked)", () => {
    const out = render(`<a href="{{x}}">link</a>`, { x: "/account/settings" });
    expect(out).toBe(`<a href="${escapeAttr("/account/settings")}">link</a>`);
  });

  it("applies URL escaping in an unquoted href attribute too", () => {
    const out = render(`<a href={{x}}>link</a>`, { x: JS_URL_PAYLOAD });
    expect(out).not.toContain("javascript");
    expect(out).not.toContain("alert");
  });

  it("applies URL escaping to src but not to an unrelated attribute in the same tag", () => {
    const out = render(`<img src="{{u}}" alt="{{a}}">`, {
      u: JS_URL_PAYLOAD,
      a: "a photo",
    });
    // "alt" is plain attribute context: attribute-escaped (letters/digits kept, space encoded),
    // not URL-checked — its safe text isn't blocked or scheme-validated.
    expect(out).toContain(`alt="${escapeAttr("a photo")}"`);
    expect(out).not.toContain("javascript");
    expect(out).not.toContain("alert");
  });
});

describe("JS context: <script> body", () => {
  it("escapes a value interpolated inside a <script> block", () => {
    const out = render(`<script>var x = "{{x}}";</script>`, { x: `'; alert(1); '` });
    expect(out).not.toContain(`'; alert(1); '`);
    expect(out).toContain('var x = "');
  });

  it("neutralizes a </script> breakout attempt inside a <script> block", () => {
    const out = render(`<script>var x = "{{x}}";</script>`, {
      x: `</script><script>alert(1)</script>`,
    });
    expect(out).not.toContain("</script><script>");
    // Exactly one real </script> close tag should remain — the one from the template itself.
    expect(out.match(/<\/script>/g)?.length).toBe(1);
  });

  it("neutralizes a quote-breakout payload inside a <script> block", () => {
    const out = render(`<script>var x = "{{x}}";</script>`, { x: ATTR_BREAKOUT_PAYLOAD });
    expect(out).not.toContain('" onmouseover="');
  });

  it("neutralizes a javascript: URL used as a JS string value inside <script>", () => {
    const out = render(`<script>var x = "{{x}}";</script>`, { x: JS_URL_PAYLOAD });
    expect(out).not.toContain("javascript:alert(1)");
  });
});

describe("JS context: inline event-handler attributes", () => {
  it("escapes a value inside an onclick attribute", () => {
    const out = render(`<button onclick="go('{{x}}')">go</button>`, {
      x: `'); alert(1); //`,
    });
    expect(out).not.toContain(`'); alert(1);`);
  });

  it("neutralizes a quote-breakout payload inside onmouseover", () => {
    const out = render(`<div onmouseover="handle('{{x}}')">hover</div>`, {
      x: ATTR_BREAKOUT_PAYLOAD,
    });
    expect(out).not.toContain('" onmouseover="');
  });

  it("neutralizes a <script> tag placed inside an onload attribute", () => {
    const out = render(`<body onload="init('{{x}}')">`, { x: SCRIPT_PAYLOAD });
    expect(out).not.toContain("<script>");
  });

  it("does not treat a non-'on'-prefixed attribute as an event handler", () => {
    // "one" starts with "on" as a substring coincidence only if not careful; make sure
    // an attribute that merely contains "on" isn't misidentified as an event handler.
    const out = render(`<div data-onething="{{x}}">t</div>`, { x: `<b>` });
    // Should be escaped as plain "attr" context (HTML entities), not JS-escaped (\xHH).
    expect(out).toContain("&#x3C;");
    expect(out).not.toContain("\\x3C");
  });
});

describe("no opt-out: every interpolation is escaped", () => {
  it("has no raw/unescaped-output template syntax — {{{x}}} is parsed as text plus a normal {{x}} tag", () => {
    // There is no triple-brace or other raw-output helper in this compiler (feature #50 is a
    // separate, not-yet-implemented feature); {{{x}}} must still come out escaped.
    const out = render("{{{x}}}", { x: "<b>" });
    expect(out).toContain("&lt;b&gt;");
    expect(out).not.toContain("<b>");
  });

  it("escapes every occurrence when the same variable appears in multiple contexts", () => {
    const out = render(`<div title="{{x}}">{{x}}</div>`, { x: SCRIPT_PAYLOAD });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;"); // body context
    expect(out).toContain("&#x3C;script"); // attribute context
  });

  it("escapes numbers, booleans, and other non-string values the same as strings would be", () => {
    expect(render("<div>{{n}}</div>", { n: 42 })).toBe("<div>42</div>");
    expect(render("<div>{{t}}</div>", { t: true })).toBe("<div>true</div>");
  });
});

describe("context detection across nested/sibling structure", () => {
  it("resumes HTML body context correctly after a closed attribute value", () => {
    const out = render(`<a href="{{u}}">{{label}}</a>`, {
      u: "https://example.com",
      label: SCRIPT_PAYLOAD,
    });
    expect(out).toBe(
      `<a href="${escapeAttr("https://example.com")}">&lt;script&gt;alert(1)&lt;/script&gt;</a>`,
    );
  });

  it("resumes HTML body context correctly after a <script> block closes", () => {
    const out = render(`<script>var x = 1;</script><div>{{x}}</div>`, { x: SCRIPT_PAYLOAD });
    expect(out).toContain("<div>&lt;script&gt;");
  });

  it("applies the right context independently to each interpolation in a loop of objects", () => {
    const source = `<ul>{{#each links}}<li><a href="{{url}}">{{label}}</a></li>{{/each}}</ul>`;
    const out = render(source, {
      links: [
        { url: "https://good.example/", label: "Good" },
        { url: JS_URL_PAYLOAD, label: SCRIPT_PAYLOAD },
      ],
    });
    expect(out).toContain(`href="${escapeAttr("https://good.example/")}"`);
    expect(out).not.toContain("javascript");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("keeps attribute context correctly scoped when a conditional appears inside a tag", () => {
    const source = `<div title="{{#if danger}}{{x}}{{else}}safe{{/if}}">t</div>`;
    const out = render(source, { danger: true, x: ATTR_BREAKOUT_PAYLOAD });
    expect(out).not.toMatch(/onmouseover\s*=\s*"alert/);
  });
});

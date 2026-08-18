import { describe, expect, it } from "vitest";
import {
  escapeAttr,
  escapeForContext,
  escapeHtml,
  escapeJs,
  escapeUrl,
} from "../../../src/plugins/html-renderer/src/escape.js";

describe("escapeHtml", () => {
  it("leaves plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("encodes the five HTML-special characters", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("neutralizes a <script> tag injection", () => {
    const out = escapeHtml("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("</script>");
    expect(out).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("neutralizes an attribute-breakout attempt", () => {
    const out = escapeHtml(`"><img src=x onerror=alert(1)>`);
    expect(out).not.toContain('"');
    expect(out).not.toContain("<img");
  });

  it("neutralizes a javascript: URL used as plain text", () => {
    const out = escapeHtml("javascript:alert(1)");
    // No HTML metacharacters present in a bare "javascript:alert(1)" string, so
    // it survives unchanged here — it's inert as plain text; only dangerous
    // once placed in a URL-bearing attribute, which is escapeUrl's job.
    expect(out).toBe("javascript:alert(1)");
  });
});

describe("escapeAttr", () => {
  it("leaves alphanumeric text unchanged", () => {
    expect(escapeAttr("abc123XYZ")).toBe("abc123XYZ");
  });

  it("hex-entity-encodes every non-alphanumeric character", () => {
    expect(escapeAttr("a b")).toBe("a&#x20;b");
    expect(escapeAttr('"')).toBe("&#x22;");
    expect(escapeAttr("'")).toBe("&#x27;");
    expect(escapeAttr("<")).toBe("&#x3C;");
    expect(escapeAttr(">")).toBe("&#x3E;");
    expect(escapeAttr("&")).toBe("&#x26;");
  });

  it("neutralizes a double-quoted attribute breakout with an injected handler", () => {
    const payload = `" onmouseover="alert(1)`;
    const out = escapeAttr(payload);
    expect(out).not.toContain('"');
    expect(out).not.toContain(" ");
    expect(out).not.toContain("=");
    // Reconstructing `<div title="${out}">` must not let the browser see a new attribute.
    const reconstructed = `<div title="${out}">`;
    expect(reconstructed).not.toMatch(/onmouseover\s*=\s*"/);
  });

  it("neutralizes a single-quoted attribute breakout", () => {
    const payload = `' onmouseover='alert(1)`;
    const out = escapeAttr(payload);
    expect(out).not.toContain("'");
    expect(out).not.toContain(" ");
  });

  it("neutralizes an unquoted-attribute breakout via whitespace", () => {
    const payload = `x onmouseover=alert(1)`;
    const out = escapeAttr(payload);
    // Whitespace is encoded, so this cannot terminate an unquoted attribute value
    // and start a new bare attribute.
    expect(out).not.toContain(" ");
    expect(out).not.toContain("=");
  });

  it("neutralizes a <script> tag placed in an attribute value", () => {
    const out = escapeAttr("<script>alert(1)</script>");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
  });
});

describe("escapeUrl", () => {
  it("passes through an http(s) URL unchanged (after attribute-escaping)", () => {
    expect(escapeUrl("https://example.com/path?q=1")).toBe(
      escapeAttr("https://example.com/path?q=1"),
    );
  });

  it("passes through a scheme-relative path unchanged (after attribute-escaping)", () => {
    expect(escapeUrl("/path/to/page")).toBe(escapeAttr("/path/to/page"));
    expect(escapeUrl("relative/page")).toBe(escapeAttr("relative/page"));
    expect(escapeUrl("?q=1")).toBe(escapeAttr("?q=1"));
    expect(escapeUrl("#section")).toBe(escapeAttr("#section"));
  });

  it("passes through mailto: and tel: URLs unchanged (after attribute-escaping)", () => {
    expect(escapeUrl("mailto:a@example.com")).toBe(escapeAttr("mailto:a@example.com"));
    expect(escapeUrl("tel:+15555550100")).toBe(escapeAttr("tel:+15555550100"));
  });

  it("blocks a javascript: URL outright", () => {
    const out = escapeUrl("javascript:alert(1)");
    expect(out).not.toContain("javascript");
    expect(out).not.toContain("alert");
  });

  it("blocks a javascript: URL obfuscated with embedded control characters", () => {
    const out = escapeUrl("java\tscript:alert(1)");
    expect(out).not.toContain("alert");
    expect(out.toLowerCase()).not.toContain("script:alert");
  });

  it("blocks a javascript: URL obfuscated with leading whitespace/newlines", () => {
    const out = escapeUrl("\n\t javascript:alert(1)");
    expect(out).not.toContain("alert");
  });

  it("blocks a data: URL", () => {
    const out = escapeUrl("data:text/html,<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("alert");
  });

  it("blocks a vbscript: URL", () => {
    const out = escapeUrl("vbscript:msgbox(1)");
    expect(out).not.toContain("msgbox");
  });

  it("still HTML-attribute-escapes an allowed URL that also carries a quote-breakout payload", () => {
    const out = escapeUrl(`https://example.com/" onmouseover="alert(1)`);
    expect(out).not.toContain('"');
    expect(out).not.toContain(" ");
  });
});

describe("escapeJs", () => {
  it("leaves alphanumeric text unchanged", () => {
    expect(escapeJs("abc123XYZ")).toBe("abc123XYZ");
  });

  it("escapes quotes so a string literal cannot be closed", () => {
    const out = escapeJs(`'; alert(1); '`);
    expect(out).not.toContain("'");
    expect(out).not.toContain(" ");
    expect(out).not.toContain(";");
  });

  it("escapes double quotes the same way", () => {
    const out = escapeJs(`"; alert(1); "`);
    expect(out).not.toContain('"');
  });

  it("neutralizes a </script> breakout embedded in a JS string", () => {
    const out = escapeJs(`</script><script>alert(1)</script>`);
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out.toLowerCase()).not.toContain("script>");
  });

  it("neutralizes an onmouseover-style breakout string used inside a JS context", () => {
    const out = escapeJs(`" onmouseover="alert(1)`);
    expect(out).not.toContain('"');
    expect(out).not.toContain(" ");
  });

  it("neutralizes a javascript: URL used as a JS string value", () => {
    const out = escapeJs("javascript:alert(1)");
    expect(out).not.toContain(":");
  });

  it("produces \\xHH escapes for ASCII punctuation", () => {
    expect(escapeJs("'")).toBe("\\x27");
    expect(escapeJs('"')).toBe("\\x22");
    expect(escapeJs("<")).toBe("\\x3C");
    expect(escapeJs(">")).toBe("\\x3E");
    expect(escapeJs("\\")).toBe("\\x5C");
  });
});

describe("escapeForContext", () => {
  it("dispatches to escapeHtml for 'html'", () => {
    expect(escapeForContext("<b>", "html")).toBe(escapeHtml("<b>"));
  });

  it("dispatches to escapeAttr for 'attr'", () => {
    expect(escapeForContext(`"`, "attr")).toBe(escapeAttr(`"`));
  });

  it("dispatches to escapeUrl for 'url'", () => {
    expect(escapeForContext("javascript:alert(1)", "url")).toBe(escapeUrl("javascript:alert(1)"));
  });

  it("dispatches to escapeJs for 'js'", () => {
    expect(escapeForContext(`'`, "js")).toBe(escapeJs(`'`));
  });
});

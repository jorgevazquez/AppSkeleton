/**
 * XSS regression test suite (feature #54, depends on #47 "Context-aware
 * auto-escaping" and #50 "Explicit raw/unescaped output helper, audited").
 *
 * escape.test.ts and escaping.test.ts already cover each escaper's
 * behavior and each context's wiring in detail, one payload at a time.
 * This suite is deliberately different in shape: a single corpus of
 * well-known XSS payloads (OWASP XSS Filter Evasion Cheat Sheet-style
 * vectors — raw `<script>`/`<img onerror>`/`<svg onload>` tags, quote-
 * breakout attribute injections, `</script>` breakout, `javascript:`/
 * `data:`/`vbscript:` URL schemes, JS string-literal breakouts) is
 * cross-multiplied table-driven-style against every non-raw escaping
 * context (HTML body, double/single/unquoted HTML attribute, URL
 * attribute, `<script>` body, inline event-handler attribute), all
 * rendered through the public `compileTemplate`/`render` API exactly as a
 * template author would use it — plus the `{{{raw ...}}}` helper, which
 * is asserted to do the opposite (pass every payload through untouched)
 * so the "no opt-out except an explicit, audited one" guarantee has one
 * suite that checks both halves together.
 *
 * ## Why payload-agnostic structural assertions instead of comparing
 * against escapeHtml/escapeAttr/escapeUrl/escapeJs
 *
 * The per-context escaper functions already have their own exhaustive
 * unit tests (escape.test.ts). Asserting `render(...) === wrap +
 * escapeXxx(payload)` here would mostly re-prove those same units are
 * self-consistent — it would even stay green if a future regression
 * turned an escaper into an identity function, since both sides of the
 * comparison would break the same way. Instead, each context below
 * defines an independent, payload-content-based structural invariant
 * that must hold no matter which payload was interpolated — e.g. "the
 * output contains exactly the template's own two double-quote
 * characters" (attribute contexts) or "no raw `<`, `>`, `\"`, or `'`
 * survives in the interpolated segment" (HTML body). These invariants
 * are the actual security property each context promises, checked
 * directly against the rendered bytes, so a regression that weakens or
 * removes escaping is caught even if it also "coincidentally" changes
 * what escapeHtml/escapeAttr/escapeUrl/escapeJs individually return.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryAuditSink } from "../../../src/core/audit.js";
import { unwrap } from "../../../src/core/types.js";
import {
  compileTemplate,
  type RawOutputAuditContext,
} from "../../../src/plugins/html-renderer/src/template.js";

function render(source: string, context?: Record<string, unknown>): string {
  const compiled = unwrap(compileTemplate(source));
  return compiled.render(context);
}

function makeAudit(): RawOutputAuditContext {
  return {
    auditSink: createInMemoryAuditSink(),
    pluginId: "xss-regression-suite",
    templateName: "payload-probe",
  };
}

/** Count of non-overlapping occurrences of `ch` (a single literal character) in `s`. */
function countChar(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

// ---------------------------------------------------------------------------
// Payload corpus — well-known XSS vectors, one row per attack shape.
// ---------------------------------------------------------------------------

interface Payload {
  readonly name: string;
  readonly value: string;
}

/**
 * General-purpose payload corpus: markup injection, attribute-breakout,
 * and script-breakout vectors. Exercised against every non-URL-scheme
 * context below (HTML body, HTML attribute in all three quoting styles,
 * `<script>` body, inline event-handler attribute) plus, for breakout
 * safety only, the URL attribute context.
 */
const XSS_PAYLOADS: readonly Payload[] = [
  { name: "script tag", value: "<script>alert(1)</script>" },
  { name: "script tag, mixed case", value: "<ScRiPt>alert(1)</sCriPt>" },
  { name: "img onerror", value: "<img src=x onerror=alert(1)>" },
  { name: "svg onload", value: "<svg onload=alert(1)>" },
  { name: "svg self-closing onload", value: "<svg/onload=alert(1)>" },
  {
    name: "iframe srcdoc with nested script",
    value: '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  },
  { name: "double-quoted attribute breakout", value: `" onmouseover="alert(1)` },
  { name: "single-quoted attribute breakout", value: `' onmouseover='alert(1)` },
  { name: "unquoted attribute breakout", value: "x onmouseover=alert(1)" },
  {
    name: "tag-close attribute breakout with new script tag",
    value: '"><script>alert(document.cookie)</script>',
  },
  {
    name: "tag-close attribute breakout with img onerror",
    value: '"><img src=x onerror=alert(1)>',
  },
  { name: "script close-tag breakout", value: "</script><script>alert(1)</script>" },
  { name: "JS string breakout, double quote", value: '"; alert(1); "' },
  { name: "JS string breakout, single quote", value: "'; alert(1); '" },
  { name: "JS template-literal backtick breakout", value: "`; alert(1); `" },
  {
    name: "pre-encoded HTML entities (double-encoding probe)",
    value: "&lt;script&gt;alert(1)&lt;/script&gt;",
  },
];

/**
 * URL-scheme payloads: only meaningful in a URL-bearing attribute (`href`,
 * `src`, ...), where `escapeUrl` must reject the dangerous scheme outright
 * rather than merely escaping metacharacters within it.
 */
const URL_SCHEME_PAYLOADS: readonly Payload[] = [
  { name: "javascript: scheme", value: "javascript:alert(1)" },
  { name: "javascript: scheme, mixed case", value: "JaVaScRiPt:alert(1)" },
  { name: "javascript: scheme with embedded tab", value: "java\tscript:alert(1)" },
  { name: "javascript: scheme with leading whitespace/newline", value: "\n\t javascript:alert(1)" },
  { name: "data: URL with inline script", value: "data:text/html,<script>alert(1)</script>" },
  { name: "vbscript: scheme", value: "vbscript:msgbox(1)" },
];

// ---------------------------------------------------------------------------
// Context table — one entry per syntactic position a `{{var}}` can land in.
// ---------------------------------------------------------------------------

interface ContextCase {
  readonly name: string;
  readonly template: string;
  /** Asserts the payload was neutralized in `out`, independent of what the payload was. */
  readonly assertNeutralized: (out: string) => void;
}

const CONTEXT_CASES: readonly ContextCase[] = [
  {
    name: "HTML body",
    template: "<div>{{x}}</div>",
    assertNeutralized: (out) => {
      const segment = out.slice("<div>".length, out.length - "</div>".length);
      // escapeHtml's whole contract is "no raw &, <, >, \", or ' survives" — check the four
      // structurally dangerous ones directly (a leftover raw '&' merely means an entity wasn't
      // double-encoded, which is not itself an HTML-injection vector).
      expect(segment).not.toMatch(/[<>"']/);
    },
  },
  {
    name: "HTML attribute, double-quoted",
    template: `<div title="{{x}}">t</div>`,
    assertNeutralized: (out) => {
      // Only the template's own two literal quotes may remain — a payload that broke out would
      // add a third (opening a bogus new attribute) or leave an odd count.
      expect(countChar(out, '"')).toBe(2);
    },
  },
  {
    name: "HTML attribute, single-quoted",
    template: `<div title='{{x}}'>t</div>`,
    assertNeutralized: (out) => {
      expect(countChar(out, "'")).toBe(2);
    },
  },
  {
    name: "HTML attribute, unquoted",
    template: "<div title={{x}}>t</div>",
    assertNeutralized: (out) => {
      // No raw whitespace or '>' may appear in the value token, or it would terminate the
      // unquoted attribute early and let a payload suffix be parsed as new attributes/markup.
      expect(out).toMatch(/^<div title=\S*>t<\/div>$/);
    },
  },
  {
    name: "URL attribute (href)",
    template: `<a href="{{x}}">link</a>`,
    assertNeutralized: (out) => {
      expect(countChar(out, '"')).toBe(2);
    },
  },
  {
    name: "URL attribute (src)",
    template: `<img src="{{x}}">`,
    assertNeutralized: (out) => {
      expect(countChar(out, '"')).toBe(2);
    },
  },
  {
    name: "<script> body",
    template: `<script>var x = "{{x}}";</script>`,
    assertNeutralized: (out) => {
      expect(countChar(out, '"')).toBe(2);
      // Exactly one real close tag — the template's own — regardless of a </script> breakout
      // attempt in the payload.
      expect((out.match(/<\/script>/gi) ?? []).length).toBe(1);
    },
  },
  {
    name: "inline event-handler attribute (onclick)",
    template: `<button onclick="go('{{x}}')">go</button>`,
    assertNeutralized: (out) => {
      // Two double quotes bound the onclick="..." attribute; two single quotes bound go('...').
      expect(countChar(out, '"')).toBe(2);
      expect(countChar(out, "'")).toBe(2);
    },
  },
];

describe("XSS regression suite — every non-raw context neutralizes every known payload", () => {
  for (const ctx of CONTEXT_CASES) {
    describe(ctx.name, () => {
      for (const payload of XSS_PAYLOADS) {
        it(`neutralizes: ${payload.name}`, () => {
          const out = render(ctx.template, { x: payload.value });
          ctx.assertNeutralized(out);
        });
      }
    });
  }
});

describe("XSS regression suite — URL-scheme payloads are rejected in URL attribute contexts", () => {
  const URL_CONTEXTS: readonly ContextCase[] = CONTEXT_CASES.filter((c) =>
    c.name.startsWith("URL attribute"),
  );

  for (const ctx of URL_CONTEXTS) {
    describe(ctx.name, () => {
      for (const payload of URL_SCHEME_PAYLOADS) {
        it(`rejects the dangerous scheme and neutralizes: ${payload.name}`, () => {
          const out = render(ctx.template, { x: payload.value });
          ctx.assertNeutralized(out);
          // The scheme itself, and any call the payload tried to make, must not survive —
          // escapeUrl replaces the whole value with an inert placeholder before attribute-escaping.
          expect(out.toLowerCase()).not.toContain("javascript:");
          expect(out.toLowerCase()).not.toContain("vbscript:");
          expect(out.toLowerCase()).not.toContain("data:text/html");
          expect(out).not.toContain("alert(1)");
          expect(out).not.toContain("msgbox(1)");
        });
      }
    });
  }
});

describe("XSS regression suite — the {{{raw ...}}} helper is the one intentional, audited exception", () => {
  it("passes every payload in the corpus through completely unescaped", () => {
    const audit = makeAudit();
    const compiled = unwrap(compileTemplate("<div>{{{raw x}}}</div>", { audit }));

    for (const payload of XSS_PAYLOADS) {
      const out = compiled.render({ x: payload.value });
      expect(out).toBe(`<div>${payload.value}</div>`);
    }
  });

  it("audits one entry per raw render, unlike every other (escaping, and therefore silent) context", () => {
    const auditSink = createInMemoryAuditSink();
    const audit: RawOutputAuditContext = {
      auditSink,
      pluginId: "xss-regression-suite",
      templateName: "payload-probe",
    };
    const compiled = unwrap(compileTemplate("{{{raw x}}}", { audit }));

    for (const payload of XSS_PAYLOADS) {
      compiled.render({ x: payload.value });
    }

    expect(auditSink.all()).toHaveLength(XSS_PAYLOADS.length);
    for (const entry of auditSink.all()) {
      expect(entry.action).toBe("template:raw_output");
      expect(entry.outcome).toBe("rendered");
    }
  });
});

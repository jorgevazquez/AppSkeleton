/**
 * Tests for feature #50 ("Explicit raw/unescaped output helper, audited"):
 * the `{{{raw path}}}` template tag. Covers the three things the feature's
 * steps require: (1) the syntax exists and is intentionally verbose (only
 * `{{{raw ...}}}` opts out — a bare `{{{x}}}` still escapes, per
 * escaping.test.ts's pre-existing "no opt-out" suite), (2) every use is
 * audited via the kernel's audit trail (core/audit.ts), and (3) compiling a
 * template that uses `{{{raw ...}}}` without an audit context is rejected.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryAuditSink } from "../../../src/core/audit.js";
import { isErr, unwrap } from "../../../src/core/types.js";
import { compileWithLayout } from "../../../src/plugins/html-renderer/src/layout.js";
import { compileWithPartials } from "../../../src/plugins/html-renderer/src/partial.js";
import {
  compileTemplate,
  type RawOutputAuditContext,
} from "../../../src/plugins/html-renderer/src/template.js";

const SCRIPT_PAYLOAD = "<script>alert(1)</script>";

function makeAudit(overrides: Partial<RawOutputAuditContext> = {}): RawOutputAuditContext {
  return {
    auditSink: createInMemoryAuditSink(),
    pluginId: "wiki",
    templateName: "post-detail",
    ...overrides,
  };
}

describe("{{{raw ...}}} — unescaped output", () => {
  it("renders the value with no escaping applied", () => {
    const audit = makeAudit();
    const compiled = unwrap(compileTemplate("<div>{{{raw x}}}</div>", { audit }));
    const out = compiled.render({ x: SCRIPT_PAYLOAD });
    expect(out).toBe(`<div>${SCRIPT_PAYLOAD}</div>`);
    expect(out).toContain("<script>");
  });

  it("is unescaped in every syntactic position, unlike {{variable}}", () => {
    const audit = makeAudit();
    const compiled = unwrap(
      compileTemplate(`<div title="{{{raw x}}}">{{{raw x}}}</div>`, { audit }),
    );
    const out = compiled.render({ x: `" onmouseover="alert(1)` });
    expect(out).toBe(`<div title="" onmouseover="alert(1)">" onmouseover="alert(1)</div>`);
  });

  it("resolves dotted paths, same grammar as {{variable}}", () => {
    const audit = makeAudit();
    const compiled = unwrap(compileTemplate("{{{raw user.bio}}}", { audit }));
    expect(compiled.render({ user: { bio: "<b>hi</b>" } })).toBe("<b>hi</b>");
  });

  it("stringifies and empty-string-defaults exactly like {{variable}}", () => {
    const audit = makeAudit();
    const compiled = unwrap(compileTemplate("[{{{raw n}}}|{{{raw missing}}}]", { audit }));
    expect(compiled.render({ n: 42 })).toBe("[42|]");
  });

  it("a bare {{{x}}} (no `raw` keyword) is NOT raw output — still auto-escaped", () => {
    // No audit context needed: this never compiles to a "raw" node at all (it's a stray "{"
    // text token plus an ordinary, escaped {{x}} tag) — proving the verbose "raw" keyword is
    // required to opt out, matching escaping.test.ts's pre-existing "no opt-out" assertion.
    const compiled = unwrap(compileTemplate("{{{x}}}"));
    const out = compiled.render({ x: "<b>" });
    expect(out).toContain("&lt;b&gt;");
    expect(out).not.toContain("<b>");
  });
});

describe("{{{raw ...}}} — requires an audit context to compile", () => {
  it("rejects a template containing {{{raw ...}}} when no audit option is supplied", () => {
    const result = compileTemplate("{{{raw x}}}");
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.message).toMatch(/raw/i);
      expect(result.error.message).toMatch(/audit/i);
    }
  });

  it("still compiles templates with no raw tag at all when no audit option is supplied", () => {
    const result = compileTemplate("<div>{{x}}</div>");
    expect(isErr(result)).toBe(false);
  });
});

describe("{{{raw ...}}} — every render-time use is audited", () => {
  it("records one audit entry with pluginId, templateName, and the expression", () => {
    const auditSink = createInMemoryAuditSink();
    const audit: RawOutputAuditContext = {
      auditSink,
      pluginId: "wiki",
      templateName: "post-detail",
    };
    const compiled = unwrap(compileTemplate("<div>{{{raw body.html}}}</div>", { audit }));

    const before = Date.now();
    compiled.render({ body: { html: "<p>hi</p>" } });
    const after = Date.now();

    const entries = auditSink.all();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry).toBeDefined();
    expect(entry?.actor).toBe("wiki");
    expect(entry?.action).toBe("template:raw_output");
    expect(entry?.target).toBe("post-detail");
    expect(entry?.outcome).toBe("rendered");
    expect(entry?.details).toEqual({ expression: "body.html" });
    expect(entry?.timestamp).toBeGreaterThanOrEqual(before);
    expect(entry?.timestamp).toBeLessThanOrEqual(after);
  });

  it("records one entry per render call, not just once at compile time", () => {
    const auditSink = createInMemoryAuditSink();
    const compiled = unwrap(
      compileTemplate("{{{raw x}}}", {
        audit: { auditSink, pluginId: "wiki", templateName: "t" },
      }),
    );

    compiled.render({ x: "a" });
    compiled.render({ x: "b" });
    compiled.render({ x: "c" });

    expect(auditSink.all()).toHaveLength(3);
  });

  it("records one entry per {{{raw ...}}} occurrence within a single render", () => {
    const auditSink = createInMemoryAuditSink();
    const compiled = unwrap(
      compileTemplate("{{{raw a}}}-{{{raw b}}}", {
        audit: { auditSink, pluginId: "wiki", templateName: "t" },
      }),
    );

    compiled.render({ a: "1", b: "2" });

    const entries = auditSink.all();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.details).toEqual({ expression: "a" });
    expect(entries[1]?.details).toEqual({ expression: "b" });
  });

  it("does not record any audit entry for ordinary escaped {{variable}} interpolation", () => {
    const auditSink = createInMemoryAuditSink();
    const compiled = unwrap(
      compileTemplate("{{x}}-{{{raw y}}}", {
        audit: { auditSink, pluginId: "wiki", templateName: "t" },
      }),
    );

    compiled.render({ x: "escaped", y: "raw" });

    expect(auditSink.all()).toHaveLength(1);
    expect(auditSink.all()[0]?.details).toEqual({ expression: "y" });
  });

  it("keeps distinct audit sinks/plugins fully isolated", () => {
    const sinkA = createInMemoryAuditSink();
    const sinkB = createInMemoryAuditSink();
    const templateA = unwrap(
      compileTemplate("{{{raw x}}}", {
        audit: { auditSink: sinkA, pluginId: "plugin-a", templateName: "t" },
      }),
    );
    const templateB = unwrap(
      compileTemplate("{{{raw x}}}", {
        audit: { auditSink: sinkB, pluginId: "plugin-b", templateName: "t" },
      }),
    );

    templateA.render({ x: "1" });

    expect(sinkA.all()).toHaveLength(1);
    expect(sinkB.all()).toHaveLength(0);
    expect(sinkA.all()[0]?.actor).toBe("plugin-a");

    templateB.render({ x: "2" });
    expect(sinkB.all()).toHaveLength(1);
    expect(sinkB.all()[0]?.actor).toBe("plugin-b");
  });
});

describe("{{{raw ...}}} — layouts and partials also require + honor the audit context", () => {
  it("compileWithLayout rejects a resolved tree containing {{{raw ...}}} with no audit context", () => {
    const child = `{{extends base}}{{#block content}}{{{raw x}}}{{/block}}`;
    const layouts = { base: `<main>{{#block content}}default{{/block}}</main>` };
    const result = compileWithLayout(child, layouts);
    expect(isErr(result)).toBe(true);
  });

  it("compileWithLayout audits raw output contributed by a block override", () => {
    const auditSink = createInMemoryAuditSink();
    const child = `{{extends base}}{{#block content}}{{{raw x}}}{{/block}}`;
    const layouts = { base: `<main>{{#block content}}default{{/block}}</main>` };
    const compiled = unwrap(
      compileWithLayout(child, layouts, {
        audit: { auditSink, pluginId: "wiki", templateName: "page" },
      }),
    );
    const out = compiled.render({ x: SCRIPT_PAYLOAD });
    expect(out).toBe(`<main>${SCRIPT_PAYLOAD}</main>`);
    expect(auditSink.all()).toHaveLength(1);
    expect(auditSink.all()[0]?.action).toBe("template:raw_output");
  });

  it("compileWithPartials rejects the root template's own {{{raw ...}}} with no audit context", () => {
    const result = compileWithPartials("{{{raw x}}}", {});
    expect(isErr(result)).toBe(true);
  });

  it("compileWithPartials throws a RenderError at render time for an unaudited partial body", () => {
    const compiled = unwrap(compileWithPartials("{{> row x=x}}", { row: "{{{raw x}}}" }));
    expect(() => compiled.render({ x: "1" })).toThrow(/raw/i);
  });

  it("compileWithPartials audits raw output inside a resolved partial body", () => {
    const auditSink = createInMemoryAuditSink();
    const compiled = unwrap(
      compileWithPartials(
        "{{> row x=x}}",
        { row: "{{{raw x}}}" },
        { audit: { auditSink, pluginId: "wiki", templateName: "list" } },
      ),
    );
    const out = compiled.render({ x: SCRIPT_PAYLOAD });
    expect(out).toBe(SCRIPT_PAYLOAD);
    expect(auditSink.all()).toHaveLength(1);
    expect(auditSink.all()[0]?.details).toEqual({ expression: "x" });
  });
});

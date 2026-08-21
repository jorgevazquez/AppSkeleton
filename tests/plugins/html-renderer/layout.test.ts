import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../src/core/errors.js";
import { isErr, unwrap } from "../../../src/core/types.js";
import { compileTemplate } from "../../../src/plugins/html-renderer/src/template.js";
import { compileWithLayout } from "../../../src/plugins/html-renderer/src/layout.js";
import { escapeHtml, escapeUrl } from "../../../src/plugins/html-renderer/src/escape.js";

/** Convenience: compile a child through its layout chain and render, asserting compilation succeeded. */
function render(
  source: string,
  layouts: Record<string, string>,
  context?: Record<string, unknown>,
): string {
  const compiled = unwrap(compileWithLayout(source, layouts));
  return compiled.render(context);
}

describe("standalone layouts (no {{extends}})", () => {
  it("renders a base layout's own default block content when compiled directly", () => {
    const layout = "<body>{{#block content}}default content{{/block}}</body>";
    expect(unwrap(compileTemplate(layout)).render()).toBe("<body>default content</body>");
  });

  it("renders a base layout's own default block content through compileWithLayout too", () => {
    const layout = "<body>{{#block content}}default content{{/block}}</body>";
    expect(render(layout, {})).toBe("<body>default content</body>");
  });

  it("still interpolates variables inside an un-overridden block's default content", () => {
    const layout = "<h1>{{#block title}}Hello, {{name}}!{{/block}}</h1>";
    expect(render(layout, {}, { name: "Ada" })).toBe("<h1>Hello, Ada!</h1>");
  });
});

describe("a single level of {{extends}}", () => {
  const baseLayout = [
    "<html><head><title>{{#block title}}Untitled{{/block}}</title></head>",
    "<body>{{#block content}}(empty){{/block}}</body></html>",
  ].join("");

  it("fills a named block into its layout's placeholder", () => {
    const child = [
      "{{extends base}}",
      "{{#block title}}My Page{{/block}}",
      "{{#block content}}<p>Hello!</p>{{/block}}",
    ].join("");

    expect(render(child, { base: baseLayout })).toBe(
      "<html><head><title>My Page</title></head><body><p>Hello!</p></body></html>",
    );
  });

  it("falls back to the layout's default content for a block the child does not override", () => {
    const child = "{{extends base}}{{#block content}}<p>Just content.</p>{{/block}}";

    expect(render(child, { base: baseLayout })).toBe(
      "<html><head><title>Untitled</title></head><body><p>Just content.</p></body></html>",
    );
  });

  it("renders variables inside a child's block override against the render-time context", () => {
    const child = "{{extends base}}{{#block content}}<p>Hi, {{user.name}}.</p>{{/block}}";

    expect(render(child, { base: baseLayout }, { user: { name: "Grace" } })).toBe(
      "<html><head><title>Untitled</title></head><body><p>Hi, Grace.</p></body></html>",
    );
  });

  it("applies context-aware escaping based on the block's position in the resolved layout, not the child", () => {
    const attrLayout = '<a href="{{#block link}}#{{/block}}">{{#block label}}link{{/block}}</a>';
    // Each override's *literal* text (e.g. "javascript:alert(1)" typed directly in the child) is
    // never escaped -- only {{variable}} interpolations are -- so this uses a variable inside
    // each override to actually exercise escaping, exactly like anywhere else in a template.
    const child =
      "{{extends base}}{{#block link}}{{userLink}}{{/block}}{{#block label}}{{bioHtml}}{{/block}}";

    const html = render(
      child,
      { base: attrLayout },
      {
        userLink: "javascript:alert(1)",
        bioHtml: "<b>Bio</b>",
      },
    );
    // The `link` block's variable lands inside href="..." in the base layout, so it is
    // URL-escaped (its dangerous scheme is rejected outright) even though the child template
    // that defines its override never mentions `href` itself. The `label` block's variable
    // lands in HTML body text, so it is HTML-escaped there instead.
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).toBe(
      `<a href="${escapeUrl("javascript:alert(1)")}">${escapeHtml("<b>Bio</b>")}</a>`,
    );
  });
});

describe("a 2-level layout chain (child -> layout -> base layout)", () => {
  const baseLayout = [
    "<html><body>",
    "<header>{{#block header}}Default Header{{/block}}</header>",
    "<main>{{#block content}}Default Content{{/block}}</main>",
    "<footer>{{#block footer}}Default Footer{{/block}}</footer>",
    "</body></html>",
  ].join("");

  // The middle layout extends the base layout, overrides `header` itself (so any child that
  // doesn't override `header` gets *this* layout's header, not the base's default), and leaves
  // `content`/`footer` for a child (or the base's own defaults) to fill in.
  const middleLayout = ["{{extends base}}", "{{#block header}}<h1>Site Header</h1>{{/block}}"].join(
    "",
  );

  it("resolves a child's own block overrides through two layout levels to the base structure", () => {
    const child = ["{{extends middle}}", "{{#block content}}<p>Page body.</p>{{/block}}"].join("");

    expect(render(child, { base: baseLayout, middle: middleLayout })).toBe(
      "<html><body><header><h1>Site Header</h1></header>" +
        "<main><p>Page body.</p></main>" +
        "<footer>Default Footer</footer></body></html>",
    );
  });

  it("lets the most specific level win when both the child and the middle layout override the same block", () => {
    const child = [
      "{{extends middle}}",
      "{{#block header}}<h1>Child Header</h1>{{/block}}",
      "{{#block content}}<p>Body.</p>{{/block}}",
    ].join("");

    // The child's own `header` override beats the middle layout's `header` override.
    expect(render(child, { base: baseLayout, middle: middleLayout })).toBe(
      "<html><body><header><h1>Child Header</h1></header>" +
        "<main><p>Body.</p></main>" +
        "<footer>Default Footer</footer></body></html>",
    );
  });

  it("falls all the way back to the base layout's own default when nothing in the chain overrides a block", () => {
    const child = "{{extends middle}}{{#block content}}<p>Body only.</p>{{/block}}";

    const html = render(child, { base: baseLayout, middle: middleLayout });
    expect(html).toContain("<footer>Default Footer</footer>");
  });

  it("renders context variables correctly no matter which layout level a block's content came from", () => {
    const child = "{{extends middle}}{{#block content}}<p>Welcome, {{name}}.</p>{{/block}}";

    expect(render(child, { base: baseLayout, middle: middleLayout }, { name: "Lin" })).toBe(
      "<html><body><header><h1>Site Header</h1></header>" +
        "<main><p>Welcome, Lin.</p></main>" +
        "<footer>Default Footer</footer></body></html>",
    );
  });
});

describe("error handling", () => {
  it("rejects compileTemplate on a template containing {{extends}}", () => {
    const result = compileTemplate("{{extends base}}{{#block content}}x{{/block}}");
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.message).toContain("compileWithLayout");
    }
  });

  it("rejects a template with more than one {{extends}} tag", () => {
    const result = compileWithLayout("{{extends a}}{{extends b}}", { a: "x", b: "y" });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.message).toContain("at most one");
    }
  });

  it("reports an unknown layout name", () => {
    const result = compileWithLayout("{{extends nope}}", {});
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.message).toContain('Unknown layout "nope"');
    }
  });

  it("detects a direct circular {{extends}} chain", () => {
    const result = compileWithLayout("{{extends a}}", {
      a: "{{extends b}}",
      b: "{{extends a}}",
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.message).toContain("Circular");
    }
  });

  it("detects a self-referencing {{extends}} chain", () => {
    const result = compileWithLayout("{{extends a}}", { a: "{{extends a}}" });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.message).toContain("Circular");
    }
  });

  it("propagates an unclosed {{#block}} as a parse error", () => {
    const result = compileWithLayout("{{extends base}}{{#block content}}oops", { base: "x" });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.message).toContain("{{#block}}");
    }
  });

  it("rejects an unknown/malformed {{#block}} name", () => {
    const result = compileTemplate("{{#block}}x{{/block}}");
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.message).toContain("expected a block name");
    }
  });
});

describe("using a resolver function instead of a plain map", () => {
  it("accepts a name => source | undefined function for layouts", () => {
    const layouts = new Map([["base", "<body>{{#block content}}default{{/block}}</body>"]]);
    const result = compileWithLayout("{{extends base}}{{#block content}}custom{{/block}}", (name) =>
      layouts.get(name),
    );
    expect(unwrap(result).render()).toBe("<body>custom</body>");
  });
});

// ---------------------------------------------------------------------------
// Composing with partials (feature #95 — "Wiki home page and navigation UI
// rendered via html-renderer layouts"). Before this feature, `layout.ts` and
// `partial.ts` were documented as "not composable in a single call" — a
// template needing both a layout and a `{{> ...}}` tag had to pre-render the
// partial separately and splice it in as audited raw output. These tests
// exercise `compileWithLayout`'s new optional fourth argument instead.
// ---------------------------------------------------------------------------

describe("composing with partials (compileWithLayout's optional 4th argument)", () => {
  const base = "<body>{{#block content}}default{{/block}}</body>";

  it("resolves a {{> partial}} tag inside a block override, with no partials registry supplied via the old (options-only) call shape failing the same way it always has", () => {
    const withoutPartials = compileWithLayout(
      "{{extends base}}{{#block content}}{{> greeting name=who}}{{/block}}",
      { base },
    );
    // Compiling still succeeds — an unresolvable {{> ...}} only ever fails at
    // render time (matches compileTemplate's own long-standing behavior for
    // a template compiled without a partial registry).
    const compiled = unwrap(withoutPartials);
    expect(() => compiled.render({ who: "Ada" })).toThrow(/partial registry/);
  });

  it("resolves a {{> partial}} tag inside a block override when a partials registry is supplied", () => {
    const partials = { greeting: "Hello, {{name}}!" };
    const compiled = unwrap(
      compileWithLayout(
        "{{extends base}}{{#block content}}{{> greeting name=who}}{{/block}}",
        { base },
        undefined,
        partials,
      ),
    );
    expect(compiled.render({ who: "Ada" })).toBe("<body>Hello, Ada!</body>");
  });

  it("resolves a {{> partial}} tag that lives in the base layout's own fixed structure (not inside a block at all)", () => {
    const layoutWithPartial =
      '<body><nav>{{> nav-item label="Home"}}</nav>{{#block content}}default{{/block}}</body>';
    const partials = { "nav-item": '<a href="/">{{label}}</a>' };
    const compiled = unwrap(
      compileWithLayout("{{extends base}}", { base: layoutWithPartial }, undefined, partials),
    );
    expect(compiled.render()).toBe('<body><nav><a href="/">Home</a></nav>default</body>');
  });

  it("resolves a self-recursive partial referenced from inside a layout, matching compileWithPartials's own recursion support (a nested navigation tree of unknown depth)", () => {
    const treePartial = [
      "<span>{{label}}</span>",
      "{{#if children}}<ul>{{#each children}}<li>{{> tree label=label children=children}}</li>{{/each}}</ul>{{/if}}",
    ].join("");
    const partials = { tree: treePartial };
    const source =
      "{{extends base}}{{#block content}}<div>{{> tree label=label children=children}}</div>{{/block}}";
    const compiled = unwrap(compileWithLayout(source, { base }, undefined, partials));
    const context = {
      label: "root",
      children: [
        { label: "child-a", children: [] },
        { label: "child-b", children: [{ label: "grandchild", children: [] }] },
      ],
    };
    expect(compiled.render(context)).toBe(
      "<body><div><span>root</span><ul>" +
        "<li><span>child-a</span></li>" +
        "<li><span>child-b</span><ul><li><span>grandchild</span></li></ul></li>" +
        "</ul></div></body>",
    );
  });

  it("still auto-escapes a partial's own interpolations when composed through a layout", () => {
    const partials = { greeting: "<p>Hello, {{name}}!</p>" };
    const compiled = unwrap(
      compileWithLayout(
        "{{extends base}}{{#block content}}{{> greeting name=who}}{{/block}}",
        { base },
        undefined,
        partials,
      ),
    );
    expect(compiled.render({ who: "<script>evil()</script>" })).toBe(
      "<body><p>Hello, &lt;script&gt;evil()&lt;/script&gt;!</p></body>",
    );
  });

  it("throws a RenderError for an unknown partial name even when a partials registry was supplied (just missing that name)", () => {
    const compiled = unwrap(
      compileWithLayout(
        "{{extends base}}{{#block content}}{{> nope}}{{/block}}",
        { base },
        undefined,
        { greeting: "hi" },
      ),
    );
    expect(() => compiled.render()).toThrow(/Unknown partial "nope"/);
  });

  it("still supports a standalone (no {{extends}}) source containing a {{> ...}} tag when a partials registry is supplied", () => {
    const partials = { greeting: "Hello, {{name}}!" };
    const compiled = unwrap(
      compileWithLayout("<p>{{> greeting name=who}}</p>", {}, undefined, partials),
    );
    expect(compiled.render({ who: "Ada" })).toBe("<p>Hello, Ada!</p>");
  });
});

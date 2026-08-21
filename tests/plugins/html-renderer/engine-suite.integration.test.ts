/**
 * Feature #56 — "Unit test suite for html-renderer (parser, layouts,
 * partials, caching)". Each of those four pieces already has its own
 * exhaustive, dedicated unit-test file (template.test.ts for feature #46's
 * parser/compiler, layout.test.ts for feature #48's layout system,
 * partial.test.ts for feature #49's partials, template-cache.test.ts for
 * feature #53's caching) — this file's job, per the feature's own step 1
 * ("Assemble tests covering the parser, layout nesting, partials, and the
 * template cache together"), is different: it exercises the four pieces
 * *together*, the way a real consuming app actually would, rather than each
 * in isolation.
 *
 * Sections 1-4 below are short, focused smoke tests for each piece on its
 * own (kept intentionally small — the exhaustive cases already live in the
 * dedicated files above); section 5 is the actual "assembled" scenario: a
 * small multi-file template store (mirroring template-cache.test.ts's
 * in-memory "file on disk" fixture) backs *both* a `TemplateCache` and the
 * `layouts` resolver `compileWithLayout` is handed, so caching and layout
 * composition are proven to observe the exact same underlying source and
 * the exact same dev-mode invalidation behavior — while a loop of
 * parameterized partials (feature #49) is pre-rendered and spliced into the
 * composed layout as audited raw output (feature #50) — the pre-render,
 * then splice approach an app already needed before feature #95 taught
 * `compileWithLayout` to accept an optional `partials` argument of its own
 * (see layout.ts/partial.ts's own module docs for that direct-composition
 * path); kept here as a still-valid alternative for a caller that would
 * rather pre-render a partial to raw HTML once and reuse it across many
 * layouts than wire the same partials registry into every
 * `compileWithLayout` call.
 */
import { describe, expect, it, vi } from "vitest";
import { createInMemoryAuditSink } from "../../../src/core/audit.js";
import { unwrap } from "../../../src/core/types.js";
import {
  compileTemplate,
  type RawOutputAuditContext,
} from "../../../src/plugins/html-renderer/src/template.js";
import {
  compileWithLayout,
  type LayoutSource,
} from "../../../src/plugins/html-renderer/src/layout.js";
import { compileWithPartials } from "../../../src/plugins/html-renderer/src/partial.js";
import {
  createTemplateCache,
  type TemplateFileSnapshot,
} from "../../../src/plugins/html-renderer/src/template-cache.js";

function makeAudit(templateName: string): RawOutputAuditContext {
  return { auditSink: createInMemoryAuditSink(), pluginId: "engine-suite", templateName };
}

// ---------------------------------------------------------------------------
// 1. Parser (feature #46) — variables, conditionals, loops. The exhaustive
//    grammar/edge-case coverage lives in template.test.ts; these few smoke
//    tests just confirm the building blocks the rest of this file leans on.
// ---------------------------------------------------------------------------

describe("1. parser: variables, conditionals, loops", () => {
  it("interpolates a dotted variable path", () => {
    const compiled = unwrap(compileTemplate("Hi, {{user.name}}!"));
    expect(compiled.render({ user: { name: "Ada" } })).toBe("Hi, Ada!");
  });

  it("branches on a conditional", () => {
    const compiled = unwrap(compileTemplate("{{#if loud}}HI{{else}}hi{{/if}}"));
    expect(compiled.render({ loud: true })).toBe("HI");
    expect(compiled.render({ loud: false })).toBe("hi");
  });

  it("iterates a collection, exposing each item's own fields", () => {
    const compiled = unwrap(compileTemplate("{{#each items}}({{name}}){{/each}}"));
    expect(compiled.render({ items: [{ name: "a" }, { name: "b" }] })).toBe("(a)(b)");
  });

  it("nests a conditional inside a loop", () => {
    const compiled = unwrap(compileTemplate("{{#each items}}{{#if ok}}Y{{else}}N{{/if}}{{/each}}"));
    expect(compiled.render({ items: [{ ok: true }, { ok: false }, { ok: true }] })).toBe("YNY");
  });
});

// ---------------------------------------------------------------------------
// 2. Layout nesting (feature #48) — a 3-level {{extends}} chain, one level
//    deeper than layout.test.ts's own 2-level suite, with a block's content
//    itself using the parser's loop/conditional constructs (not just plain
//    text or a bare variable) — proving nesting and the parser compose.
// ---------------------------------------------------------------------------

describe("2. layout nesting: a 3-level chain with parser constructs inside a block", () => {
  const grandparent = [
    "<html><body>",
    "<nav>{{#block nav}}(no nav){{/block}}</nav>",
    "<main>{{#block content}}(empty){{/block}}</main>",
    "</body></html>",
  ].join("");
  const parent = ["{{extends grandparent}}", "{{#block nav}}Home{{/block}}"].join("");

  function renderChild(content: string, context: Record<string, unknown>): string {
    const child = `{{extends parent}}{{#block content}}${content}{{/block}}`;
    const compiled = unwrap(compileWithLayout(child, { grandparent, parent }));
    return compiled.render(context);
  }

  it("resolves the child's block through both intermediate levels to the grandparent's structure", () => {
    const html = renderChild("{{#each tags}}#{{this}} {{/each}}", { tags: ["a", "b"] });
    expect(html).toBe("<html><body><nav>Home</nav><main>#a #b </main></body></html>");
  });

  it("still falls back to the topmost ancestor's default for a block nothing in the chain overrides", () => {
    const child = "{{extends parent}}{{#block content}}x{{/block}}";
    const html = unwrap(compileWithLayout(child, { grandparent, parent })).render();
    expect(html).toContain("<nav>Home</nav>");
  });

  it("evaluates a conditional inside the resolved block against the render-time context", () => {
    const html = renderChild("{{#if vip}}VIP{{else}}guest{{/if}}", { vip: true });
    expect(html).toContain("<main>VIP</main>");
  });
});

// ---------------------------------------------------------------------------
// 3. Partials (feature #49) — a parameterized partial called from inside a
//    parser loop, plus a recursive partial with a parser-driven terminating
//    condition, proving partials and the parser compose in both directions.
// ---------------------------------------------------------------------------

describe("3. partials: parameterized components driven by a loop, and recursion", () => {
  const card = "<li>{{label}} - {{#if inStock}}in stock{{else}}sold out{{/if}}</li>";

  it("renders one partial call per loop iteration, each with its own isolated params", () => {
    const source = "<ul>{{#each products}}{{> card label=name inStock=inStock}}{{/each}}</ul>";
    const compiled = unwrap(compileWithPartials(source, { card }));
    const html = compiled.render({
      products: [
        { name: "Widget", inStock: true },
        { name: "Gadget", inStock: false },
      ],
    });
    expect(html).toBe("<ul><li>Widget - in stock</li><li>Gadget - sold out</li></ul>");
  });

  it("recurses through a breadcrumb-style self-including partial, terminating via {{#if}}", () => {
    // Separator emitted *before* recursing, so each level's own label lands before its
    // descendants' -- "Home > Products > Widget", not the other way around.
    const crumb = "{{label}}{{#if rest}} &gt; {{> crumb label=rest.label rest=rest.rest}}{{/if}}";
    const compiled = unwrap(compileWithPartials("{{> crumb label=label rest=rest}}", { crumb }));
    const html = compiled.render({
      label: "Home",
      rest: { label: "Products", rest: { label: "Widget", rest: undefined } },
    });
    expect(html).toBe("Home &gt; Products &gt; Widget");
  });
});

// ---------------------------------------------------------------------------
// 4. Template cache (feature #53) — multiple parser-driven template paths,
//    reused across get() calls, invalidated independently on file change.
// ---------------------------------------------------------------------------

describe("4. template cache: multiple paths, dev invalidation, independent entries", () => {
  function fakeFile(initial: TemplateFileSnapshot) {
    let current = initial;
    return {
      read: vi.fn((): TemplateFileSnapshot => current),
      write(next: TemplateFileSnapshot): void {
        current = next;
      },
    };
  }

  it("caches two distinct loop/conditional-driven templates independently", () => {
    const list = fakeFile({ source: "{{#each xs}}({{this}}){{/each}}", mtimeMs: 1 });
    const flag = fakeFile({ source: "{{#if on}}ON{{else}}off{{/if}}", mtimeMs: 1 });
    const cache = createTemplateCache({
      nodeEnv: "production",
      readTemplateFile: (path) => (path === "/list.html" ? list.read() : flag.read()),
    });

    expect(unwrap(cache.get("/list.html")).render({ xs: [1, 2] })).toBe("(1)(2)");
    expect(unwrap(cache.get("/flag.html")).render({ on: true })).toBe("ON");
    expect(cache.size()).toBe(2);
  });

  it("recompiles only the path whose content actually changed, in dev mode", () => {
    const a = fakeFile({ source: "A-v1", mtimeMs: 1 });
    const b = fakeFile({ source: "B-v1", mtimeMs: 1 });
    const cache = createTemplateCache({
      nodeEnv: "development",
      readTemplateFile: (path) => (path === "/a.html" ? a.read() : b.read()),
    });

    const aBefore = unwrap(cache.get("/a.html"));
    const bBefore = unwrap(cache.get("/b.html"));

    a.write({ source: "A-v2", mtimeMs: 2 });
    const aAfter = unwrap(cache.get("/a.html"));
    const bAfter = unwrap(cache.get("/b.html"));

    expect(aAfter).not.toBe(aBefore);
    expect(aAfter.render()).toBe("A-v2");
    // /b.html was never touched, so its entry is untouched too.
    expect(bAfter).toBe(bBefore);
    expect(bAfter.render()).toBe("B-v1");
  });
});

// ---------------------------------------------------------------------------
// 5. Assembled: one multi-file template store backs both the cache and
//    layout composition, while a pre-rendered loop of partials is spliced
//    in as audited raw output — parser + layout nesting + partials +
//    caching, all driving one realistic page render.
// ---------------------------------------------------------------------------

describe("5. assembled: cache-backed layout composition plus a pre-rendered partial loop", () => {
  const BASE_PATH = "/templates/base.html";
  const MIDDLE_PATH = "/templates/middle.html";
  const CARD_SOURCE = "<li>{{label}} - {{#if inStock}}in stock{{else}}sold out{{/if}}</li>";

  function baseSource(footerDefault: string): string {
    return [
      "<html><head><title>{{#block title}}Untitled{{/block}}</title></head><body>",
      "<header>{{#block header}}Site{{/block}}</header>",
      "<main>{{#block content}}{{/block}}</main>",
      "<aside>{{#block sidebar}}{{/block}}</aside>",
      `<footer>{{#block footer}}${footerDefault}{{/block}}</footer>`,
      "</body></html>",
    ].join("");
  }
  const MIDDLE_SOURCE = [
    "{{extends base}}",
    "{{#block header}}<h1>{{siteName}}</h1>{{/block}}",
  ].join("");
  const PAGE_SOURCE = [
    "{{extends middle}}",
    "{{#block title}}Shop{{/block}}",
    "{{#block content}}<ul>{{{raw productsHtml}}}</ul>{{/block}}",
    "{{#block sidebar}}{{{raw sidebarHtml}}}{{/block}}",
  ].join("");

  /** One in-memory "filesystem" a `TemplateCache` and a layout resolver both read from. */
  function makeStore(initial: Record<string, TemplateFileSnapshot>) {
    const files = new Map(Object.entries(initial));
    return {
      readTemplateFile: vi.fn((path: string): TemplateFileSnapshot => {
        const snapshot = files.get(path);
        if (snapshot === undefined) {
          throw new Error(`no such file: ${path}`);
        }
        return snapshot;
      }),
      write(path: string, next: TemplateFileSnapshot): void {
        files.set(path, next);
      },
      source(path: string): string {
        const snapshot = files.get(path);
        if (snapshot === undefined) {
          throw new Error(`no such file: ${path}`);
        }
        return snapshot.source;
      },
    };
  }

  function layoutsFrom(store: ReturnType<typeof makeStore>): LayoutSource {
    return (name) => {
      if (name === "base") {
        return store.source(BASE_PATH);
      }
      if (name === "middle") {
        return store.source(MIDDLE_PATH);
      }
      return undefined;
    };
  }

  /** Pre-render the products loop through the partial system (feature #49) into a plain string. */
  function renderProductsHtml(products: readonly { name: string; inStock: boolean }[]): string {
    const compiled = unwrap(
      compileWithPartials("{{#each products}}{{> card label=name inStock=inStock}}{{/each}}", {
        card: CARD_SOURCE,
      }),
    );
    return compiled.render({ products });
  }

  function renderPage(
    store: ReturnType<typeof makeStore>,
    context: Record<string, unknown>,
  ): string {
    const compiled = unwrap(
      compileWithLayout(PAGE_SOURCE, layoutsFrom(store), { audit: makeAudit("shop-page") }),
    );
    return compiled.render(context);
  }

  it("renders a full page: 2-level extends resolution, a pre-rendered partial loop, and raw-spliced sidebar content", () => {
    const store = makeStore({
      [BASE_PATH]: { source: baseSource("v1"), mtimeMs: 1 },
      [MIDDLE_PATH]: { source: MIDDLE_SOURCE, mtimeMs: 1 },
    });

    const productsHtml = renderProductsHtml([
      { name: "Widget", inStock: true },
      { name: "Gadget", inStock: false },
    ]);

    const html = renderPage(store, {
      siteName: "Acme",
      productsHtml,
      sidebarHtml: "<div>promo</div>",
    });

    expect(html).toBe(
      "<html><head><title>Shop</title></head><body>" +
        "<header><h1>Acme</h1></header>" +
        "<main><ul><li>Widget - in stock</li><li>Gadget - sold out</li></ul></main>" +
        "<aside><div>promo</div></aside>" +
        "<footer>v1</footer>" +
        "</body></html>",
    );
  });

  it("a dev-mode cache and a fresh layout render see the exact same edit to the shared base-layout file", () => {
    const store = makeStore({
      [BASE_PATH]: { source: baseSource("v1"), mtimeMs: 1 },
      [MIDDLE_PATH]: { source: MIDDLE_SOURCE, mtimeMs: 1 },
    });
    const devCache = createTemplateCache({
      nodeEnv: "development",
      readTemplateFile: store.readTemplateFile,
    });

    // The base layout has no {{extends}} of its own, so it's a perfectly valid standalone
    // template too -- compiled and cached directly, independent of the layout chain above it.
    const baseBefore = unwrap(devCache.get(BASE_PATH));
    expect(baseBefore.render()).toContain("<footer>v1</footer>");

    const pageBefore = renderPage(store, {
      siteName: "Acme",
      productsHtml: "",
      sidebarHtml: "",
    });
    expect(pageBefore).toContain("<footer>v1</footer>");

    store.write(BASE_PATH, { source: baseSource("v2"), mtimeMs: 2 });

    const baseAfter = unwrap(devCache.get(BASE_PATH));
    expect(baseAfter).not.toBe(baseBefore);
    expect(baseAfter.render()).toContain("<footer>v2</footer>");

    const pageAfter = renderPage(store, {
      siteName: "Acme",
      productsHtml: "",
      sidebarHtml: "",
    });
    expect(pageAfter).toContain("<footer>v2</footer>");
  });

  it("a production-mode cache pointed at the same store stays pinned to what it first compiled", () => {
    const store = makeStore({
      [BASE_PATH]: { source: baseSource("v1"), mtimeMs: 1 },
      [MIDDLE_PATH]: { source: MIDDLE_SOURCE, mtimeMs: 1 },
    });
    const prodCache = createTemplateCache({
      nodeEnv: "production",
      readTemplateFile: store.readTemplateFile,
    });

    const baseBefore = unwrap(prodCache.get(BASE_PATH));
    store.write(BASE_PATH, { source: baseSource("v2"), mtimeMs: 2 });
    const baseAfter = unwrap(prodCache.get(BASE_PATH));

    // Same cached instance, original content -- production never re-reads the file after the
    // first compile (see template-cache.ts's "Dev vs. production" doc section).
    expect(baseAfter).toBe(baseBefore);
    expect(baseAfter.render()).toContain("<footer>v1</footer>");

    // A *fresh* compileWithLayout call, on the other hand, reads straight from the (now-edited)
    // store, with no cache in front of it at all -- so it does see v2. The production cache's
    // immutability is a property of the cache instance, not of the underlying store.
    const html = renderPage(store, { siteName: "Acme", productsHtml: "", sidebarHtml: "" });
    expect(html).toContain("<footer>v2</footer>");
  });
});

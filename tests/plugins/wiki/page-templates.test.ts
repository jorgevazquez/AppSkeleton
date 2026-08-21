/**
 * Tests for feature #95 — "Wiki home page and navigation UI rendered via
 * html-renderer layouts".
 *
 * Step 3's own required test ("Write a test rendering the home page and
 * asserting key navigation elements are present") lives in the
 * `describe("rendering the home page ...")` block below, driven through
 * the *real* capability broker and the *real* `html-renderer` plugin
 * module — mirrors `tests/plugins/wiki/markdown-render.integration.test.ts`'s
 * fixture-plugin pattern exactly (a fixture "wiki-page-templates-consumer"
 * plugin declares `render:template` under `capabilities.requires`, obtains
 * it in `onEnable`, and calls `page-templates.ts`'s render functions with
 * the capability's own `compileWithLayout`), proving the shared layout, the
 * navigation sidebar (feature #91's `NamespaceTreeNode` shape), and the
 * page-view's composed Markdown content all render correctly end-to-end,
 * not just against a hand-rolled stand-in for html-renderer.
 *
 * The page-view template and `buildPageViewSource`'s pure source-shape
 * contract get their own dedicated `describe` blocks too, so this file
 * covers both of feature #95 step 1's templates, not only the one step 3
 * explicitly names.
 */
import { describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isErr, isOk, unwrap } from "../../../src/core/types.js";
import * as htmlRendererModule from "../../../src/plugins/html-renderer/index.js";
import type { RenderTemplateCapability } from "../../../src/plugins/html-renderer/index.js";
import {
  buildPageViewSource,
  renderHomePage,
  renderPageView,
  type HomePageContext,
  type PageViewContext,
} from "../../../src/plugins/wiki/src/page-templates.js";
import type { NamespaceTreeNode } from "../../../src/plugins/wiki/src/types.js";

/** Minimal, schema-shaped manifest fixture — mirrors markdown-render.integration.test.ts's own `manifest()` helper. */
function manifest(
  id: string,
  options: { dependsOn?: Record<string, string>; provides?: string[]; requires?: string[] } = {},
): PluginManifest {
  return {
    id,
    version: "1.0.0",
    depends_on: options.dependsOn ?? {},
    capabilities: { provides: options.provides ?? [], requires: options.requires ?? [] },
    entry_point: "index.ts",
  };
}

const HTML_RENDERER_MANIFEST = manifest("html-renderer", { provides: ["render:template"] });

/**
 * A 2-level namespace hierarchy (Help -> FAQ) plus a childless, page-less
 * root (Main) — enough to exercise nesting, a namespace's own pages, and
 * an empty-pages/empty-children namespace all in one fixture, without
 * needing feature #91's own `buildNamespaceTree`/a real database (this
 * module never touches either — see page-templates.ts's own doc comment).
 */
const NAV_TREE: readonly NamespaceTreeNode[] = [
  {
    id: "help",
    name: "Help",
    description: null,
    pages: [{ id: 1, slug: "getting-started", title: "Getting Started" }],
    children: [
      {
        id: "help-faq",
        name: "FAQ",
        description: null,
        pages: [{ id: 2, slug: "faq", title: "Frequently Asked Questions" }],
        children: [],
      },
    ],
  },
  {
    id: "main",
    name: "Main",
    description: null,
    pages: [],
    children: [],
  },
];

/**
 * Load the real html-renderer plugin plus a fixture consumer whose
 * `onEnable` calls `run` with the real `compileWithLayout` — mirrors
 * `markdown-render.integration.test.ts`'s `renderAllThroughRealCapability`.
 */
async function withRealCompileWithLayout(
  run: (compileWithLayout: RenderTemplateCapability["compileWithLayout"]) => void,
): Promise<void> {
  const consumerManifest = manifest("wiki-page-templates-consumer", {
    dependsOn: { "html-renderer": "^1.0.0" },
    requires: ["render:template"],
  });

  const consumerModule: PluginModule = {
    onEnable(context) {
      const obtained = context.capabilities.obtain<RenderTemplateCapability>("render:template");
      if (isErr(obtained)) {
        throw obtained.error;
      }
      run(obtained.value.compileWithLayout);
    },
  };

  const definitions: PluginDefinition[] = [
    { manifest: HTML_RENDERER_MANIFEST, module: htmlRendererModule },
    { manifest: consumerManifest, module: consumerModule },
  ];

  const broker = createCapabilityBroker();
  const loadResult = await loadPlugins(definitions, broker);
  expect(isOk(loadResult)).toBe(true);
  if (!isOk(loadResult)) {
    throw new Error("plugin load unexpectedly failed");
  }
  expect(loadResult.value.failed).toEqual([]);
}

describe("rendering the home page and asserting key navigation elements are present (feature #95 step 3)", () => {
  it("renders the shared layout, the page title/stats, and the full navigation sidebar", async () => {
    let html = "";
    const context: HomePageContext = {
      navTree: NAV_TREE,
      pageCount: 2,
      namespaceCount: 3,
    };

    await withRealCompileWithLayout((compileWithLayout) => {
      html = unwrap(renderHomePage(compileWithLayout, context));
    });

    // The shared layout shell (feature #48) — doctype, title block, nav landmark.
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Wiki Home</title>");
    expect(html).toContain('<nav class="wiki-sidebar" aria-label="Wiki navigation">');

    // Step 2: the navigation sidebar (feature #91's NamespaceTreeNode shape) — every
    // namespace name, every page link, and the nested child namespace all present.
    expect(html).toContain("Help");
    expect(html).toContain("FAQ");
    expect(html).toContain("Main");
    expect(html).toContain('<a href="/wiki/pages/1">Getting Started</a>');
    expect(html).toContain('<a href="/wiki/pages/2">Frequently Asked Questions</a>');

    // The child namespace's <ul> nests *inside* the parent's own <li>, not as a sibling —
    // proves the recursive {{> wiki-nav-tree nodes=children}} partial call actually composed
    // through the layout rather than silently rendering nothing (feature #95's whole point).
    const helpIndex = html.indexOf("Help");
    const faqIndex = html.indexOf("FAQ");
    const closingHelpLi = html.indexOf("</li>", faqIndex);
    expect(helpIndex).toBeGreaterThan(-1);
    expect(faqIndex).toBeGreaterThan(helpIndex);
    expect(closingHelpLi).toBeGreaterThan(faqIndex);

    // The home page's own content block.
    expect(html).toContain("<h1>Welcome to the wiki</h1>");
    expect(html).toContain("2 pages across 3 namespaces.");
  });

  it("renders an empty (but present) navigation sidebar when there are no namespaces yet", async () => {
    let html = "";
    const context: HomePageContext = { navTree: [], pageCount: 0, namespaceCount: 0 };

    await withRealCompileWithLayout((compileWithLayout) => {
      html = unwrap(renderHomePage(compileWithLayout, context));
    });

    expect(html).toContain('<nav class="wiki-sidebar" aria-label="Wiki navigation"></nav>');
    expect(html).toContain("0 pages across 0 namespaces.");
  });

  it("HTML-escapes a namespace/page name that contains unsafe characters (auto-escaping still applies through the composed layout+partial render)", async () => {
    let html = "";
    const context: HomePageContext = {
      navTree: [
        {
          id: "evil",
          name: "<script>alert(1)</script>",
          description: null,
          pages: [{ id: 9, slug: "x", title: '"onmouseover="alert(1)' }],
          children: [],
        },
      ],
      pageCount: 1,
      namespaceCount: 1,
    };

    await withRealCompileWithLayout((compileWithLayout) => {
      html = unwrap(renderHomePage(compileWithLayout, context));
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain('"onmouseover="alert(1)');
  });
});

describe("rendering a single wiki page (feature #95 step 1 — the page-view template)", () => {
  it("renders the page's title, its Markdown body, and the shared navigation sidebar together", async () => {
    let html = "";
    const context: PageViewContext = {
      navTree: NAV_TREE,
      pageTitle: "Getting Started",
      markdown: "# Getting Started\n\nWelcome! See the **FAQ** for more.",
    };

    await withRealCompileWithLayout((compileWithLayout) => {
      html = unwrap(renderPageView(compileWithLayout, context));
    });

    expect(html).toContain("<title>Getting Started</title>");
    expect(html).toContain('<article class="wiki-page">');
    expect(html).toContain("<h1>Getting Started</h1>");
    expect(html).toContain(
      "<h1>Getting Started</h1><p>Welcome! See the <strong>FAQ</strong> for more.</p>",
    );
    // The shared sidebar is still present on a page-view render, not just the home page.
    expect(html).toContain('<a href="/wiki/pages/2">Frequently Asked Questions</a>');
  });

  it("neutralizes an XSS-style payload embedded in the page's Markdown body (still data, not a raw string, through the composed layout)", async () => {
    let html = "";
    const context: PageViewContext = {
      navTree: [],
      pageTitle: "Report",
      markdown: "<script>alert(document.cookie)</script>",
    };

    await withRealCompileWithLayout((compileWithLayout) => {
      html = unwrap(renderPageView(compileWithLayout, context));
    });

    expect(html).not.toContain("<script>alert(document.cookie)</script>");
    expect(html).toContain("&lt;script&gt;alert(document.cookie)&lt;/script&gt;");
  });
});

describe("buildPageViewSource (pure, no I/O)", () => {
  it("extends the shared layout and splices the markdown source between the page title and the closing </article>", () => {
    const source = buildPageViewSource("<p>{{md0}}</p>");
    expect(source.startsWith("{{extends wiki-layout}}")).toBe(true);
    expect(source).toContain("{{#block title}}{{pageTitle}}{{/block}}");
    expect(source).toContain(
      '<article class="wiki-page"><h1>{{pageTitle}}</h1><p>{{md0}}</p></article>',
    );
  });

  it("never embeds the markdown source's own text directly — only the caller-supplied placeholder-bearing source string", () => {
    // A pathological "markdownSource" containing template-injection-looking text is still just
    // spliced as literal source (exactly like a hand-authored layout would be) — this function
    // has no opinion on what's inside it, that safety property lives in markdown.ts's
    // compileMarkdownTemplate, which only ever emits fixed literal tags plus {{mdN}} placeholders.
    const source = buildPageViewSource("{{md0}}");
    expect(source).toContain("<h1>{{pageTitle}}</h1>{{md0}}</article>");
  });
});

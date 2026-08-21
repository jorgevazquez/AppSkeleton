/**
 * Automated accessibility check for feature #102 ("Accessibility pass on
 * wiki HTML templates"), step 3: "Write a lightweight automated check (e.g.
 * axe-core against rendered HTML) as part of the test suite".
 *
 * Every wiki-owned HTML *document* template — `page-templates.ts`'s shared
 * `WIKI_LAYOUT` (rendered here via `renderHomePage`/`renderPageView`, the
 * same real capability-broker fixture pattern `page-templates.test.ts` and
 * `markdown-render.integration.test.ts` already establish) and
 * `page-form.ts`'s standalone create/edit form (rendered here via
 * `renderPageFormHtml`, mirroring `page-form.test.ts`'s own real,
 * un-mocked `compileTemplate` usage) — is rendered to a real HTML string
 * and then parsed into a real DOM via `jsdom`, so axe-core is auditing
 * actual parsed markup, not a hand-rolled stand-in for one.
 *
 * `diff.ts`'s `renderDiffToHtml` is deliberately not audited here: it only
 * ever produces an inner `<div class="diff">` *fragment* returned inside a
 * JSON API response (`GET /wiki/pages/:id/diff`, see `wiki/index.ts`), not
 * a document a browser ever navigates to directly — it has no `<html>`/
 * `<head>`/landmarks of its own to check, and every rule below that would
 * apply to it (`label`, `image-alt`, ...) has nothing to fire on in a
 * fragment containing only `<div>`s of escaped text.
 *
 * `color-contrast` is excluded from every run: it needs a real layout
 * engine (canvas-backed color sampling) that jsdom does not provide, so it
 * would only ever report "can't tell" (jsdom has no such rule), and in
 * practice a request for a canvas-less DOM causes axe-core to throw rather
 * than degrade — excluding the rule keeps this check deterministic and
 * meaningful for every rule that *can* be evaluated against parsed markup
 * alone (headings, labels, landmarks, alt text, language, focusable
 * skip-link target, ...), which is exactly this feature's own step 1/2
 * scope ("semantic HTML, form label associations, ... heading order, alt
 * text on any images, focus states").
 */
import { JSDOM } from "jsdom";
import axeCore, { type Result as AxeResult } from "axe-core";
import { describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isErr, isOk, unwrap } from "../../../src/core/types.js";
import * as htmlRendererModule from "../../../src/plugins/html-renderer/index.js";
import { compileTemplate } from "../../../src/plugins/html-renderer/src/template.js";
import type { RenderTemplateCapability } from "../../../src/plugins/html-renderer/index.js";
import {
  renderHomePage,
  renderPageView,
  type HomePageContext,
  type PageViewContext,
} from "../../../src/plugins/wiki/src/page-templates.js";
import {
  CREATE_PAGE_FORM_ACTION,
  editPageFormAction,
  renderPageFormHtml,
  type PageFormContext,
} from "../../../src/plugins/wiki/src/page-form.js";
import type { NamespaceTreeNode } from "../../../src/plugins/wiki/src/types.js";

/** Minimal, schema-shaped manifest fixture — mirrors page-templates.test.ts's own `manifest()` helper. */
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
 * Load the real html-renderer plugin plus a fixture consumer whose
 * `onEnable` calls `run` with the real `compileWithLayout` — same pattern
 * `page-templates.test.ts`'s `withRealCompileWithLayout` establishes.
 */
async function withRealCompileWithLayout(
  run: (compileWithLayout: RenderTemplateCapability["compileWithLayout"]) => void,
): Promise<void> {
  const consumerManifest = manifest("wiki-accessibility-consumer", {
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

/** Same 2-level namespace hierarchy fixture `page-templates.test.ts` uses. */
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
];

/** A real, un-mocked `render()` — same precedent `page-form.test.ts` establishes for auditing `page-form.ts` without the full capability broker. */
const render: RenderTemplateCapability["render"] = (source, context) => {
  const compiled = compileTemplate(source);
  if (!compiled.ok) {
    return compiled;
  }
  return { ok: true, value: compiled.value.render(context) };
};

/**
 * Parse `html` (a complete `<!doctype html>...</html>` document string) into
 * a real DOM via jsdom and run axe-core against it, restricted to WCAG
 * 2.0/2.1 A+AA and axe's own "best-practice" rules, minus `color-contrast`
 * (see this module's doc comment). Returns axe's own `violations` array —
 * empty means clean.
 */
async function auditHtml(html: string): Promise<AxeResult[]> {
  const dom = new JSDOM(html, { url: "https://example.test/wiki/", pretendToBeVisual: true });
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousDocument = (globalThis as { document?: unknown }).document;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    NodeList: dom.window.NodeList,
    HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  });
  try {
    const results = await axeCore.run(dom.window.document.documentElement, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] },
      rules: { "color-contrast": { enabled: false } },
    });
    return results.violations;
  } finally {
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
    dom.window.close();
  }
}

/** Turns axe's violation objects into a readable failure message (rule id + help text + affected selector per node). */
function describeViolations(violations: readonly AxeResult[]): string {
  return violations
    .map((violation) => {
      const targets = violation.nodes.map((node) => node.target.join(" ")).join(", ");
      return `${violation.id}: ${violation.help} (${targets})`;
    })
    .join("\n");
}

describe("wiki HTML templates have no axe-core violations (feature #102 step 3)", () => {
  it("the home page", async () => {
    let html = "";
    const context: HomePageContext = { navTree: NAV_TREE, pageCount: 2, namespaceCount: 1 };
    await withRealCompileWithLayout((compileWithLayout) => {
      html = unwrap(renderHomePage(compileWithLayout, context));
    });

    const violations = await auditHtml(html);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it("the home page with an empty navigation tree", async () => {
    let html = "";
    const context: HomePageContext = { navTree: [], pageCount: 0, namespaceCount: 0 };
    await withRealCompileWithLayout((compileWithLayout) => {
      html = unwrap(renderHomePage(compileWithLayout, context));
    });

    const violations = await auditHtml(html);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it("a single page view", async () => {
    let html = "";
    const context: PageViewContext = {
      navTree: NAV_TREE,
      pageTitle: "Getting Started",
      markdown: "Welcome! See the **FAQ** for more, or [browse pages](/wiki/pages/2).",
    };
    await withRealCompileWithLayout((compileWithLayout) => {
      html = unwrap(renderPageView(compileWithLayout, context));
    });

    const violations = await auditHtml(html);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it("the create-page form", async () => {
    const context: PageFormContext = {
      isEdit: false,
      namespaceId: "",
      slug: "",
      title: "",
      content: "",
      actionPath: CREATE_PAGE_FORM_ACTION,
      actionMethod: "POST",
    };
    const html = unwrap(renderPageFormHtml(context, render));

    const violations = await auditHtml(html);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it("the edit-page form", async () => {
    const context: PageFormContext = {
      isEdit: true,
      pageId: 7,
      namespaceId: "docs",
      slug: "getting-started",
      title: "Getting Started",
      content: "Welcome!",
      actionPath: editPageFormAction(7),
      actionMethod: "PATCH",
    };
    const html = unwrap(renderPageFormHtml(context, render));

    const violations = await auditHtml(html);
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});

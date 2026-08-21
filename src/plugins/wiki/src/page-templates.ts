/**
 * Wiki home page and page-view HTML templates (feature #95 — "Wiki home
 * page and navigation UI rendered via html-renderer layouts").
 *
 * ## Step 1: built via html-renderer's layout/partial system
 *
 * `WIKI_LAYOUT` is a small, fixed HTML shell exposing `title`/`content`
 * blocks (feature #48's layout system, `html-renderer/src/layout.ts`) —
 * `HOME_TEMPLATE` and {@link buildPageViewSource}'s generated source both
 * `{{extends wiki-layout}}` it, exactly like `html-renderer/src/
 * error-pages.ts`'s own `NOT_FOUND_TEMPLATE`/`SERVER_ERROR_TEMPLATE`
 * precedent. `NAV_TREE_PARTIAL` is a reusable, parameterized fragment
 * (feature #49's partial system, `html-renderer/src/partial.ts`) that
 * renders one level of a {@link NamespaceTreeNode} list and recursively
 * includes itself (`{{> wiki-nav-tree nodes=children}}`) for nested
 * namespaces — the "nested menu" use case partial.ts's own module doc
 * anticipates, and the reason this module needs feature #95's own addition
 * to `compileWithLayout` (an optional `partials` argument composing the two
 * systems in a single call — see `layout.ts`'s "Composing with partials"
 * doc section): a namespace hierarchy has no fixed depth (`types.ts`'s
 * `NamespaceTreeNode` doc comment: "nothing here bounds the depth"), so a
 * fixed number of nested `{{#each}}` tags in a static template could never
 * render it in general — recursion is required, not optional.
 *
 * Every function here takes its `RenderTemplateCapability["compileWithLayout"]`
 * handle as a parameter rather than importing html-renderer directly —
 * `markdown.ts`'s `renderMarkdownToHtml`/`diff.ts`'s `renderDiffToHtml` set
 * this same precedent: a plugin may only cross into another plugin's
 * internals via a kernel-brokered capability (`docs/plugin-conventions.md`
 * section 5), never a direct import, so the actual `compileWithLayout`
 * implementation is always obtained by the caller (a route handler, or a
 * test) via `context.capabilities.obtain<RenderTemplateCapability>
 * ("render:template")` and passed in here.
 *
 * ## Step 2: the navigation sidebar (feature #91) wired into the shared
 * layout
 *
 * `WIKI_LAYOUT` renders `{{> wiki-nav-tree nodes=navTree}}` inside a
 * `<nav aria-label="Wiki navigation">` landmark, in the layout's own fixed
 * structure — not inside either block — so *every* page compiled through
 * this layout (home, page-view, and any future wiki page) gets the same
 * navigation sidebar for free, sourced from a single `navTree` value in the
 * render-time context. `navTree` is expected to be whatever feature #91's
 * `page-tree.ts`'s `WikiPageTreeStore.getPageTree()` returns — this module
 * has no opinion on *how* that tree was fetched (no `db:query` handle
 * appears anywhere below), only on how to render it once it's in hand,
 * mirroring how `markdown.ts` never reads a page from the database either.
 *
 * ## Safety: still "data, not a raw string" — no `{{{raw}}}` anywhere
 *
 * A page's Markdown body is never rendered to an HTML *string* and then
 * spliced into the page-view template as `{{{raw contentHtml}}}` (which
 * would need feature #50's audited raw-output escape hatch and a
 * `RawOutputAuditContext`). Instead {@link buildPageViewSource} reuses
 * `markdown.ts`'s `compileMarkdownTemplate` directly: it returns a template
 * *source* string built entirely from fixed literal tag text plus
 * `{{mdN}}` placeholders (never the page's own words), which this module
 * splices as literal *source* text into the page-view template's `content`
 * block before compiling the whole thing in one `compileWithLayout` call.
 * Every `{{mdN}}`/`{{pageTitle}}`/nav-tree interpolation is still an
 * ordinary, auto-escaped template variable — exactly the same safety
 * property `markdown.ts`/`diff.ts` already rely on, just composed one level
 * higher through a shared layout.
 */
import type { ValidationError } from "../../../core/errors.js";
import { ok, type Result } from "../../../core/types.js";
import type {
  LayoutSource,
  PartialSource,
  RenderTemplateCapability,
  TemplateContext,
} from "../../html-renderer/index.js";
import { compileMarkdownTemplate, parseMarkdown } from "./markdown.js";
import type { NamespaceTreeNode } from "./types.js";

/** Name `HOME_TEMPLATE`/`buildPageViewSource`'s generated source extend via `{{extends}}`. */
const LAYOUT_NAME = "wiki-layout";
/** Name the navigation sidebar's recursive partial is registered under, and calls itself under. */
const NAV_PARTIAL_NAME = "wiki-nav-tree";

/**
 * Accessibility pass (feature #102): fixed, literal CSS text only — no
 * `{{variable}}` interpolation anywhere inside it, so it needs no escaper
 * (mirrors `PAGE_FORM_SCRIPT`'s own "fixed literal source, nothing
 * user-controlled spliced in" precedent, just for a `<style>` block instead
 * of a `<script>` one). Two rules:
 *
 *   - `.wiki-skip-link` is the standard "visually hidden until focused"
 *     skip-navigation pattern: off-screen by default, snapped into view
 *     with a clearly visible outline the instant it receives keyboard
 *     focus, so a keyboard user never has to tab through the entire
 *     navigation sidebar just to reach `{{#block content}}` (step 1's
 *     "keyboard navigability" + step 2's "focus states").
 *   - `:focus-visible` on the sidebar's own links reinforces the same
 *     "focus must be visible" requirement for every link the recursive
 *     `wiki-nav-tree` partial renders, without changing mouse-click
 *     appearance (`:focus-visible` only matches keyboard/programmatic
 *     focus, not a mouse click).
 */
const WIKI_LAYOUT_STYLE = [
  ".wiki-skip-link{position:absolute;left:-9999px;top:0;padding:0.5em 1em;",
  "background:#000;color:#fff;z-index:100;}",
  ".wiki-skip-link:focus{left:0;outline:3px solid #005fcc;outline-offset:2px;}",
  ".wiki-sidebar a:focus-visible,.wiki-content a:focus-visible{outline:3px solid #005fcc;outline-offset:2px;}",
].join("");

const WIKI_LAYOUT = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8" />',
  "<title>{{#block title}}Wiki{{/block}}</title>",
  `<style>${WIKI_LAYOUT_STYLE}</style>`,
  "</head>",
  "<body>",
  '<a class="wiki-skip-link" href="#wiki-main-content">Skip to main content</a>',
  '<header class="wiki-header"><p class="wiki-title"><a href="/wiki">Wiki</a></p></header>',
  '<div class="wiki-layout">',
  `<nav class="wiki-sidebar" aria-label="Wiki navigation">{{> ${NAV_PARTIAL_NAME} nodes=navTree}}</nav>`,
  '<main id="wiki-main-content" class="wiki-content" tabindex="-1">{{#block content}}{{/block}}</main>',
  "</div>",
  "</body>",
  "</html>",
].join("");

/**
 * Renders one level of a {@link NamespaceTreeNode} list (`nodes`, an
 * isolated-scope partial parameter — see `partial.ts`'s "Isolated scope"
 * doc section, which is why every recursive call below re-passes `nodes`
 * explicitly rather than relying on any implicit scope fallback): each
 * namespace's own pages link straight to `/wiki/pages/:id` (the `get`
 * route feature #94 already registered — a `PageTreeEntry`'s `id` is a
 * page's real surrogate key, so no namespace-scoped path segment is
 * needed), and each namespace's `children` (if any) recurse into another
 * `{{> wiki-nav-tree}}` call, one level of `<ul>` nesting at a time, to
 * whatever depth the actual hierarchy has.
 */
const NAV_TREE_PARTIAL = [
  "{{#if nodes}}",
  '<ul class="wiki-nav-list">',
  "{{#each nodes}}",
  '<li class="wiki-nav-namespace">',
  '<span class="wiki-nav-namespace-name">{{name}}</span>',
  "{{#if pages}}",
  '<ul class="wiki-nav-pages">',
  "{{#each pages}}",
  '<li class="wiki-nav-page"><a href="/wiki/pages/{{id}}">{{title}}</a></li>',
  "{{/each}}",
  "</ul>",
  "{{/if}}",
  "{{#if children}}",
  `{{> ${NAV_PARTIAL_NAME} nodes=children}}`,
  "{{/if}}",
  "</li>",
  "{{/each}}",
  "</ul>",
  "{{/if}}",
].join("");

function layoutSource(name: string): string | undefined {
  return name === LAYOUT_NAME ? WIKI_LAYOUT : undefined;
}

function partialSource(name: string): string | undefined {
  return name === NAV_PARTIAL_NAME ? NAV_TREE_PARTIAL : undefined;
}

/** `LayoutSource` every render function below hands to `compileWithLayout`. */
const WIKI_LAYOUTS: LayoutSource = layoutSource;
/** `PartialSource` every render function below hands to `compileWithLayout`'s `partials` argument. */
const WIKI_PARTIALS: PartialSource = partialSource;

/** Data every page rendered through {@link WIKI_LAYOUT} needs — the navigation sidebar (step 2). */
export interface WikiNavData {
  /** The full nested tree feature #91's `page-tree.ts` (`WikiPageTreeStore.getPageTree()`) builds. */
  readonly navTree: readonly NamespaceTreeNode[];
}

const HOME_TEMPLATE = [
  `{{extends ${LAYOUT_NAME}}}`,
  "{{#block title}}Wiki Home{{/block}}",
  "{{#block content}}",
  "<h1>Welcome to the wiki</h1>",
  "<p>{{pageCount}} pages across {{namespaceCount}} namespaces.</p>",
  "<p>Use the navigation sidebar to browse namespaces and pages.</p>",
  "{{/block}}",
].join("");

export interface HomePageContext extends WikiNavData {
  readonly pageCount: number;
  readonly namespaceCount: number;
}

/**
 * Render the wiki home page (step 1 + step 2). `compileWithLayout` is the
 * real `render:template` capability's own function (feature #95's addition
 * to `RenderTemplateCapability`) — see this module's doc comment for why
 * it's a parameter, not an import.
 */
export function renderHomePage(
  compileWithLayout: RenderTemplateCapability["compileWithLayout"],
  context: HomePageContext,
): Result<string, ValidationError> {
  const compiled = compileWithLayout(HOME_TEMPLATE, WIKI_LAYOUTS, undefined, WIKI_PARTIALS);
  if (!compiled.ok) {
    return compiled;
  }
  const renderContext: TemplateContext = {
    navTree: context.navTree,
    pageCount: context.pageCount,
    namespaceCount: context.namespaceCount,
  };
  return ok(compiled.value.render(renderContext));
}

export interface PageViewContext extends WikiNavData {
  /** The page's `title` (feature #87's `Page.title`). */
  readonly pageTitle: string;
  /** The page's Markdown `content` (feature #87's `Page.content`) — rendered here, never pre-rendered to HTML by the caller (see this module's doc comment's "Safety" section). */
  readonly markdown: string;
}

/**
 * Build the page-view template source for one request: `markdownSource` is
 * `compileMarkdownTemplate`'s own output (fixed literal tag text plus
 * `{{mdN}}` placeholders — never the page's raw words), spliced as literal
 * *source* text into the `content` block. Exported for direct unit testing
 * of the composed source shape, independent of an actual render.
 */
export function buildPageViewSource(markdownSource: string): string {
  return [
    `{{extends ${LAYOUT_NAME}}}`,
    "{{#block title}}{{pageTitle}}{{/block}}",
    "{{#block content}}",
    '<article class="wiki-page">',
    "<h1>{{pageTitle}}</h1>",
    markdownSource,
    "</article>",
    "{{/block}}",
  ].join("");
}

/**
 * Render a single wiki page (step 1 + step 2): the page's Markdown body
 * (feature #88's rendering, reused via `markdown.ts`'s
 * `compileMarkdownTemplate`) composed with the shared `WIKI_LAYOUT` and its
 * navigation sidebar, all in one `compileWithLayout` call.
 */
export function renderPageView(
  compileWithLayout: RenderTemplateCapability["compileWithLayout"],
  context: PageViewContext,
): Result<string, ValidationError> {
  const { source: markdownSource, context: markdownContext } = compileMarkdownTemplate(
    parseMarkdown(context.markdown),
  );
  const source = buildPageViewSource(markdownSource);
  const compiled = compileWithLayout(source, WIKI_LAYOUTS, undefined, WIKI_PARTIALS);
  if (!compiled.ok) {
    return compiled;
  }
  const mergedContext: TemplateContext = {
    navTree: context.navTree,
    pageTitle: context.pageTitle,
    ...markdownContext,
  };
  return ok(compiled.value.render(mergedContext));
}

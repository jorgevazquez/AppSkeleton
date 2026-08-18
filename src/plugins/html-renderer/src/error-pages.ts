/**
 * Default 404/500 error page templates (feature #55 — "Safe error page
 * templates (404/500) that never leak stack traces in production").
 *
 * ## Rendered via the layout system (step 1)
 *
 * `ERROR_PAGE_LAYOUT` is a small self-contained HTML shell exposing
 * `title`/`content` blocks; `NOT_FOUND_TEMPLATE` and `SERVER_ERROR_TEMPLATE`
 * both `{{extends error-page-layout}}` it and fill those blocks in, so both
 * pages are compiled through feature #48's `compileWithLayout` (`layout.ts`)
 * rather than being two independent, hand-duplicated HTML strings. A future
 * feature that wants to restyle every error page only has to touch the one
 * shared layout.
 *
 * Both templates are fixed, module-owned source strings — never
 * user-supplied — so a compile failure here can only mean a bug in this
 * file itself; they're compiled once, eagerly, at module load via
 * `unwrap()` (throwing immediately, at import time, rather than forcing
 * every render call site to thread a `Result` through for a template that
 * can only ever fail during development of this module).
 *
 * ## No stack-trace leak in production (step 2)
 *
 * `renderServerErrorPage()` accepts the *raw error* and the effective
 * `NODE_ENV` together — deciding what may be shown lives here, not at each
 * call site. Internal detail (the error's own `message` and `stack`) is
 * only ever placed into the render context when `nodeEnv === "development"`
 * (matching this feature's literal wording: shown in development, hidden
 * everywhere else — production, test, and any unrecognized value). The
 * template's own `{{#if showDetail}}` guard is a second, independent layer
 * on top of that: even a future edit that accidentally left
 * `detailMessage`/`detailStack` in the context for a non-development call
 * would still need `showDetail` itself to be wrong before anything leaked.
 * Whatever *is* shown is interpolated via ordinary `{{variable}}` tags, so
 * it is still HTML-escaped like any other template value — an error
 * message that happens to contain attacker-controlled text (e.g. echoed
 * from a request) can't break out of the `<pre>` block it's rendered in.
 */
import type { CoreConfig } from "../../../core/config.js";
import { unwrap } from "../../../core/types.js";
import { compileWithLayout } from "./layout.js";
import type { TemplateContext } from "./template.js";

/** Name `NOT_FOUND_TEMPLATE`/`SERVER_ERROR_TEMPLATE` extend via `{{extends}}`. */
const LAYOUT_NAME = "error-page-layout";

const ERROR_PAGE_LAYOUT = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8" />',
  "<title>{{#block title}}Error{{/block}}</title>",
  "</head>",
  "<body>",
  "<main>{{#block content}}{{/block}}</main>",
  "</body>",
  "</html>",
].join("");

const NOT_FOUND_TEMPLATE = [
  `{{extends ${LAYOUT_NAME}}}`,
  "{{#block title}}404 Not Found{{/block}}",
  "{{#block content}}",
  "<h1>404 — Not Found</h1>",
  "<p>The page you requested could not be found.</p>",
  "{{#if path}}<p>No route matches <code>{{path}}</code>.</p>{{/if}}",
  "{{/block}}",
].join("");

const SERVER_ERROR_TEMPLATE = [
  `{{extends ${LAYOUT_NAME}}}`,
  "{{#block title}}500 Internal Server Error{{/block}}",
  "{{#block content}}",
  "<h1>500 — Internal Server Error</h1>",
  "<p>Something went wrong on our end. Please try again later.</p>",
  "{{#if showDetail}}",
  "<pre>{{detailMessage}}",
  "{{detailStack}}</pre>",
  "{{/if}}",
  "{{/block}}",
].join("");

function layoutSource(name: string): string | undefined {
  return name === LAYOUT_NAME ? ERROR_PAGE_LAYOUT : undefined;
}

const notFoundPage = unwrap(compileWithLayout(NOT_FOUND_TEMPLATE, layoutSource));
const serverErrorPage = unwrap(compileWithLayout(SERVER_ERROR_TEMPLATE, layoutSource));

export interface NotFoundPageContext {
  /** The unmatched request path, echoed back safely (auto-escaped like any other variable). */
  readonly path?: string;
}

/** Render the default 404 page. See the module doc comment for the layout this composes through. */
export function renderNotFoundPage(context: NotFoundPageContext = {}): string {
  return notFoundPage.render(context as TemplateContext);
}

export interface ServerErrorPageOptions {
  /**
   * The error that caused the 500, if any. Only its `message`/`stack` are
   * ever considered, and only when `nodeEnv === "development"` — see the
   * module doc comment's "No stack-trace leak in production" section.
   */
  readonly error?: unknown;
  /** The effective runtime NODE_ENV. Governs whether `error` detail is shown at all. */
  readonly nodeEnv: CoreConfig["NODE_ENV"];
}

function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
    };
  }
  if (error === undefined) {
    return { message: "" };
  }
  return { message: String(error) };
}

/**
 * Render the default 500 page. Error detail (`error`'s message and stack
 * trace) is placed into the render context — and therefore ever appears in
 * the returned HTML — only when `options.nodeEnv === "development"`; every
 * other value (`"production"`, `"test"`, anything else) renders the same
 * generic page with no trace of `error` at all.
 */
export function renderServerErrorPage(options: ServerErrorPageOptions): string {
  const showDetail = options.nodeEnv === "development";
  const context: TemplateContext = { showDetail };
  if (showDetail) {
    const { message, stack } = describeError(options.error);
    context["detailMessage"] = message;
    context["detailStack"] = stack ?? "";
  }
  return serverErrorPage.render(context);
}

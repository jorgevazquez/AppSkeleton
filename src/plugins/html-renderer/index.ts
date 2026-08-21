/**
 * html-renderer plugin lifecycle module (feature #52 — "Expose
 * render:template as a consumable capability").
 *
 * Registers feature #46/#47's compile/render machinery (`compileTemplate` —
 * see `./src/template.ts` for the full grammar, auto-escaping, and
 * compile-once/render-many contract this defers to entirely) as the
 * `render:template` capability this plugin's manifest already declares
 * under `capabilities.provides`. Any other plugin that lists
 * `render:template` under its own `capabilities.requires` and is granted it
 * can compile and render templates through the broker — no direct import of
 * this plugin's internals, only the kernel-brokered handle, exactly like
 * rbac's `rbac:check` (feature #39, see `../rbac/index.ts`, whose
 * declare-provides-at-module-scope shape this module follows) and
 * api-gateway's `http:route` (feature #59).
 *
 * ## Two functions, one capability
 *
 * `compileTemplate` itself needs no per-instance construction — no Fastify
 * app to build in `onEnable`, no mutable backing store to seed — it is a
 * pure function from the moment this module is imported, so (like rbac's
 * `check()`) this plugin exports no lifecycle hooks at all. `render:template`
 * exposes it two ways:
 *
 *   - `compile(source, options?)` — the raw compile-once/render-many
 *     primitive, for a caller that renders the same template repeatedly
 *     against different contexts (e.g. api-gateway rendering the same page
 *     template per request) and wants to pay the parse/compile cost once.
 *   - `render(source, context?, options?)` — a compile-and-render-once
 *     convenience for the common case of a caller that only needs a single
 *     pass, so it doesn't have to thread a `Result`-unwrap plus a
 *     `.render()` call through every call site itself.
 *
 * Both return the same `Result<_, ValidationError>` shape `compileTemplate`
 * already uses (see core/types.ts's `Result` convention) — a malformed
 * template is a typed `Err`, never a thrown exception, for either entry
 * point.
 *
 * ## Scope of this feature
 *
 * What feature #52 depends on (features #46 and #47: variables/
 * conditionals/loops, auto-escaping) is exposed here as `compile`/`render`.
 * `compileTemplate`'s own `CompileOptions` (the `audit` field) is exposed
 * pass-through on every entry point below, so a caller that supplies one
 * for a template containing `{{{raw ...}}}` gets the same audited behavior
 * `compileTemplate` already provides directly.
 *
 * Layouts (#48) and partials (#49) — `./src/layout.ts`'s `compileWithLayout`
 * and `./src/partial.ts`'s `compileWithPartials` — were deliberately left
 * out of this capability's surface when it was first built, per this
 * module's own note at the time ("widening the capability surface to cover
 * those is a later feature's job, not this one's"). Feature #95 ("Wiki home
 * page and navigation UI rendered via html-renderer layouts") is that later
 * feature: a plugin like `wiki` needs to compose a shared page layout with
 * per-request dynamic data (a page's rendered content, a navigation tree of
 * unknown depth) without importing html-renderer's internals directly (only
 * a kernel-brokered capability may cross a plugin boundary — see
 * `docs/plugin-conventions.md` section 5) — so `compileWithLayout` and
 * `compileWithPartials` are now exposed here too, as thin pass-throughs
 * with the exact same signatures/`Result` contract their underlying
 * modules already have.
 */
import type { ValidationError } from "../../core/errors.js";
import { ok, type Result } from "../../core/types.js";
import {
  renderNotFoundPage,
  renderServerErrorPage,
  type NotFoundPageContext,
  type ServerErrorPageOptions,
} from "./src/error-pages.js";
import { compileWithLayout as compileWithLayoutImpl, type LayoutSource } from "./src/layout.js";
import {
  compileWithPartials as compileWithPartialsImpl,
  type PartialSource,
} from "./src/partial.js";
import {
  compileTemplate,
  type CompileOptions,
  type CompiledTemplate,
  type TemplateContext,
} from "./src/template.js";

// Re-exported so a consuming plugin can type-only import everything it needs
// for `capabilities.obtain<RenderTemplateCapability>("render:template")`
// calls from this one module, the same way api-gateway re-exports its own
// route-capability types from `index.ts`.
export type { CompileOptions, CompiledTemplate, TemplateContext } from "./src/template.js";
// Re-exported for the same reason (feature #95) — a consumer building a
// `compileWithLayout`/`compileWithPartials` call needs these two registry
// shapes without reaching into `./src/layout.js`/`./src/partial.js`
// directly.
export type { LayoutSource } from "./src/layout.js";
export type { PartialSource } from "./src/partial.js";

// Re-exported so a consuming plugin can type-only import everything it needs
// for `capabilities.obtain<ErrorPagesCapability>("html:error-pages")` calls
// from this one module — feature #116, see `./src/error-pages.js` (feature
// #55) for the full render contract these two functions defer to entirely.
export type { NotFoundPageContext, ServerErrorPageOptions } from "./src/error-pages.js";

/**
 * What `render:template` hands back to a consuming plugin.
 */
export interface RenderTemplateCapability {
  /**
   * Parse and compile `source` once into a {@link CompiledTemplate}. See
   * `template.ts`'s `compileTemplate` for the full grammar/escaping/
   * error-reporting contract this defers to entirely.
   */
  compile(source: string, options?: CompileOptions): Result<CompiledTemplate, ValidationError>;
  /**
   * Compile `source` and render it once against `context` in a single call.
   * Equivalent to `compile(source, options)` followed by `.render(context)`
   * on success — a convenience for callers that don't need to reuse the
   * compiled template across multiple renders.
   */
  render(
    source: string,
    context?: TemplateContext,
    options?: CompileOptions,
  ): Result<string, ValidationError>;
  /**
   * Compile `source` — which may contain `{{extends name}}` — through its
   * full layout chain, resolving named layouts via `layouts`. Thin pass-
   * through to `./src/layout.js`'s `compileWithLayout` (feature #48); see
   * that function's own doc comment for the full resolution algorithm.
   * `partials` (feature #95's own addition to `compileWithLayout` itself)
   * additionally resolves any `{{> name}}` tag reachable in the resolved
   * tree — omit it for a layout chain with no partials of its own, exactly
   * like calling `compileWithLayout` directly.
   */
  compileWithLayout(
    source: string,
    layouts: LayoutSource,
    options?: CompileOptions,
    partials?: PartialSource,
  ): Result<CompiledTemplate, ValidationError>;
  /**
   * Compile `source` — which may contain `{{> name ...}}` tags but not
   * `{{extends}}` — resolving named partials via `partials`. Thin pass-
   * through to `./src/partial.js`'s `compileWithPartials` (feature #49);
   * see that function's own doc comment for the full resolution/error
   * contract (an unknown partial name, a referenced partial's own parse
   * error, or exceeding the max recursion depth throws a `RenderError`
   * from the returned `CompiledTemplate.render()`, never a `Result` — only
   * a malformed `source` itself is a `Result` error here).
   */
  compileWithPartials(
    source: string,
    partials: PartialSource,
    options?: CompileOptions,
  ): Result<CompiledTemplate, ValidationError>;
}

function compile(
  source: string,
  options?: CompileOptions,
): Result<CompiledTemplate, ValidationError> {
  return compileTemplate(source, options);
}

function render(
  source: string,
  context?: TemplateContext,
  options?: CompileOptions,
): Result<string, ValidationError> {
  const compiled = compileTemplate(source, options);
  if (!compiled.ok) {
    return compiled;
  }
  return ok(compiled.value.render(context));
}

function compileWithLayout(
  source: string,
  layouts: LayoutSource,
  options?: CompileOptions,
  partials?: PartialSource,
): Result<CompiledTemplate, ValidationError> {
  return compileWithLayoutImpl(source, layouts, options, partials);
}

function compileWithPartials(
  source: string,
  partials: PartialSource,
  options?: CompileOptions,
): Result<CompiledTemplate, ValidationError> {
  return compileWithPartialsImpl(source, partials, options);
}

/**
 * What `html:error-pages` hands back to a consuming plugin (feature #116 —
 * "End-to-end wired 404/500 error pages through html-renderer and
 * api-gateway"). Thin pass-through to `./src/error-pages.js`'s two render
 * functions (feature #55) — no state, no per-instance construction, for the
 * same reason `render:template` above needs none.
 */
export interface ErrorPagesCapability {
  /** Render the default 404 page. See `error-pages.ts`'s `renderNotFoundPage` docs. */
  renderNotFoundPage(context?: NotFoundPageContext): string;
  /** Render the default 500 page. See `error-pages.ts`'s `renderServerErrorPage` docs — in particular, no stack-trace leak outside `nodeEnv: "development"`. */
  renderServerErrorPage(options: ServerErrorPageOptions): string;
}

/**
 * Registered with the broker before this module's lifecycle hooks would run
 * (see `loader.ts`'s declare-before-hooks ordering). Both `render:template`
 * and `html:error-pages` need no per-instance construction — every function
 * either exposes is a stable closure over a pure function from the moment
 * this module is imported, so, like rbac's `rbac:check`, this plugin
 * currently exports no lifecycle hooks at all.
 */
export const provides: Readonly<Record<string, unknown>> = {
  "render:template": {
    compile,
    render,
    compileWithLayout,
    compileWithPartials,
  } satisfies RenderTemplateCapability,
  "html:error-pages": {
    renderNotFoundPage,
    renderServerErrorPage,
  } satisfies ErrorPagesCapability,
};

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
 * Only what feature #52 depends on (features #46 and #47: variables/
 * conditionals/loops, auto-escaping) is exposed here. Layouts (#48),
 * partials (#49), and raw/audited output (#50) are already implemented in
 * `./src/template.ts`/`layout.ts`/`partial.ts` but deliberately not part of
 * this capability's surface yet — `compileTemplate`'s own `CompileOptions`
 * (the `audit` field) is still exposed pass-through, so a caller that
 * supplies one for a template containing `{{{raw ...}}}` gets the same
 * audited behavior `compileTemplate` already provides directly, but
 * `compileWithLayout`/`compileWithPartials` are not wired into
 * `render:template` here. Widening the capability surface to cover those is
 * a later feature's job, not this one's.
 */
import type { ValidationError } from "../../core/errors.js";
import { ok, type Result } from "../../core/types.js";
import {
  renderNotFoundPage,
  renderServerErrorPage,
  type NotFoundPageContext,
  type ServerErrorPageOptions,
} from "./src/error-pages.js";
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
  "render:template": { compile, render } satisfies RenderTemplateCapability,
  "html:error-pages": {
    renderNotFoundPage,
    renderServerErrorPage,
  } satisfies ErrorPagesCapability,
};

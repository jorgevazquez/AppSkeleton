/**
 * Partial/component resolution for the html-renderer template engine
 * (feature #49 — "Partials/components (reusable, parameterized template
 * fragments)"). Builds on template.ts's grammar/AST/compiler: `{{> name}}`
 * and `{{> name key=value ...}}` (a `PartialNode` leaf) are part of that
 * module's tokenizer/parser — this module is the layer that actually
 * *resolves* a partial's name to source text, mirroring how layout.ts
 * resolves `{{extends}}` against a named-layout registry.
 *
 * ## Why this isn't "resolve everything up front" like layout.ts
 *
 * layout.ts's `compileWithLayout` walks the whole `{{extends}}` chain and
 * splices resolved block bodies into a single AST *before* compiling
 * anything — that works because a layout chain is a fixed, finite,
 * acyclic-or-rejected structure known entirely at compile time.
 *
 * A partial is different: its body may itself contain `{{> ...}}` tags,
 * including — the standard way to render a recursive structure like a
 * comment thread or nested menu — a reference back to itself. Eagerly
 * resolving and compiling every reachable partial before `render()` is
 * even callable would try to compile a self-including partial's body
 * forever and never finish. So partial resolution instead happens lazily,
 * per name, the first time a given `{{> name}}` tag actually *runs* at
 * render time (see `resolvePartial` below) — compiled once per name and
 * cached thereafter, not once per call site or per render. The thing that
 * actually stops a self-including (or mutually-including) partial from
 * recursing forever is template.ts's `MAX_PARTIAL_DEPTH` render-time
 * check, not anything about *when* compilation happens.
 *
 * ## Isolated scope
 *
 * Each `{{> name key=value}}` call's parameters — resolved against the
 * *call site's* scope — become the partial body's entire context; nothing
 * else from the call site leaks in (no Mustache-style fallback to the
 * caller's own data, unlike `{{#each}}`). See template.ts's "partial"
 * compiler case and its module doc's "Partials/components" section.
 *
 * ## Errors
 *
 * An unresolvable layout name is a compile-time `Result` error in
 * layout.ts, because the whole `{{extends}}` chain is walked immediately.
 * Partials can't offer that guarantee — a `{{> name}}` tag might sit inside
 * a branch that's never actually taken at render time, and eagerly
 * checking every name referenced anywhere in the template (including
 * inside not-yet-resolved partial bodies) runs into the same
 * "would-recurse-forever-at-compile-time" problem `{{extends}}` doesn't
 * have. So an unknown partial name, a partial whose own source fails to
 * parse, and exceeding {@link MAX_PARTIAL_DEPTH} (imported from
 * template.ts) are all reported the same way: a {@link RenderError} thrown
 * from `CompiledTemplate.render()` — never a `Result`, and never at
 * `compileWithPartials()` time itself. See RenderError's own doc comment
 * in core/errors.ts.
 */
import { RenderError, ValidationError } from "../../../core/errors.js";
import { err, ok, type Result } from "../../../core/types.js";
import {
  compilePartialBody,
  parseTemplate,
  walkTemplateNodes,
  type CompiledPartialBody,
  type CompiledTemplate,
  type PartialResolver,
  type TemplateContext,
} from "./template.js";

/** How `compileWithPartials` looks up a named partial's source: a plain map, or a resolver function. */
export type PartialSource =
  Readonly<Record<string, string>> | ((name: string) => string | undefined);

function resolvePartialSource(partials: PartialSource, name: string): string | undefined {
  return typeof partials === "function" ? partials(name) : partials[name];
}

/**
 * Compile `source` — a template that may contain `{{> name ...}}` tags —
 * resolving each referenced partial's source text via `partials` (a
 * `{ name: source }` map, or a `name => source | undefined` lookup
 * function for callers with their own template registry/loader). See the
 * module doc comment for the resolution algorithm and error-reporting
 * tradeoffs. Returns a {@link ValidationError} (never throws) for a
 * malformed `source` itself; the returned `CompiledTemplate.render()` may
 * *throw* a {@link RenderError} for a problem only discoverable at render
 * time (an unknown partial name, a referenced partial's own parse error,
 * or exceeding the max recursion depth) — see the module doc's "Errors"
 * section for why that's a throw and not a `Result`.
 *
 * Rejects `source` containing an `{{extends}}` tag: this function doesn't
 * resolve layouts, only partials — use layout.ts's `compileWithLayout` for
 * that (layouts and partials are not currently composable in one call).
 */
export function compileWithPartials(
  source: string,
  partials: PartialSource,
): Result<CompiledTemplate, ValidationError> {
  const rootResult = parseTemplate(source);
  if (!rootResult.ok) {
    return rootResult;
  }

  let hasExtends = false;
  walkTemplateNodes(rootResult.value, (node) => {
    if (node.kind === "extends") {
      hasExtends = true;
    }
  });
  if (hasExtends) {
    return err(
      new ValidationError(
        "Template contains an {{extends}} tag; compileWithPartials does not resolve layouts — " +
          "use compileWithLayout (layout.ts) instead.",
      ),
    );
  }

  // Populated lazily, the first time each name is actually resolved at render time — never
  // eagerly — so a partial that (directly or transitively) includes itself compiles and renders
  // fine, right up until MAX_PARTIAL_DEPTH (enforced inside template.ts's "partial" compiler
  // case, not here) stops it. A cached ValidationError means that name's source failed to parse
  // the first time it was needed; re-resolving it re-throws rather than re-parsing.
  const cache = new Map<string, CompiledPartialBody | ValidationError>();

  const resolvePartial: PartialResolver = (name) => {
    const cached = cache.get(name);
    if (cached !== undefined) {
      if (cached instanceof ValidationError) {
        throw new RenderError(`Partial "${name}" failed to parse: ${cached.message}`, {
          cause: cached,
        });
      }
      return cached;
    }

    const partialSource = resolvePartialSource(partials, name);
    if (partialSource === undefined) {
      return undefined;
    }

    const parsed = parseTemplate(partialSource);
    if (!parsed.ok) {
      cache.set(name, parsed.error);
      throw new RenderError(`Partial "${name}" failed to parse: ${parsed.error.message}`, {
        cause: parsed.error,
      });
    }

    // `resolvePartial` is passed to `compilePartialBody` itself, so a `{{> ...}}` tag inside
    // *this* partial's own body resolves through the same cache/registry — including a reference
    // back to `name` itself.
    const compiledBody = compilePartialBody(parsed.value, resolvePartial);
    cache.set(name, compiledBody);
    return compiledBody;
  };

  const compiled = compilePartialBody(rootResult.value, resolvePartial);
  return ok({
    render(context: TemplateContext = {}): string {
      const out: string[] = [];
      compiled.run(context, 0, out);
      return out.join("");
    },
  });
}

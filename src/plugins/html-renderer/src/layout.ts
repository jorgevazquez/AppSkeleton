/**
 * Layout composition for the html-renderer template engine (feature #48 —
 * "Layout system (base layout plus content blocks)"). Builds on template.ts's
 * grammar/AST: `{{#block "name"}} ... {{/block}}` (a named, fill-in-able
 * region) and `{{extends "layoutName"}}` (marks a template as rendering
 * through another named template) are part of that module's tokenizer/
 * parser/AST — this module is the layer that actually *resolves* an
 * `{{extends}}` chain into a single renderable tree.
 *
 * ## Algorithm
 *
 * Given a child template's source and a way to look up other templates by
 * name (`layouts`, below):
 *
 * 1. Parse the child. If it has no `{{extends}}` tag, it isn't extending
 *    anything — delegate straight to {@link compileTemplate} (this also
 *    covers the "base layout" case: a layout with only `{{#block}}`
 *    defaults and no `{{extends}}` of its own is just a normal template).
 * 2. Otherwise, collect every `{{#block}}` the child defines (its
 *    "overrides") and look up the layout it extends.
 * 3. Parse that layout. Collect its own `{{#block}}`s as *further*
 *    overrides — but only for names not already claimed by a more
 *    specific (closer to the original child) level, so the most specific
 *    override always wins. If *this* layout also has an `{{extends}}`
 *    tag, repeat step 3 against the layout it names — this is what makes
 *    nested layouts work: a layout extending another layout is walked
 *    exactly like a child extending a layout, one level at a time.
 * 4. The first layout in the chain with no `{{extends}}` of its own is the
 *    base. Its structure (text, tags, block placeholders — everything
 *    outside of blocks) is what actually gets rendered: every `{{#block}}`
 *    found anywhere in it (at any nesting depth) has its body swapped for
 *    the resolved override, if one exists, else it keeps rendering its own
 *    default content.
 *
 * A layout name that never resolves to a registered template, or an
 * `{{extends}}` chain that cycles back on itself (or exceeds
 * {@link MAX_LAYOUT_DEPTH}), is reported as a {@link ValidationError} —
 * never thrown, matching template.ts's error convention.
 *
 * ## Escaping stays correct across layout composition
 *
 * The resolved tree — base layout structure with block bodies substituted
 * in — is what gets handed to `compileResolvedNodes`, which runs
 * `annotateEscapeContexts` fresh over *that* tree. So a block's escape
 * context is always determined by where it actually ends up rendering
 * (its position inside the base layout's HTML), never by the surrounding
 * markup in whichever template originally defined its default or override
 * content. A child overriding a block that lands inside an `href="..."` in
 * the base layout gets URL-escaped even if the child itself never
 * mentions an `href` anywhere.
 *
 * ## Composing with partials (feature #95)
 *
 * `compileWithLayout`'s optional fourth argument, `partials`, resolves any
 * `{{> name}}` tag reachable in the resolved tree (whether it lives in the
 * base layout's own fixed structure, a block's default body, or a winning
 * override) via the same lazy, cached {@link PartialResolver} `partial.ts`'s
 * `compileWithPartials` builds — see `partial.ts`'s `createPartialResolver`,
 * which both functions now share. This is what lets a shared layout embed a
 * genuinely recursive component (e.g. a nested navigation tree of unknown
 * depth) directly, rather than needing a caller to pre-render it to an HTML
 * string and splice it in as audited raw output.
 */
import { ValidationError } from "../../../core/errors.js";
import { err, ok, type Result } from "../../../core/types.js";
import { compileWithPartials, createPartialResolver, type PartialSource } from "./partial.js";
import {
  compileResolvedNodes,
  compileTemplate,
  parseTemplate,
  requireRawAudit,
  walkTemplateNodes,
  type CompiledTemplate,
  type CompileOptions,
  type TemplateNode,
} from "./template.js";

export type { PartialSource } from "./partial.js";

/** How `compileWithLayout` looks up a named layout's source: a plain map, or a resolver function. */
export type LayoutSource =
  Readonly<Record<string, string>> | ((name: string) => string | undefined);

/** Cap on how many `{{extends}}` hops a single chain may take, as a backstop beyond cycle detection. */
const MAX_LAYOUT_DEPTH = 20;

function resolveLayoutSource(layouts: LayoutSource, name: string): string | undefined {
  return typeof layouts === "function" ? layouts(name) : layouts[name];
}

/** The name of the (at most one, per parseTemplate's validation) `{{extends}}` tag anywhere in `nodes`. */
function findExtendsName(nodes: readonly TemplateNode[]): string | undefined {
  let found: string | undefined;
  walkTemplateNodes(nodes, (node) => {
    if (node.kind === "extends" && found === undefined) {
      found = node.name;
    }
  });
  return found;
}

/** Every `{{#block}}` in `nodes`, keyed by name (first occurrence wins if a name repeats within one level). */
function collectBlocks(nodes: readonly TemplateNode[]): Map<string, readonly TemplateNode[]> {
  const blocks = new Map<string, readonly TemplateNode[]>();
  walkTemplateNodes(nodes, (node) => {
    if (node.kind === "block" && !blocks.has(node.name)) {
      blocks.set(node.name, node.body);
    }
  });
  return blocks;
}

/**
 * Rebuild `nodes`, replacing each `{{#block}}`'s body with `overrides`'
 * entry for its name (if any — recursively resolved too, in case an
 * override's own content contains further overridable blocks), else
 * leaving its own default body in place (also recursively resolved, so a
 * base layout's default content can itself contain other blocks).
 */
function applyBlockOverrides(
  nodes: readonly TemplateNode[],
  overrides: ReadonlyMap<string, readonly TemplateNode[]>,
): TemplateNode[] {
  return nodes.map((node) => {
    switch (node.kind) {
      case "if":
        return {
          ...node,
          consequent: applyBlockOverrides(node.consequent, overrides),
          alternate: applyBlockOverrides(node.alternate, overrides),
        };
      case "each":
        return { ...node, body: applyBlockOverrides(node.body, overrides) };
      case "block": {
        const winningBody = overrides.get(node.name) ?? node.body;
        return { ...node, body: applyBlockOverrides(winningBody, overrides) };
      }
      default:
        return node;
    }
  });
}

/**
 * Compile `source` — a template that may (or may not) start with
 * `{{extends "layoutName"}}` — through its full layout chain, resolving
 * named layouts via `layouts` (a `{ name: source }` map, or a
 * `name => source | undefined` lookup function for callers with their own
 * template registry/loader). See the module doc comment for the resolution
 * algorithm. Returns a {@link ValidationError} (never throws) for a
 * malformed template, an unresolvable layout name, or a circular/too-deep
 * `{{extends}}` chain.
 *
 * `options.audit` (feature #50) is required if the *resolved* tree — base
 * layout structure with the winning block overrides spliced in — ends up
 * containing a `{{{raw ...}}}` tag anywhere, even one contributed by a
 * single level of the chain; see {@link requireRawAudit}.
 *
 * `partials` (feature #95 — "Wiki home page and navigation UI rendered via
 * html-renderer layouts") is an optional partials registry, same shape as
 * `partial.ts`'s `compileWithPartials` accepts, composing the two systems
 * in one call: if the resolved tree — anywhere in the base layout's own
 * fixed structure, a `{{#block}}`'s default body, or a winning override
 * contributed by any level of the `{{extends}}` chain — contains a
 * `{{> name}}` tag, it's resolved lazily against `partials` at render time
 * via `partial.ts`'s shared `createPartialResolver` (identical lazy-
 * resolution/caching/recursion-depth semantics `compileWithPartials` itself
 * uses, including a self- or mutually-recursive partial working correctly
 * — the standard way to render a recursive structure like a nested
 * navigation tree). Omitted (the default, unchanged from before this
 * parameter existed): any `{{> ...}}` tag reachable in the resolved tree
 * throws a `RenderError` the first time it would render (see
 * template.ts's "partial" compiler case).
 */
export function compileWithLayout(
  source: string,
  layouts: LayoutSource,
  options?: CompileOptions,
  partials?: PartialSource,
): Result<CompiledTemplate, ValidationError> {
  const rootResult = parseTemplate(source);
  if (!rootResult.ok) {
    return rootResult;
  }
  const rootNodes = rootResult.value;

  let nextLayoutName = findExtendsName(rootNodes);
  if (nextLayoutName === undefined) {
    // Nothing to resolve: `source` doesn't extend anything, so it's a normal template — or a
    // base layout, rendered directly with its blocks' own default content. Delegate to
    // compileTemplate (or, if a partials registry was supplied, compileWithPartials) so this path
    // gets exactly that function's own validation/behavior, not a reimplementation.
    return partials === undefined
      ? compileTemplate(source, options)
      : compileWithPartials(source, partials, options);
  }

  const overrides = new Map<string, readonly TemplateNode[]>();
  for (const [name, body] of collectBlocks(rootNodes)) {
    overrides.set(name, body);
  }

  const visited = new Set<string>();
  let baseNodes: readonly TemplateNode[] | undefined;

  while (nextLayoutName !== undefined) {
    const layoutName = nextLayoutName;
    if (visited.has(layoutName)) {
      return err(
        new ValidationError(`Circular {{extends}} chain detected at layout "${layoutName}".`, {
          details: { layout: layoutName },
        }),
      );
    }
    visited.add(layoutName);
    if (visited.size > MAX_LAYOUT_DEPTH) {
      return err(
        new ValidationError(`{{extends}} chain exceeds the max depth of ${MAX_LAYOUT_DEPTH}.`, {
          details: { maxDepth: MAX_LAYOUT_DEPTH },
        }),
      );
    }

    const layoutSource = resolveLayoutSource(layouts, layoutName);
    if (layoutSource === undefined) {
      return err(
        new ValidationError(
          `Unknown layout "${layoutName}": no template registered under that name.`,
          {
            details: { layout: layoutName },
          },
        ),
      );
    }
    const layoutResult = parseTemplate(layoutSource);
    if (!layoutResult.ok) {
      return layoutResult;
    }

    for (const [name, body] of collectBlocks(layoutResult.value)) {
      if (!overrides.has(name)) {
        overrides.set(name, body);
      }
    }

    const parentLayoutName = findExtendsName(layoutResult.value);
    if (parentLayoutName === undefined) {
      baseNodes = layoutResult.value;
      break;
    }
    nextLayoutName = parentLayoutName;
  }

  if (baseNodes === undefined) {
    // Unreachable: the loop only exits via the `break` above (having set baseNodes) or an early
    // `return err(...)`. Kept as a defensive fallback rather than a non-null assertion.
    return err(new ValidationError("Layout chain did not resolve to a base layout."));
  }

  const resolved = applyBlockOverrides(baseNodes, overrides);
  const rawAuditResult = requireRawAudit(resolved, options?.audit);
  if (!rawAuditResult.ok) {
    return rawAuditResult;
  }
  const resolvePartial =
    partials === undefined ? undefined : createPartialResolver(partials, options);
  return ok(compileResolvedNodes(resolved, options?.audit, resolvePartial));
}

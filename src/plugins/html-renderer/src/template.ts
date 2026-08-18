/**
 * The html-renderer plugin's own dependency-free template language
 * (feature #46 — "Template parser/compiler: variables, conditionals,
 * loops"): a small mustache/handlebars-inspired grammar supporting
 * `{{var}}` interpolation, `{{#if}}...{{else}}...{{/if}}` conditionals,
 * and `{{#each}}...{{/each}}` loops over arrays and objects.
 *
 * ## Parse once, render many times
 *
 * {@link compileTemplate} is the only entry point a caller needs:
 * `parseTemplate` runs exactly once, turning the source string into an
 * AST ({@link TemplateNode}[]), and that AST is then walked exactly once
 * more to build a tree of small closures (`compileNodes`) — the returned
 * {@link CompiledTemplate.render} function just invokes those closures
 * against a context object. Re-rendering with a new context never
 * re-parses the source or re-walks the AST structurally; only the fixed
 * closure chain runs, reading the new context each time. This is what
 * "compile to reusable render functions rather than re-parsing on every
 * render" means in practice: the AST shape and the closure tree it
 * produces are both computed once, at `compileTemplate()` time.
 *
 * ## Auto-escaping (feature #47)
 *
 * Every `{{variable}}` interpolation is escaped by default, and there is
 * no template syntax to opt out. Before compiling the AST into closures,
 * `compileTemplate` runs {@link annotateEscapeContexts} (html-context.ts)
 * over it once: a small HTML-tokenizer state machine that replays the
 * template's literal text in source order and records, per `{{variable}}`
 * node, which syntactic context it landed in — HTML body text, an HTML
 * attribute value, a URL-bearing attribute (`href`, `src`, ...), or JS
 * (`<script>` content or an `on*=` event-handler attribute). Each
 * variable's compiled closure then runs the matching escaper from
 * escape.ts against the stringified value before appending it to output.
 * See html-context.ts's module doc comment for exactly what is and isn't
 * modeled, and escape.ts's for what each escaper defends against.
 *
 * ## Layouts (feature #48)
 *
 * `{{#block "name"}} default content {{/block}}` marks a named,
 * fill-in-able region; `{{extends "layoutName"}}` marks a template as one
 * that renders through another named template rather than standalone. Both
 * tags are part of this file's grammar/AST/compiler (so a base layout with
 * only default block content is a perfectly normal template, compilable
 * with plain {@link compileTemplate}) but `{{extends}}` composition itself
 * — resolving a named layout, walking a chain of nested layouts, and
 * splicing a child's block overrides into the base layout's structure — is
 * layout.ts's job; see that module for the actual layout-chain algorithm
 * and {@link compileWithLayout}. `compileTemplate` here refuses to compile
 * a template containing an `{{extends}}` tag directly (see below) — it
 * must go through `compileWithLayout` instead.
 *
 * ## Deliberately out of scope here
 *
 * - Partials/components — feature #49.
 * - An explicit raw/unescaped-output helper — feature #50.
 * - Compiled-template caching across calls — feature #53.
 *
 * ## Grammar
 *
 * - `{{path.to.value}}` — variable interpolation. Dot-separated path
 *   segments, each a JS-identifier-shaped name (letters/digits/
 *   underscore, not starting with a digit).
 * - `{{#if path}} ... {{/if}}` and `{{#if path}} ... {{else}} ...
 *   {{/if}}` — conditional. `path` is resolved and tested for truthiness
 *   (see {@link isTruthy}).
 * - `{{#each path}} ... {{/each}}` — loop over an array or a plain
 *   object at `path`. Inside the loop body, `{{this}}` is the current
 *   item, `{{@index}}` is the zero-based position (a number), and
 *   `{{@key}}` is the array index (as a string) or the object's own key.
 *   Any other variable/if path is first looked up on the current item
 *   and, if not found there, falls back up through enclosing scopes —
 *   mirroring the Mustache "context stack" so a loop body can still
 *   reference variables from outside the loop.
 * - `{{#block name}} ... {{/block}}` — a named, always-rendered region
 *   (transparent when compiled standalone: its body just renders in
 *   place) that layout composition may replace wholesale with a more
 *   specific override. `name` is a single identifier (letters/digits/
 *   underscore/hyphen, not starting with a digit).
 * - `{{extends name}}` — marks this template as extending the named
 *   layout. At most one per template (enforced by `parseTemplate`); see
 *   layout.ts for how it's resolved. A template containing this tag
 *   cannot be compiled with `compileTemplate` directly.
 *
 * Unknown/malformed tags (unclosed blocks, a stray `{{else}}`/`{{/if}}`/
 * `{{/each}}`/`{{/block}}`, an empty `{{}}`, an invalid path, more than
 * one `{{extends}}`) are reported as a {@link ValidationError} from
 * `parseTemplate`/`compileTemplate` — never thrown — per the kernel's
 * `Result`-based error convention (see core/types.ts).
 */
import { ValidationError } from "../../../core/errors.js";
import { err, ok, type Result } from "../../../core/types.js";
import { escapeForContext, type EscapeContext } from "./escape.js";
import { annotateEscapeContexts } from "./html-context.js";

/** Arbitrary render-time data. A template's `{{...}}` paths are resolved against this. */
export type TemplateContext = Record<string, unknown>;

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export interface TextNode {
  readonly kind: "text";
  readonly value: string;
}

export interface VariableNode {
  readonly kind: "variable";
  readonly path: readonly string[];
}

export interface IfNode {
  readonly kind: "if";
  readonly path: readonly string[];
  readonly consequent: readonly TemplateNode[];
  readonly alternate: readonly TemplateNode[];
}

export interface EachNode {
  readonly kind: "each";
  readonly path: readonly string[];
  readonly body: readonly TemplateNode[];
}

/** A named, fill-in-able region (feature #48 — layouts). See the module doc's "Layouts" section. */
export interface BlockNode {
  readonly kind: "block";
  readonly name: string;
  readonly body: readonly TemplateNode[];
}

/** Marks a template as extending a named layout (feature #48). Resolved by layout.ts. */
export interface ExtendsNode {
  readonly kind: "extends";
  readonly name: string;
}

export type TemplateNode = TextNode | VariableNode | IfNode | EachNode | BlockNode | ExtendsNode;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface TextToken {
  readonly type: "text";
  readonly value: string;
}
interface VarToken {
  readonly type: "var";
  readonly path: readonly string[];
}
interface IfOpenToken {
  readonly type: "if-open";
  readonly path: readonly string[];
}
interface EachOpenToken {
  readonly type: "each-open";
  readonly path: readonly string[];
}
interface ElseToken {
  readonly type: "else";
}
interface IfCloseToken {
  readonly type: "if-close";
}
interface EachCloseToken {
  readonly type: "each-close";
}
interface BlockOpenToken {
  readonly type: "block-open";
  readonly name: string;
}
interface BlockCloseToken {
  readonly type: "block-close";
}
interface ExtendsToken {
  readonly type: "extends";
  readonly name: string;
}

type Token =
  | TextToken
  | VarToken
  | IfOpenToken
  | EachOpenToken
  | ElseToken
  | IfCloseToken
  | EachCloseToken
  | BlockOpenToken
  | BlockCloseToken
  | ExtendsToken;

/** `path.segment` shape: letters/digits/underscore, not starting with a digit. */
const PATH_SEGMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `{{#block name}}`/`{{extends name}}` name shape: like a path segment, but hyphens are also allowed. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** The reserved single-segment loop variables, valid only as a whole path. */
const RESERVED_PATH_NAMES = new Set(["this", "@index", "@key"]);

/** Split and validate a dotted path expression (e.g. `"user.name"`). */
function parsePath(raw: string): Result<readonly string[], ValidationError> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return err(new ValidationError("Invalid template tag: expected a path, got an empty one."));
  }
  if (RESERVED_PATH_NAMES.has(trimmed)) {
    return ok([trimmed]);
  }
  const segments = trimmed.split(".");
  for (const segment of segments) {
    if (!PATH_SEGMENT_PATTERN.test(segment)) {
      return err(
        new ValidationError(
          `Invalid template path "${trimmed}": segment "${segment}" is not a valid identifier.`,
          { details: { path: trimmed, segment } },
        ),
      );
    }
  }
  return ok(segments);
}

const TAG_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Turn a template source string into a flat token stream (no nesting resolved yet). */
function tokenize(source: string): Result<Token[], ValidationError> {
  const tokens: Token[] = [];
  let lastIndex = 0;
  TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TAG_PATTERN.exec(source)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", value: source.slice(lastIndex, match.index) });
    }
    const content = (match[1] ?? "").trim();
    lastIndex = TAG_PATTERN.lastIndex;

    if (content.length === 0) {
      return err(new ValidationError("Invalid template tag: `{{}}` has no content."));
    }
    if (content === "else") {
      tokens.push({ type: "else" });
      continue;
    }
    if (content === "/if") {
      tokens.push({ type: "if-close" });
      continue;
    }
    if (content === "/each") {
      tokens.push({ type: "each-close" });
      continue;
    }
    if (content === "#if" || content.startsWith("#if ") || content.startsWith("#if\t")) {
      const pathResult = parsePath(content.slice(3));
      if (!pathResult.ok) {
        return pathResult;
      }
      tokens.push({ type: "if-open", path: pathResult.value });
      continue;
    }
    if (content === "#each" || content.startsWith("#each ") || content.startsWith("#each\t")) {
      const pathResult = parsePath(content.slice(5));
      if (!pathResult.ok) {
        return pathResult;
      }
      tokens.push({ type: "each-open", path: pathResult.value });
      continue;
    }
    if (content === "/block") {
      tokens.push({ type: "block-close" });
      continue;
    }
    if (content === "#block" || content.startsWith("#block ") || content.startsWith("#block\t")) {
      const name = content.slice(6).trim();
      if (name.length === 0) {
        return err(new ValidationError("Invalid {{#block}} tag: expected a block name, got none."));
      }
      if (!NAME_PATTERN.test(name)) {
        return err(
          new ValidationError(`Invalid {{#block}} name "${name}": not a valid identifier.`, {
            details: { name },
          }),
        );
      }
      tokens.push({ type: "block-open", name });
      continue;
    }
    if (
      content === "extends" ||
      content.startsWith("extends ") ||
      content.startsWith("extends\t")
    ) {
      const name = content.slice(7).trim();
      if (name.length === 0) {
        return err(
          new ValidationError("Invalid {{extends}} tag: expected a layout name, got none."),
        );
      }
      if (!NAME_PATTERN.test(name)) {
        return err(
          new ValidationError(
            `Invalid {{extends}} layout name "${name}": not a valid identifier.`,
            {
              details: { name },
            },
          ),
        );
      }
      tokens.push({ type: "extends", name });
      continue;
    }

    if (content.startsWith("#") || content.startsWith("/")) {
      return err(
        new ValidationError(`Unknown template tag "{{${content}}}".`, { details: { content } }),
      );
    }

    const pathResult = parsePath(content);
    if (!pathResult.ok) {
      return pathResult;
    }
    tokens.push({ type: "var", path: pathResult.value });
  }

  if (lastIndex < source.length) {
    tokens.push({ type: "text", value: source.slice(lastIndex) });
  }
  return ok(tokens);
}

// ---------------------------------------------------------------------------
// Parser (tokens -> AST)
// ---------------------------------------------------------------------------

type BlockCloser = "else" | "if-close" | "each-close" | "block-close";

/**
 * Recursive-descent parse of a token stream into a `TemplateNode[]` tree,
 * validating that every `{{#if}}`/`{{#each}}` is matched by exactly one
 * `{{/if}}`/`{{/each}}` and that `{{else}}` only ever appears inside an
 * open `{{#if}}`.
 */
function parseTokens(tokens: readonly Token[]): Result<TemplateNode[], ValidationError> {
  let pos = 0;

  function peekType(): Token["type"] | undefined {
    return tokens[pos]?.type;
  }

  /**
   * Parse nodes until EOF or a token whose type is in `stopAt` (not
   * consumed). `openedBy` names the block tag that is waiting on one of
   * `stopAt`'s closers (`"if"` or `"each"`), purely so an EOF reached
   * before finding it produces a message naming the right tag.
   */
  function parseUntil(
    stopAt: ReadonlySet<BlockCloser> | null,
    openedBy?: "if" | "each" | "block",
  ): Result<TemplateNode[], ValidationError> {
    const nodes: TemplateNode[] = [];

    while (pos < tokens.length) {
      const type = peekType();
      if (type !== undefined && stopAt !== null && isBlockCloser(type) && stopAt.has(type)) {
        return ok(nodes);
      }

      const token = tokens[pos];
      if (token === undefined) {
        break;
      }

      switch (token.type) {
        case "text":
          nodes.push({ kind: "text", value: token.value });
          pos++;
          break;
        case "var":
          nodes.push({ kind: "variable", path: token.path });
          pos++;
          break;
        case "if-open": {
          pos++;
          const consequentResult = parseUntil(new Set(["else", "if-close"]), "if");
          if (!consequentResult.ok) {
            return consequentResult;
          }
          let alternate: TemplateNode[] = [];
          if (peekType() === "else") {
            pos++;
            const alternateResult = parseUntil(new Set(["if-close"]), "if");
            if (!alternateResult.ok) {
              return alternateResult;
            }
            alternate = alternateResult.value;
          }
          if (peekType() !== "if-close") {
            return err(new ValidationError("Unclosed {{#if}} block: missing a matching {{/if}}."));
          }
          pos++;
          nodes.push({
            kind: "if",
            path: token.path,
            consequent: consequentResult.value,
            alternate,
          });
          break;
        }
        case "each-open": {
          pos++;
          const bodyResult = parseUntil(new Set(["each-close"]), "each");
          if (!bodyResult.ok) {
            return bodyResult;
          }
          if (peekType() !== "each-close") {
            return err(
              new ValidationError("Unclosed {{#each}} block: missing a matching {{/each}}."),
            );
          }
          pos++;
          nodes.push({ kind: "each", path: token.path, body: bodyResult.value });
          break;
        }
        case "block-open": {
          pos++;
          const bodyResult = parseUntil(new Set(["block-close"]), "block");
          if (!bodyResult.ok) {
            return bodyResult;
          }
          if (peekType() !== "block-close") {
            return err(
              new ValidationError("Unclosed {{#block}} block: missing a matching {{/block}}."),
            );
          }
          pos++;
          nodes.push({ kind: "block", name: token.name, body: bodyResult.value });
          break;
        }
        case "extends":
          nodes.push({ kind: "extends", name: token.name });
          pos++;
          break;
        case "else":
          return err(new ValidationError("Unexpected {{else}} with no matching {{#if}}."));
        case "if-close":
          return err(new ValidationError("Unexpected {{/if}} with no matching {{#if}}."));
        case "each-close":
          return err(new ValidationError("Unexpected {{/each}} with no matching {{#each}}."));
        case "block-close":
          return err(new ValidationError("Unexpected {{/block}} with no matching {{#block}}."));
      }
    }

    if (stopAt !== null) {
      const tag =
        openedBy === "each" ? "{{#each}}" : openedBy === "block" ? "{{#block}}" : "{{#if}}";
      const closer =
        openedBy === "each" ? "{{/each}}" : openedBy === "block" ? "{{/block}}" : "{{/if}}";
      return err(
        new ValidationError(
          `Unclosed ${tag} block: reached end of template without a matching ${closer}.`,
        ),
      );
    }
    return ok(nodes);
  }

  return parseUntil(null);
}

function isBlockCloser(type: Token["type"]): type is BlockCloser {
  return type === "else" || type === "if-close" || type === "each-close" || type === "block-close";
}

/** Parse template source into an AST. Exposed for testing/inspection; {@link compileTemplate} is the normal entry point. */
export function parseTemplate(source: string): Result<TemplateNode[], ValidationError> {
  const tokensResult = tokenize(source);
  if (!tokensResult.ok) {
    return tokensResult;
  }
  const parsedResult = parseTokens(tokensResult.value);
  if (!parsedResult.ok) {
    return parsedResult;
  }
  if (countNodesOfKind(parsedResult.value, "extends") > 1) {
    return err(new ValidationError("A template may contain at most one {{extends}} tag."));
  }
  return parsedResult;
}

/**
 * Recursively walk `nodes` in source order (including into `if`/`each`/
 * `block` bodies), invoking `visit` once per node. Exposed for layout.ts
 * (block-override collection, `{{extends}}` lookup) and used internally
 * for `{{extends}}`-count validation.
 */
export function walkTemplateNodes(
  nodes: readonly TemplateNode[],
  visit: (node: TemplateNode) => void,
): void {
  for (const node of nodes) {
    visit(node);
    switch (node.kind) {
      case "if":
        walkTemplateNodes(node.consequent, visit);
        walkTemplateNodes(node.alternate, visit);
        break;
      case "each":
        walkTemplateNodes(node.body, visit);
        break;
      case "block":
        walkTemplateNodes(node.body, visit);
        break;
      default:
        break;
    }
  }
}

function countNodesOfKind(nodes: readonly TemplateNode[], kind: TemplateNode["kind"]): number {
  let count = 0;
  walkTemplateNodes(nodes, (node) => {
    if (node.kind === kind) {
      count++;
    }
  });
  return count;
}

// ---------------------------------------------------------------------------
// Evaluation context / value resolution
// ---------------------------------------------------------------------------

interface Scope {
  readonly data: unknown;
  readonly parent?: Scope;
  readonly index?: number;
  readonly key?: string;
}

function resolveInObject(data: unknown, path: readonly string[]): unknown {
  let value: unknown = data;
  for (const segment of path) {
    if (value === null || typeof value !== "object") {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/** Resolve a path against a scope, falling back through parent scopes (Mustache-style context stack). */
function resolve(scope: Scope, path: readonly string[]): unknown {
  const first = path[0];
  if (path.length === 1) {
    if (first === "this") {
      return scope.data;
    }
    if (first === "@index") {
      return scope.index;
    }
    if (first === "@key") {
      return scope.key;
    }
  }

  let current: Scope | undefined = scope;
  while (current !== undefined) {
    const value = resolveInObject(current.data, path);
    if (value !== undefined) {
      return value;
    }
    current = current.parent;
  }
  return undefined;
}

/** Falsy: `undefined`, `null`, `false`, `0`, `NaN`, `""`, or an empty array. Everything else is truthy. */
function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Boolean(value);
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Compiler (AST -> closures)
// ---------------------------------------------------------------------------

type CompiledNode = (scope: Scope, out: string[]) => void;

/** Per-`VariableNode` escape context, computed once by {@link annotateEscapeContexts} before compiling. */
type EscapeContexts = ReadonlyMap<VariableNode, EscapeContext>;

function runCompiled(nodes: readonly CompiledNode[], scope: Scope, out: string[]): void {
  for (const node of nodes) {
    node(scope, out);
  }
}

function compileNode(node: TemplateNode, contexts: EscapeContexts): CompiledNode {
  switch (node.kind) {
    case "text": {
      const value = node.value;
      return (_scope, out) => {
        out.push(value);
      };
    }
    case "variable": {
      const path = node.path;
      // Every interpolation is escaped for its compile-time-detected context — see the module
      // doc comment's "Auto-escaping" section. There is no template syntax that opts out of this.
      const context = contexts.get(node) ?? "html";
      return (scope, out) => {
        out.push(escapeForContext(stringifyValue(resolve(scope, path)), context));
      };
    }
    case "if": {
      const path = node.path;
      const consequent = compileNodes(node.consequent, contexts);
      const alternate = compileNodes(node.alternate, contexts);
      return (scope, out) => {
        if (isTruthy(resolve(scope, path))) {
          runCompiled(consequent, scope, out);
        } else {
          runCompiled(alternate, scope, out);
        }
      };
    }
    case "each": {
      const path = node.path;
      const body = compileNodes(node.body, contexts);
      return (scope, out) => {
        const collection = resolve(scope, path);
        if (Array.isArray(collection)) {
          collection.forEach((item, index) => {
            const itemScope: Scope = { data: item, parent: scope, index, key: String(index) };
            runCompiled(body, itemScope, out);
          });
        } else if (collection !== null && typeof collection === "object") {
          Object.entries(collection).forEach(([key, item], index) => {
            const itemScope: Scope = { data: item, parent: scope, index, key };
            runCompiled(body, itemScope, out);
          });
        }
        // Anything else (undefined, null, a primitive) iterates zero times — no error.
      };
    }
    case "block": {
      // Transparent when compiled standalone: a block's body just renders in place. Layout
      // composition (layout.ts) replaces `node.body` with the resolved override *before* this
      // function ever runs — see compileResolvedNodes — so by the time a "block" node reaches
      // here, `body` already reflects whichever level of the layout chain won.
      const body = compileNodes(node.body, contexts);
      return (scope, out) => {
        runCompiled(body, scope, out);
      };
    }
    case "extends": {
      // Never reached in practice: compileTemplate() rejects any template containing an
      // {{extends}} tag before calling compileNodes (see below), and layout.ts's composition
      // strips {{extends}} nodes out of the tree it hands to compileResolvedNodes. Render as
      // nothing rather than throwing, so this stays a defensive no-op rather than a new failure
      // mode if that invariant is ever violated.
      return (_scope, _out) => {};
    }
  }
}

function compileNodes(nodes: readonly TemplateNode[], contexts: EscapeContexts): CompiledNode[] {
  return nodes.map((node) => compileNode(node, contexts));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompiledTemplate {
  /** Render this compiled template against `context`. Never re-parses the source. */
  render(context?: TemplateContext): string;
}

/**
 * Compile an already-fully-resolved AST (no `{{extends}}` nodes remaining
 * — layout composition has already spliced every `{{#block}}`'s body with
 * its winning override, if any) into a {@link CompiledTemplate}. Shared by
 * {@link compileTemplate} (source has no `{{extends}}` to begin with) and
 * layout.ts's `compileWithLayout` (source's `{{extends}}` chain has just
 * been resolved into a single tree). Exported so layout.ts never has to
 * reimplement escape-context annotation or closure compilation.
 */
export function compileResolvedNodes(nodes: readonly TemplateNode[]): CompiledTemplate {
  const contexts = annotateEscapeContexts(nodes);
  const compiled = compileNodes(nodes, contexts);
  return {
    render(context: TemplateContext = {}): string {
      const out: string[] = [];
      const rootScope: Scope = { data: context };
      runCompiled(compiled, rootScope, out);
      return out.join("");
    },
  };
}

/**
 * Parse and compile `source` once into a {@link CompiledTemplate}. Call
 * `.render(context)` as many times as needed afterwards — each call only
 * walks the already-built closure tree, it never re-parses `source` or
 * re-walks the AST's structure.
 *
 * Rejects (with a {@link ValidationError}) any template containing an
 * `{{extends}}` tag — that composition is layout.ts's `compileWithLayout`
 * job, not this function's. A template using only `{{#block}}` (with no
 * `{{extends}}`) — i.e. a standalone or base layout — compiles here just
 * fine; its blocks simply render their own default content.
 */
export function compileTemplate(source: string): Result<CompiledTemplate, ValidationError> {
  const astResult = parseTemplate(source);
  if (!astResult.ok) {
    return astResult;
  }
  if (countNodesOfKind(astResult.value, "extends") > 0) {
    return err(
      new ValidationError(
        "Template contains an {{extends}} tag; use compileWithLayout (layout.ts) to render a " +
          "template that extends a layout, not compileTemplate.",
      ),
    );
  }
  return ok(compileResolvedNodes(astResult.value));
}

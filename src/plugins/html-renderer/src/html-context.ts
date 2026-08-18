/**
 * Compile-time HTML-context scanner for the html-renderer template
 * compiler (feature #47 — "Context-aware auto-escaping"). Walks a
 * template's AST in source order, replaying a small HTML tokenizer state
 * machine over every {@link TextNode}'s literal text, and records which
 * syntactic context (see {@link EscapeContext}) each `{{variable}}` node
 * landed in — so `compileTemplate` can pick the matching escaper
 * (escape.ts) for that interpolation site without the template author
 * having to say anything.
 *
 * ## What the scanner tracks
 *
 * A single mutable {@link ScanState} threaded across sibling nodes in
 * document order: whether we're in an HTML text run, inside a tag between
 * attributes, inside an attribute value (and which attribute, so a
 * `href`/`src`/... value is flagged `"url"` and an `onclick`/`onload`/...
 * value is flagged `"js"`), inside `<script>...</script>`, or inside an
 * `<!-- ... -->` comment.
 *
 * `{{#if}}`/`{{#each}}` branches are scanned from a **clone** of the
 * surrounding state and never write back into it — well-formed templates
 * open and close their tags within a single branch/loop body (the state
 * entering `{{#if}}`/`{{#each}}` matches the state leaving it), so this is
 * exact for the templates people actually write, and for a malformed one
 * (a tag left open across a branch boundary) it fails safe: subsequent
 * siblings are scanned as if the branch had no effect, at worst picking a
 * *stricter* escaper than the (already broken) markup technically calls
 * for, never a laxer one.
 *
 * ## Contexts not modeled
 *
 * Interpolating into a tag name or an attribute *name* (`<{{tag}}>`,
 * `<div {{attr}}="x">`) has no safe generic escaper — the position itself
 * is untrusted structure, not a value inside fixed structure — so the
 * scanner conservatively falls back to `"html"` for those positions (see
 * {@link contextForState}'s default case) rather than pretending one of
 * the four defined contexts applies. CSS (`<style>`, a `style="..."`
 * attribute) similarly has no dedicated escaper here and falls back to
 * `"attr"`.
 */
import type { EscapeContext } from "./escape.js";
import type { EachNode, IfNode, TemplateNode, VariableNode } from "./template.js";

type ScanMode =
  | "text"
  | "comment"
  | "tagName"
  | "beforeAttrName"
  | "attrName"
  | "afterAttrName"
  | "beforeAttrValue"
  | "attrValueDouble"
  | "attrValueSingle"
  | "attrValueUnquoted"
  | "script"
  | "scriptCloseTag";

interface ScanState {
  mode: ScanMode;
  /** Lower-cased tag name of the tag currently open (or most recently opened). */
  tagName: string;
  /** Lower-cased name of the attribute currently being read/valued. */
  attrName: string;
  /** Whether the currently-open tag is a closing tag (`</...>`), which never carries attributes. */
  isClosingTag: boolean;
}

function initialScanState(): ScanState {
  return { mode: "text", tagName: "", attrName: "", isClosingTag: false };
}

function cloneScanState(state: ScanState): ScanState {
  return { ...state };
}

/** URL-bearing HTML attributes: their value is a URL, checked for a dangerous scheme before being used. */
const URL_ATTR_NAMES = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "cite",
  "poster",
  "background",
  "data",
  "longdesc",
  "manifest",
  "srcset",
]);

/** `on*` event-handler attributes (`onclick`, `onmouseover`, `onload`, ...): their value is JS source. */
function isEventHandlerAttr(name: string): boolean {
  return name.length > 2 && name.startsWith("on");
}

const ASCII_WHITESPACE_PATTERN = /\s/;
const TAG_NAME_CHAR_PATTERN = /[A-Za-z0-9-]/;

/** The tag-close/self-close destination mode: back into `<script>` content, or back to HTML text. */
function modeAfterTagClose(state: ScanState): ScanMode {
  return state.tagName === "script" && !state.isClosingTag ? "script" : "text";
}

/**
 * Replay the tokenizer over `text`, mutating `state` in place to reflect
 * where scanning ended up. Deliberately not a full HTML5 tokenizer (no
 * DOCTYPE/CDATA/RCDATA handling, no error recovery beyond "stay put and
 * keep scanning") — just enough state to place an interpolation site
 * correctly for the four contexts this feature escapes for.
 */
function scanText(state: ScanState, text: string): void {
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text.charAt(i);

    switch (state.mode) {
      case "text": {
        if (ch === "<") {
          if (text.startsWith("<!--", i)) {
            state.mode = "comment";
            i += 4;
            break;
          }
          state.isClosingTag = text.charAt(i + 1) === "/";
          state.mode = "tagName";
          state.tagName = "";
          i += state.isClosingTag ? 2 : 1;
          break;
        }
        i++;
        break;
      }

      case "comment": {
        if (text.startsWith("-->", i)) {
          state.mode = "text";
          i += 3;
          break;
        }
        i++;
        break;
      }

      case "tagName": {
        if (TAG_NAME_CHAR_PATTERN.test(ch)) {
          state.tagName += ch.toLowerCase();
          i++;
          break;
        }
        // Tag name ended (whitespace, '/', or '>'); re-dispatch this char without consuming it.
        state.mode = "beforeAttrName";
        break;
      }

      case "beforeAttrName": {
        if (ch === ">") {
          state.mode = modeAfterTagClose(state);
          i++;
          break;
        }
        if (ch === "/" || ASCII_WHITESPACE_PATTERN.test(ch)) {
          i++;
          break;
        }
        state.mode = "attrName";
        state.attrName = ch.toLowerCase();
        i++;
        break;
      }

      case "attrName": {
        if (ch === "=") {
          state.mode = "beforeAttrValue";
          i++;
          break;
        }
        if (ASCII_WHITESPACE_PATTERN.test(ch)) {
          state.mode = "afterAttrName";
          i++;
          break;
        }
        if (ch === ">") {
          state.mode = modeAfterTagClose(state);
          state.attrName = "";
          i++;
          break;
        }
        if (ch === "/") {
          state.mode = "beforeAttrName";
          state.attrName = "";
          i++;
          break;
        }
        state.attrName += ch.toLowerCase();
        i++;
        break;
      }

      case "afterAttrName": {
        if (ch === "=") {
          state.mode = "beforeAttrValue";
          i++;
          break;
        }
        if (ASCII_WHITESPACE_PATTERN.test(ch)) {
          i++;
          break;
        }
        if (ch === ">") {
          state.mode = modeAfterTagClose(state);
          state.attrName = "";
          i++;
          break;
        }
        // Previous attribute was boolean (no value); this char starts a new attribute name.
        state.mode = "attrName";
        state.attrName = ch.toLowerCase();
        i++;
        break;
      }

      case "beforeAttrValue": {
        if (ASCII_WHITESPACE_PATTERN.test(ch)) {
          i++;
          break;
        }
        if (ch === '"') {
          state.mode = "attrValueDouble";
          i++;
          break;
        }
        if (ch === "'") {
          state.mode = "attrValueSingle";
          i++;
          break;
        }
        state.mode = "attrValueUnquoted";
        i++;
        break;
      }

      case "attrValueDouble": {
        if (ch === '"') {
          state.mode = "beforeAttrName";
          state.attrName = "";
        }
        i++;
        break;
      }

      case "attrValueSingle": {
        if (ch === "'") {
          state.mode = "beforeAttrName";
          state.attrName = "";
        }
        i++;
        break;
      }

      case "attrValueUnquoted": {
        if (ASCII_WHITESPACE_PATTERN.test(ch)) {
          state.mode = "beforeAttrName";
          state.attrName = "";
          i++;
          break;
        }
        if (ch === ">") {
          state.mode = modeAfterTagClose(state);
          state.attrName = "";
          i++;
          break;
        }
        i++;
        break;
      }

      case "script": {
        if (ch === "<" && /^<\/script/i.test(text.slice(i, i + 8))) {
          state.mode = "scriptCloseTag";
          i++;
          break;
        }
        i++;
        break;
      }

      case "scriptCloseTag": {
        if (ch === ">") {
          state.mode = "text";
        }
        i++;
        break;
      }
    }
  }
}

/** Map the scanner's current position to the escaper context that applies there. */
function contextForState(state: ScanState): EscapeContext {
  switch (state.mode) {
    case "script":
      return "js";
    // "beforeAttrValue" reaches here when a `{{variable}}` is the *first* thing after `=` (no
    // quote character has been seen yet in the static text) — e.g. `<a href={{x}}>` — so the
    // interpolation itself is what starts the value, unquoted. It gets the same context as
    // `attrValueUnquoted`; see `walk`'s "variable" case for the matching state transition.
    case "beforeAttrValue":
    case "attrValueDouble":
    case "attrValueSingle":
    case "attrValueUnquoted":
      if (URL_ATTR_NAMES.has(state.attrName)) {
        return "url";
      }
      if (isEventHandlerAttr(state.attrName)) {
        return "js";
      }
      return "attr";
    default:
      // "text", "comment", and the tag/attribute-name positions all fall back to HTML escaping
      // (see the module doc comment: there is no safe escaper for interpolating into structure).
      return "html";
  }
}

/**
 * Walk `nodes` in source order, threading `state` forward through sibling
 * `TextNode`s, and record every `VariableNode`'s context in `contexts`.
 */
function walk(
  nodes: readonly TemplateNode[],
  state: ScanState,
  contexts: Map<VariableNode, EscapeContext>,
): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        scanText(state, node.value);
        break;
      case "variable":
        contexts.set(node, contextForState(state));
        if (state.mode === "beforeAttrValue") {
          // The interpolation is the first character of the attribute value: it started an
          // unquoted value, so scanning of the *next* sibling text node (e.g. the ` onmouseover=`
          // tail of an injected payload, or a legitimate `-suffix>`) must resume from there.
          state.mode = "attrValueUnquoted";
        }
        break;
      case "if":
        walkIf(node, state, contexts);
        break;
      case "each":
        walkEach(node, state, contexts);
        break;
      case "block":
        // Not a branch: a block's body always renders inline at this exact position (it's
        // either its own default content or a layout override — see template.ts's "block" case
        // in compileNode), so scanning continues with the *same* mutable state rather than a
        // clone, exactly like a plain sequence of sibling nodes.
        walk(node.body, state, contexts);
        break;
      case "extends":
        // No literal text of its own to scan, and never survives into the tree
        // compileResolvedNodes actually compiles (see template.ts).
        break;
    }
  }
}

function walkIf(node: IfNode, state: ScanState, contexts: Map<VariableNode, EscapeContext>): void {
  walk(node.consequent, cloneScanState(state), contexts);
  walk(node.alternate, cloneScanState(state), contexts);
}

function walkEach(
  node: EachNode,
  state: ScanState,
  contexts: Map<VariableNode, EscapeContext>,
): void {
  walk(node.body, cloneScanState(state), contexts);
}

/**
 * Compute the {@link EscapeContext} for every `VariableNode` in `nodes`,
 * by simulating one pass of an HTML tokenizer over the template's literal
 * text in source order. Call once per `compileTemplate()`, before
 * compiling the AST into closures.
 */
export function annotateEscapeContexts(
  nodes: readonly TemplateNode[],
): Map<VariableNode, EscapeContext> {
  const contexts = new Map<VariableNode, EscapeContext>();
  walk(nodes, initialScanState(), contexts);
  return contexts;
}

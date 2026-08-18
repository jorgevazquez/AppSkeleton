/**
 * Context-aware output escapers for the html-renderer template compiler
 * (feature #47 — "Context-aware auto-escaping (HTML body, attribute, URL,
 * JS contexts)").
 *
 * Four escapers, one per syntactic context a `{{var}}` interpolation can
 * land in:
 *
 * - {@link escapeHtml} — HTML body / text-node context (`<div>{{x}}</div>`).
 *   Encodes the five characters that can open a tag, an entity, or close an
 *   attribute: `& < > " '`.
 * - {@link escapeAttr} — HTML attribute-value context
 *   (`<div title="{{x}}">` or an unquoted `<div title={{x}}>`). Encodes
 *   every non-alphanumeric character as a hex character reference
 *   (`&#xHH;`), which is safe inside double-quoted, single-quoted, *and*
 *   unquoted attribute values alike (OWASP XSS Prevention Cheat Sheet,
 *   Rule #2) — there is no character an attacker can smuggle through to
 *   close the attribute or add a new one.
 * - {@link escapeUrl} — URL-bearing attribute context (`href`, `src`,
 *   `action`, ...). Rejects dangerous URL schemes (`javascript:`, `data:`,
 *   `vbscript:`, ...) by replacing the entire value with an inert
 *   placeholder when the value doesn't match a scheme allowlist / relative-
 *   URL shape, then HTML-attribute-escapes whatever is left so it's also
 *   safe to place inside a quoted or unquoted attribute.
 * - {@link escapeJs} — JS string-literal context (inside `<script>...
 *   </script>` or an inline event-handler attribute like `onclick="..."`).
 *   Encodes every non-alphanumeric character as a `\xHH`/`\uHHHH` escape
 *   (OWASP Rule #3), which can't terminate a JS string literal, inject a
 *   `</script>` closing tag, or otherwise break out of the JS context.
 *
 * Each escaper is deliberately conservative (encode everything outside an
 * allowlist) rather than trying to enumerate every dangerous character —
 * that is what keeps them safe against inputs nobody thought to test.
 */

/** The syntactic context an interpolation site was found in at compile time. */
export type EscapeContext = "html" | "attr" | "url" | "js";

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape a string for HTML body / text-node context. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch] ?? ch);
}

const ALPHANUMERIC_PATTERN = /[A-Za-z0-9]/;

/**
 * Escape a string for HTML attribute-value context (quoted or unquoted).
 * Every non-alphanumeric character becomes a hex character reference, so
 * nothing in `value` can end the attribute, start a new one, or otherwise
 * change how the surrounding tag parses.
 */
export function escapeAttr(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ALPHANUMERIC_PATTERN.test(ch)) {
      out += ch;
      continue;
    }
    const codePoint = ch.codePointAt(0) ?? 0;
    out += `&#x${codePoint.toString(16).toUpperCase()};`;
  }
  return out;
}

/**
 * Escape a string for JS string-literal context (inside `<script>` or an
 * inline event-handler attribute). Every non-alphanumeric character becomes
 * a `\xHH` (code points < 256) or `\uHHHH` escape, so `value` can't close
 * the enclosing string literal, inject a `</script>` tag, or run as script.
 */
export function escapeJs(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ALPHANUMERIC_PATTERN.test(ch)) {
      out += ch;
      continue;
    }
    const codePoint = ch.codePointAt(0) ?? 0;
    out +=
      codePoint <= 0xff
        ? `\\x${codePoint.toString(16).toUpperCase().padStart(2, "0")}`
        : `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/**
 * A value placed in a URL-bearing attribute (`href`, `src`, ...) whose
 * scheme didn't match {@link SAFE_URL_PATTERN} — an active-content scheme
 * such as `javascript:`, `data:`, or `vbscript:` (or an obfuscated variant
 * of one) was rejected outright rather than escaped, since escaping alone
 * cannot make an executable URL scheme safe.
 */
const BLOCKED_URL_REPLACEMENT = "about:invalid#blocked-by-template-escaper";

/**
 * Matches a value that is safe to use as a URL: an allowlisted scheme
 * (`http:`, `https:`, `mailto:`, `ftp:`, `tel:`) followed by `:`, or a
 * scheme-less value (relative path, fragment, query string, protocol-
 * relative `//host/...`) — i.e. anything *without* an early `:` before the
 * first `/`, `?`, or `#`. Modeled on AngularJS's `aHrefSanitizationTrustedUrlList`
 * default, a well-exercised approach to the same problem.
 */
const SAFE_URL_PATTERN = /^(?:(?:https?|mailto|ftp|tel):|[^&:/?#]*(?:[/?#]|$))/i;

/**
 * Escape a string for URL-bearing attribute context. Strips leading/
 * trailing whitespace and ASCII control characters first (browsers ignore
 * these when parsing a URL scheme, so `"java\tscript:"` is exactly as
 * dangerous as `"javascript:"`), rejects the value outright if what
 * remains doesn't match {@link SAFE_URL_PATTERN}, and finally
 * attribute-escapes whatever survives so it's also safe to place inside
 * the enclosing quoted/unquoted attribute.
 */
export function escapeUrl(value: string): string {
  const normalized = stripAsciiControlAndSpace(value);
  const safe = SAFE_URL_PATTERN.test(normalized) ? value : BLOCKED_URL_REPLACEMENT;
  return escapeAttr(safe);
}

/** Drop every ASCII control character (code points 0-31 and 127) and space, wherever they appear. */
function stripAsciiControlAndSpace(value: string): string {
  let out = "";
  for (const ch of value) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint <= 32 || codePoint === 127) {
      continue;
    }
    out += ch;
  }
  return out;
}

/** Apply the escaper matching `context` to `value`. */
export function escapeForContext(value: string, context: EscapeContext): string {
  switch (context) {
    case "html":
      return escapeHtml(value);
    case "attr":
      return escapeAttr(value);
    case "url":
      return escapeUrl(value);
    case "js":
      return escapeJs(value);
  }
}

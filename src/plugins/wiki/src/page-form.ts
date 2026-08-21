/**
 * Create/edit page form UI, server-rendered via html-renderer's
 * `render:template` capability (feature #96 — "Page edit form UI with
 * CSRF-protected submission").
 *
 * ## Step 1: one template, two modes, posting through the real CSRF-protected route
 *
 * {@link renderPageFormHtml} renders a single, fixed template source (this
 * module's own literal HTML/CSS/JS text — never anything derived from a
 * page's own title/content beyond ordinary `{{variable}}` interpolation, so
 * the same "data, not a raw string" safety property `markdown.ts`/`diff.ts`
 * already established for page content applies here too) in either "create"
 * or "edit" mode via {@link PageFormContext.isEdit}. Both modes render a
 * `<form>` whose submission is handled entirely client-side by this
 * template's own inline `<script>`: on submit, it builds a JSON body from
 * the form fields and `fetch()`s `data-action`/`data-method` (the exact
 * versioned `POST /wiki/pages` / `PATCH /wiki/pages/:id` routes feature #94
 * already registers, reused unchanged here — this module adds no new
 * write path). That `fetch()` call is the reason submission has to be
 * JavaScript-driven rather than a plain HTML `<form method="post">`: feature
 * #64's CSRF scheme (`api-gateway/src/csrf.ts`) is a double-submit *header*
 * check (`x-csrf-token` must match the `csrf_token` cookie) — a bare HTML
 * form has no way to attach a custom request header, only same-origin
 * script reading `document.cookie` does. This is exactly what that module's
 * own doc comment anticipates ("same-origin JavaScript must be able to read
 * it ... in order to echo it back").
 *
 * ## Step 2: inline validation errors
 *
 * A non-OK `fetch()` response is always this codebase's uniform error
 * envelope (`{code, message, details?}` — `api-gateway/src/error-
 * handler.ts`, features #60/#61) — regardless of whether the failure was
 * this route's own JSON-schema validation, a domain-level {@link
 * ValidationError} thrown by `pages.ts`/`authorized-store.ts` (an invalid
 * slug, a duplicate slug in the namespace, an unknown namespace, ...), or a
 * CSRF/authorization failure. The inline script reads `message` (and, for a
 * schema-validation failure, each ajv violation under `details.validation`)
 * and renders them into `#form-errors` — no page reload, no navigation away
 * from the user's in-progress edits.
 *
 * ## Same escaping guarantee as every other rendered wiki page
 *
 * Every dynamic value in the template — `title`/`content`/`namespaceId`/
 * `slug` prefill values, `actionPath`, `pageId` — is an ordinary
 * `{{variable}}` interpolation, so feature #47's compile-time HTML-context
 * scanner (`html-context.ts`) picks the right escaper for wherever it
 * lands (attribute-value escaping inside `value="{{title}}"`, HTML-body
 * escaping inside `<textarea>{{content}}</textarea>`, ...) automatically.
 * The inline `<script>` block itself is fixed, literal source text with no
 * interpolation inside it at all — nothing user-controlled is ever spliced
 * into script context — so there is no way for a page's own title/content
 * (attacker-controlled, like `markdown.ts`/`diff.ts` already document) to
 * break out of the value it's placed in.
 */
import type { ValidationError } from "../../../core/errors.js";
import type { Result } from "../../../core/types.js";
import type { RenderTemplateCapability, TemplateContext } from "../../html-renderer/index.js";

/**
 * Duplicated from `api-gateway/src/route-capability.ts`'s `DEFAULT_API_VERSION`
 * (feature #62) and `api-gateway/src/csrf.ts`'s `CSRF_COOKIE_NAME`/
 * `CSRF_HEADER_NAME` (feature #64) rather than imported as values —
 * `docs/plugin-conventions.md` section 5 forbids importing another plugin's
 * internals (only kernel-brokered capabilities, or a `import type`-only
 * reference, may cross a plugin boundary; api-gateway exports none of these
 * three as capability surface). This is the same "duplicate the small,
 * self-contained thing, don't import it as a value" precedent
 * `session-identity.ts` and `../index.ts`'s `REQUIRED_PERMISSION_SEGMENT`-
 * style duplications already establish in this codebase — see this
 * module's own doc comment and `session-identity.ts`'s for the fuller
 * rationale. All three are effectively frozen wire-format constants (a
 * version segment string, a cookie name, a header name), not logic that
 * could silently drift out of sync in a way that would actually break
 * anything if this module's copy and api-gateway's own ever disagreed on
 * behavior rather than just on the literal string.
 */
const WIKI_API_VERSION = "v1";
/** Duplicated from `api-gateway/src/csrf.ts`'s `CSRF_COOKIE_NAME` — see the doc comment above. */
const CSRF_COOKIE_NAME = "csrf_token";
/** Duplicated from `api-gateway/src/csrf.ts`'s `CSRF_HEADER_NAME` — see the doc comment above. */
const CSRF_HEADER_NAME = "x-csrf-token";

/** The versioned path every wiki page route lives under (feature #62). */
const WIKI_PAGES_PATH = `/api/${WIKI_API_VERSION}/wiki/pages`;

/** `POST /wiki/pages`'s final, versioned path (feature #94's create route) — what the create-mode form's `data-action` targets. */
export const CREATE_PAGE_FORM_ACTION = WIKI_PAGES_PATH;

/** `PATCH /wiki/pages/:id`'s final, versioned path (feature #94's update route) — what the edit-mode form's `data-action` targets. */
export function editPageFormAction(pageId: number): string {
  return `${WIKI_PAGES_PATH}/${pageId}`;
}

/** `GET /wiki/pages/:id/edit`'s final, versioned path — where a successful create-mode submission navigates to next, so the URL bar reflects the real, now-persisted page. */
export function editPageFormPath(pageId: number): string {
  return `${WIKI_PAGES_PATH}/${pageId}/edit`;
}

/** What {@link renderPageFormHtml} needs to render either mode of the form. */
export interface PageFormContext {
  /** `false` renders the create form (editable namespaceId/slug); `true` renders the edit form (namespaceId/slug shown read-only, title/content prefilled and editable). */
  readonly isEdit: boolean;
  /** Only meaningful when `isEdit` is `true` — the page being edited, echoed into a hidden field purely for the inline script's own post-save bookkeeping (the actual PATCH target comes from `actionPath`, not this field). */
  readonly pageId?: number;
  readonly namespaceId: string;
  readonly slug: string;
  readonly title: string;
  readonly content: string;
  /** The exact versioned route this form's submission posts to — see {@link CREATE_PAGE_FORM_ACTION}/{@link editPageFormAction}. */
  readonly actionPath: string;
  readonly actionMethod: "POST" | "PATCH";
}

// ---------------------------------------------------------------------------
// The inline <script> — fixed, literal source text; no interpolation inside
// it at all (see module doc comment's "Same escaping guarantee" section).
// The CSRF cookie/header names are spliced in once, at module-load time, as
// JSON-stringified JS string literals (never through the html-renderer
// `{{...}}` grammar) — reusing api-gateway's own exported constants instead
// of duplicating the literal strings "csrf_token"/"x-csrf-token" here.
// ---------------------------------------------------------------------------

const CSRF_COOKIE_NAME_JS_LITERAL = JSON.stringify(CSRF_COOKIE_NAME);
const CSRF_HEADER_NAME_JS_LITERAL = JSON.stringify(CSRF_HEADER_NAME);

const PAGE_FORM_SCRIPT = [
  "(function () {",
  "  function readCookie(name) {",
  "    var pattern = new RegExp('(?:^|; )' + name + '=([^;]*)');",
  "    var match = document.cookie.match(pattern);",
  "    return match ? decodeURIComponent(match[1]) : '';",
  "  }",
  "",
  "  function fieldValue(form, name) {",
  "    var field = form.elements.namedItem(name);",
  "    return field ? field.value : undefined;",
  "  }",
  "",
  "  function clearErrors(container) {",
  "    while (container.firstChild) {",
  "      container.removeChild(container.firstChild);",
  "    }",
  "  }",
  "",
  "  function showErrors(container, messages) {",
  "    clearErrors(container);",
  "    var list = document.createElement('ul');",
  "    messages.forEach(function (message) {",
  "      var item = document.createElement('li');",
  "      item.textContent = message;",
  "      list.appendChild(item);",
  "    });",
  "    container.appendChild(list);",
  "  }",
  "",
  "  function extractMessages(body) {",
  "    var messages = [];",
  "    if (body && typeof body.message === 'string') {",
  "      messages.push(body.message);",
  "    }",
  "    var violations = body && body.details && body.details.validation;",
  "    if (Array.isArray(violations)) {",
  "      violations.forEach(function (violation) {",
  "        if (!violation || typeof violation.message !== 'string') {",
  "          return;",
  "        }",
  "        var instancePath = violation.instancePath;",
  "        var field = typeof instancePath === 'string' ? instancePath.replace(/^\\//, '') : '';",
  "        messages.push(field ? field + ': ' + violation.message : violation.message);",
  "      });",
  "    }",
  "    if (messages.length === 0) {",
  "      messages.push('The request was invalid.');",
  "    }",
  "    return messages;",
  "  }",
  "",
  "  var form = document.getElementById('page-form');",
  "  var errors = document.getElementById('form-errors');",
  "  var status = document.getElementById('form-status');",
  "",
  "  form.addEventListener('submit', function (event) {",
  "    event.preventDefault();",
  "    clearErrors(errors);",
  "    status.textContent = '';",
  "",
  "    var method = form.dataset.method;",
  "    var payload = {};",
  "    if (method === 'POST') {",
  "      payload.namespaceId = fieldValue(form, 'namespaceId');",
  "      payload.slug = fieldValue(form, 'slug');",
  "    }",
  "    payload.title = fieldValue(form, 'title');",
  "    payload.content = fieldValue(form, 'content');",
  "",
  "    var headers = {};",
  "    headers['Content-Type'] = 'application/json';",
  `    headers[${CSRF_HEADER_NAME_JS_LITERAL}] = readCookie(${CSRF_COOKIE_NAME_JS_LITERAL});`,
  "",
  "    fetch(form.dataset.action, {",
  "      method: method,",
  "      credentials: 'same-origin',",
  "      headers: headers,",
  "      body: JSON.stringify(payload)",
  "    }).then(function (response) {",
  "      return response.json().catch(function () {",
  "        return {};",
  "      }).then(function (body) {",
  "        if (!response.ok) {",
  "          showErrors(errors, extractMessages(body));",
  "          return;",
  "        }",
  "        status.textContent = 'Saved.';",
  "        if (method === 'POST' && body && typeof body.id === 'number') {",
  "          window.location.href = '" + WIKI_PAGES_PATH + "/' + body.id + '/edit';",
  "        }",
  "      });",
  "    }).catch(function () {",
  "      showErrors(errors, ['Network error — please try again.']);",
  "    });",
  "  });",
  "})();",
].join("\n");

// ---------------------------------------------------------------------------
// The page template itself.
//
// Accessibility pass (feature #102): the form's own heading (`<h1>`) is the
// only heading on this standalone document — this template is never
// composed through `page-templates.ts`'s `WIKI_LAYOUT`, so there is no
// second, site-brand heading to collide with. `#form-status`/`#form-errors`
// are both live regions (`aria-live`, `role="status"`/`role="alert"`) so the
// inline script's own DOM writes (`showErrors`/`status.textContent`) are
// announced to a screen reader without a page reload — `role="alert"` is
// already implicitly `aria-live="assertive"`, the explicit attribute below
// is just documentation-by-markup of that fact, mirroring `role="status"`'s
// own explicit `aria-live="polite"` pairing. Every input already had its
// `<label for>` correctly paired with the field's `id` (step 1 found no
// defect there); `<main>` adds a single landmark around the form so
// keyboard/screen-reader users can jump straight past `<title>`/`<head>` to
// the page's one real region without any extra navigation chrome to skip
// (unlike the wiki-layout pages, this document has no sidebar).
// ---------------------------------------------------------------------------

const PAGE_FORM_TEMPLATE_SOURCE = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8" />',
  "<title>{{#if isEdit}}Edit Page{{else}}New Page{{/if}}</title>",
  "</head>",
  "<body>",
  '<main id="page-form-main">',
  "<h1>{{#if isEdit}}Edit Page{{else}}New Page{{/if}}</h1>",
  '<div id="form-status" class="form-status" role="status" aria-live="polite"></div>',
  '<div id="form-errors" class="form-errors" role="alert" aria-live="assertive"></div>',
  '<form id="page-form" data-action="{{actionPath}}" data-method="{{actionMethod}}">',
  "{{#if isEdit}}",
  '<input type="hidden" name="pageId" value="{{pageId}}" />',
  "<p>Namespace: {{namespaceId}}</p>",
  "<p>Slug: {{slug}}</p>",
  "{{else}}",
  '<p><label for="namespaceId">Namespace ID</label><br />',
  '<input type="text" id="namespaceId" name="namespaceId" value="{{namespaceId}}" required /></p>',
  '<p><label for="slug">Slug</label><br />',
  '<input type="text" id="slug" name="slug" value="{{slug}}" required /></p>',
  "{{/if}}",
  '<p><label for="title">Title</label><br />',
  '<input type="text" id="title" name="title" value="{{title}}" required /></p>',
  '<p><label for="content">Content</label><br />',
  '<textarea id="content" name="content" rows="20" cols="80" required>{{content}}</textarea></p>',
  '<button type="submit">{{#if isEdit}}Save{{else}}Create{{/if}}</button>',
  "</form>",
  "</main>",
  `<script>${PAGE_FORM_SCRIPT}</script>`,
  "</body>",
  "</html>",
].join("\n");

/**
 * Render the create/edit page form (step 1) through html-renderer's real
 * `render:template` capability — `render` is that capability's own
 * `render()` function, passed straight through exactly like `diff.ts`'s
 * `renderDiffToHtml`/`markdown.ts`'s `renderMarkdownToHtml` take theirs,
 * rather than reaching for a module-level singleton.
 */
export function renderPageFormHtml(
  context: PageFormContext,
  render: RenderTemplateCapability["render"],
): Result<string, ValidationError> {
  return render(PAGE_FORM_TEMPLATE_SOURCE, context as unknown as TemplateContext);
}

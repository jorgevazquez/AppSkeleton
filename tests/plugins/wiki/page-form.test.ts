/**
 * Unit tests for `src/plugins/wiki/src/page-form.ts` (feature #96 — "Page
 * edit form UI with CSRF-protected submission"). No database or capability
 * plumbing required — `renderPageFormHtml`'s template source is a fixed,
 * module-owned constant (unlike `diff.ts`/`markdown.ts`, which build a new
 * template *source* per call), so these tests drive it through
 * html-renderer's real, pure `compileTemplate` (`../../../src/plugins/html-renderer/src/template.js`)
 * directly — the same "no I/O" precedent `diff.test.ts`/`markdown.test.ts`
 * already establish, just with the escaping assertions inline here (rather
 * than split into a separate integration suite) since there's no per-call
 * template *source* construction step of its own worth unit-testing
 * independently of the render.
 *
 * The CSRF-rejection end-to-end claim (step 3) is covered separately, over
 * a real capability broker + `app.inject()` HTTP round-trip, in
 * `page-form.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { isErr } from "../../../src/core/types.js";
import { compileTemplate } from "../../../src/plugins/html-renderer/src/template.js";
import type { RenderTemplateCapability } from "../../../src/plugins/html-renderer/index.js";
import {
  CREATE_PAGE_FORM_ACTION,
  editPageFormAction,
  editPageFormPath,
  renderPageFormHtml,
} from "../../../src/plugins/wiki/src/page-form.js";

/** A real (not mocked) `render()` — compiles+renders through html-renderer's actual template engine, same as the `render:template` capability's own implementation (`html-renderer/index.ts`). */
const render: RenderTemplateCapability["render"] = (source, context) => {
  const compiled = compileTemplate(source);
  if (!compiled.ok) {
    return compiled;
  }
  return { ok: true, value: compiled.value.render(context) };
};

function renderOrThrow(context: Parameters<typeof renderPageFormHtml>[0]): string {
  const result = renderPageFormHtml(context, render);
  if (isErr(result)) {
    throw result.error;
  }
  return result.value;
}

describe("page-form path helpers", () => {
  it("CREATE_PAGE_FORM_ACTION is the versioned POST /wiki/pages path feature #94 already registers", () => {
    expect(CREATE_PAGE_FORM_ACTION).toBe("/api/v1/wiki/pages");
  });

  it("editPageFormAction builds the versioned PATCH /wiki/pages/:id path for a given page id", () => {
    expect(editPageFormAction(42)).toBe("/api/v1/wiki/pages/42");
  });

  it("editPageFormPath builds the versioned GET /wiki/pages/:id/edit path for a given page id", () => {
    expect(editPageFormPath(42)).toBe("/api/v1/wiki/pages/42/edit");
  });
});

describe("renderPageFormHtml — create mode", () => {
  const html = renderOrThrow({
    isEdit: false,
    namespaceId: "",
    slug: "",
    title: "",
    content: "",
    actionPath: CREATE_PAGE_FORM_ACTION,
    actionMethod: "POST",
  });

  it("posts through the CSRF-protected create route from feature 64 (step 1)", () => {
    expect(html).toContain('data-method="POST"');
    // "/" is escaped by feature #47's attribute escaper (see
    // html-renderer/src/escape.ts's escapeAttr) — this is exactly what a
    // real browser decodes `form.dataset.action` back to.
    expect(html).toContain('data-action="&#x2F;api&#x2F;v1&#x2F;wiki&#x2F;pages"');
  });

  it("renders editable namespaceId/slug/title/content fields", () => {
    expect(html).toContain('name="namespaceId"');
    expect(html).toContain('name="slug"');
    expect(html).toContain('name="title"');
    expect(html).toContain('name="content"');
  });

  it("has a container for inline validation errors (step 2)", () => {
    expect(html).toContain('id="form-errors"');
  });

  it("includes exactly one <script> tag — the fixed, static submission script", () => {
    expect(html.match(/<script/g)).toHaveLength(1);
  });
});

describe("renderPageFormHtml — edit mode", () => {
  const html = renderOrThrow({
    isEdit: true,
    pageId: 7,
    namespaceId: "docs",
    slug: "getting-started",
    title: "Getting Started",
    content: "Welcome!",
    actionPath: editPageFormAction(7),
    actionMethod: "PATCH",
  });

  it("posts through the CSRF-protected update route from feature 64 (step 1)", () => {
    expect(html).toContain('data-method="PATCH"');
    expect(html).toContain('data-action="&#x2F;api&#x2F;v1&#x2F;wiki&#x2F;pages&#x2F;7"');
  });

  it("prefills title/content and echoes the immutable namespaceId/slug", () => {
    expect(html).toContain('value="Getting&#x20;Started"');
    expect(html).toContain(">Welcome!</textarea>");
    expect(html).toContain("Namespace: docs");
    expect(html).toContain("Slug: getting-started");
  });

  it("carries the page id in a hidden field", () => {
    expect(html).toContain('name="pageId" value="7"');
  });

  it("does not render namespaceId/slug as editable inputs (they're not part of the PATCH schema)", () => {
    expect(html).not.toContain('name="namespaceId"');
    expect(html).not.toContain('name="slug"');
  });
});

describe("renderPageFormHtml — escaping (feature #47 still applies here)", () => {
  it("neutralizes an XSS-style payload in a prefilled title (attribute context)", () => {
    const html = renderOrThrow({
      isEdit: true,
      pageId: 1,
      namespaceId: "docs",
      slug: "x",
      title: '"><script>alert(1)</script>',
      content: "safe",
      actionPath: editPageFormAction(1),
      actionMethod: "PATCH",
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    // Exactly one real <script> tag survives: this module's own fixed,
    // static submission script — the payload never opened a second one.
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it("neutralizes an XSS-style payload in prefilled content (HTML-body/textarea context)", () => {
    const html = renderOrThrow({
      isEdit: true,
      pageId: 1,
      namespaceId: "docs",
      slug: "x",
      title: "safe",
      content: "</textarea><script>alert(1)</script>",
      actionPath: editPageFormAction(1),
      actionMethod: "PATCH",
    });

    expect(html).not.toContain("</textarea><script>alert(1)</script>");
    expect(html.match(/<script/g)).toHaveLength(1);
  });
});

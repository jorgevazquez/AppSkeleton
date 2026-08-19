/**
 * Integration test for feature #88, steps 2 & 3: "Ensure the auto-escaping
 * from feature #47 still applies to any user-controlled text inside the
 * rendered output" and "Write a test rendering a page containing an
 * XSS-style payload in Markdown and asserting it is neutralized".
 *
 * Mirrors `tests/plugins/html-renderer/render-capability.integration.test.ts`'s
 * fixture-plugin pattern exactly: driven through the *real* capability
 * broker (`core/broker.ts`) and the *real* loader (`loadPlugins()`), with
 * the *real* `html-renderer` plugin module as `render:template`'s
 * provider — never a hand-rolled stand-in for either. A fixture
 * "wiki-markdown-consumer" plugin declares `render:template` under
 * `capabilities.requires`, obtains it in `onEnable` exactly the way a real
 * wiki lifecycle module eventually will, and calls
 * `wiki/src/markdown.ts`'s `renderMarkdownToHtml` with the capability's
 * own `render` function — proving the wiki plugin's Markdown renderer
 * actually goes through html-renderer's real escaping machinery
 * end-to-end, not just a same-module unit test's assumptions about it.
 */
import { describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isErr, isOk, unwrap } from "../../../src/core/types.js";
import * as htmlRendererModule from "../../../src/plugins/html-renderer/index.js";
import type { RenderTemplateCapability } from "../../../src/plugins/html-renderer/index.js";
import { renderMarkdownToHtml } from "../../../src/plugins/wiki/src/markdown.js";

/** Minimal, schema-shaped manifest fixture — mirrors render-capability.integration.test.ts's own `manifest()` helper. */
function manifest(
  id: string,
  options: { dependsOn?: Record<string, string>; provides?: string[]; requires?: string[] } = {},
): PluginManifest {
  return {
    id,
    version: "1.0.0",
    depends_on: options.dependsOn ?? {},
    capabilities: { provides: options.provides ?? [], requires: options.requires ?? [] },
    entry_point: "index.ts",
  };
}

const HTML_RENDERER_MANIFEST = manifest("html-renderer", { provides: ["render:template"] });

/**
 * Load the real html-renderer plugin plus a fixture wiki-markdown consumer
 * whose `onEnable` renders every markdown string in `sources` (in order)
 * via `renderMarkdownToHtml`, and return the rendered HTML strings in the
 * same order. Throws if plugin loading itself fails (a bug in the fixture,
 * not something any test case here expects).
 */
async function renderAllThroughRealCapability(sources: readonly string[]): Promise<string[]> {
  const results: string[] = [];

  const consumerManifest = manifest("wiki-markdown-consumer", {
    dependsOn: { "html-renderer": "^1.0.0" },
    requires: ["render:template"],
  });

  const consumerModule: PluginModule = {
    onEnable(context) {
      const obtained = context.capabilities.obtain<RenderTemplateCapability>("render:template");
      if (isErr(obtained)) {
        throw obtained.error;
      }
      for (const source of sources) {
        results.push(unwrap(renderMarkdownToHtml(source, obtained.value.render)));
      }
    },
  };

  const definitions: PluginDefinition[] = [
    { manifest: HTML_RENDERER_MANIFEST, module: htmlRendererModule },
    { manifest: consumerManifest, module: consumerModule },
  ];

  const broker = createCapabilityBroker();
  const loadResult = await loadPlugins(definitions, broker);
  expect(isOk(loadResult)).toBe(true);
  if (!isOk(loadResult)) {
    throw new Error("plugin load unexpectedly failed");
  }
  expect(loadResult.value.failed).toEqual([]);

  return results;
}

describe("wiki markdown rendering via the real render:template capability (feature #88)", () => {
  it("renders ordinary markdown to the expected safe HTML", async () => {
    const [html] = await renderAllThroughRealCapability([
      "# Welcome\n\nThis is **bold** and *italic*, with a [link](https://example.com/page).",
    ]);
    // The href value is HTML-attribute-escaped by feature #47's escapeUrl
    // (every non-alphanumeric character, including "://" and ".", becomes a
    // hex character reference — browsers decode these identically to the
    // literal characters, see escape.ts's own docs) even though "https:" is
    // an allowed scheme, so this asserts the actual escaped form rather than
    // the unescaped URL.
    expect(html).toBe(
      "<h1>Welcome</h1>" +
        "<p>This is <strong>bold</strong> and <em>italic</em>, with a " +
        '<a href="https&#x3A;&#x2F;&#x2F;example&#x2E;com&#x2F;page">link</a>.</p>',
    );
  });

  describe("step 2: feature #47's auto-escaping still applies to user-controlled Markdown text", () => {
    it("HTML-escapes plain body text that contains `& < > \" '`", async () => {
      const [html] = await renderAllThroughRealCapability(['Tom & Jerry\'s <favorite> "show"']);
      expect(html).toBe("<p>Tom &amp; Jerry&#39;s &lt;favorite&gt; &quot;show&quot;</p>");
    });

    it("escapes text inside inline code spans and fenced code blocks the same way", async () => {
      const [html] = await renderAllThroughRealCapability(["`<b>`\n\n```\n<b>not bold</b>\n```"]);
      expect(html).toBe(
        "<p><code>&lt;b&gt;</code></p><pre><code>&lt;b&gt;not bold&lt;/b&gt;</code></pre>",
      );
    });
  });

  describe("step 3: an XSS-style payload in Markdown is neutralized", () => {
    it("neutralizes a raw <script> tag typed directly into the markdown body", async () => {
      const [html] = await renderAllThroughRealCapability([
        "# Report\n\n<script>alert(document.cookie)</script>\n\nEnd of report.",
      ]);
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;alert(document.cookie)&lt;/script&gt;");
    });

    it("neutralizes an <img onerror=...> payload typed directly into the markdown body", async () => {
      const [html] = await renderAllThroughRealCapability(['<img src=x onerror="alert(1)">']);
      expect(html).not.toContain("<img src=x");
      expect(html).not.toContain('onerror="alert(1)"');
      expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    });

    it("rejects a javascript: URL scheme in a markdown link, never emitting a working href", async () => {
      const [html] = await renderAllThroughRealCapability([
        "[click me](javascript:alert(document.cookie))",
      ]);
      // escapeUrl (feature #47) replaces a dangerous-scheme URL outright,
      // rather than merely escaping it — matching escape.test.ts's own
      // "blocks a javascript: URL outright" assertion style: the scheme and
      // payload text are gone entirely, not just HTML-entity-encoded.
      expect((html as string).toLowerCase()).not.toContain("javascript");
      expect(html).not.toContain("alert");
    });

    it("rejects a javascript: URL scheme in a markdown image src", async () => {
      const [html] = await renderAllThroughRealCapability(["![alt](javascript:alert(1))"]);
      expect((html as string).toLowerCase()).not.toContain("javascript");
      expect(html).not.toContain("alert");
    });

    it("never lets a quote-breakout / raw-HTML payload in a markdown link's URL survive unescaped (data, not a raw string)", async () => {
      // A payload that would break out of the href *attribute* if this
      // module ever concatenated markdown text directly into the template
      // *source* instead of routing it through the context object (the
      // "fed into render:template as data, not as a raw string" property
      // step 1 requires). The scheme itself (https:) is allowed, so
      // escapeUrl HTML-attribute-escapes the whole value instead of
      // replacing it outright — matching escape.test.ts's own "still
      // HTML-attribute-escapes an allowed URL that also carries a
      // quote-breakout payload" precedent.
      const [html] = await renderAllThroughRealCapability([
        '[x](https://evil.com/"><script>evil</script>)',
      ]);
      expect(html).not.toContain("<script>");
      expect(html).not.toContain('"><script>');
    });

    it("does not execute a template-injection attempt embedded as markdown text", async () => {
      const [html] = await renderAllThroughRealCapability([
        "{{#each secrets}}leaked: {{this}}{{/each}}",
      ]);
      // Rendered as inert escaped text, not evaluated as template syntax —
      // proving the raw markdown text never became part of the template
      // *source* compileTemplate actually parses.
      expect(html).toBe("<p>{{#each secrets}}leaked: {{this}}{{/each}}</p>");
    });
  });
});

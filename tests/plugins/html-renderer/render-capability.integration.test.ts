/**
 * Integration test for feature #52, steps 2 & 3: "Write a fixture consumer
 * plugin proving the cross-plugin render contract works end-to-end" plus
 * "Write an integration test for the fixture consumer" — driven through the
 * *real* capability broker, the *real* loader (`loadPlugins()`), and the
 * *real* `html-renderer` plugin module (not a hand-rolled fixture standing
 * in for it), mirroring
 * `tests/plugins/rbac/check-capability.integration.test.ts`'s fixture-plugin
 * pattern: a second, fixture plugin declares `render:template` under
 * `capabilities.requires`, obtains it in its own `onEnable`, and calls both
 * `compile()`/`.render()` and the `render()` convenience — proving
 * `render:template` actually works for *other* plugins, end-to-end, through
 * the broker's declare/grant/obtain gating (not just as a direct function
 * call within the html-renderer plugin itself).
 *
 * Uses a hand-built manifest fixture for `html-renderer` declaring only
 * `["render:template"]` — matching the real, already-shipped
 * `html-renderer/plugin.json` (which really does declare only that one
 * capability; see manifest.test.ts), so this fixture is a faithful stand-in
 * rather than a narrowed one, unlike rbac's manifest fixture (which really
 * does have to narrow around `rbac:manage`, feature #36).
 */
import { describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { CapabilityDeniedError } from "../../../src/core/errors.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isErr, isOk } from "../../../src/core/types.js";
import * as htmlRendererModule from "../../../src/plugins/html-renderer/index.js";
import type { RenderTemplateCapability } from "../../../src/plugins/html-renderer/index.js";

/** Build a minimal, schema-shaped manifest fixture without going through validateManifest() — mirrors check-capability.integration.test.ts's own `manifest()` helper. */
function manifest(
  id: string,
  options: {
    dependsOn?: Record<string, string>;
    provides?: string[];
    requires?: string[];
  } = {},
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

describe("render:template — integration (feature #52)", () => {
  it("a fixture plugin obtains render:template, compiles once and renders twice, and uses the render() convenience for a one-shot render", async () => {
    // Captured by the fixture plugin's onEnable so the test can assert on
    // what it actually observed, without the fixture module needing any
    // HTTP surface of its own — render:template is a plain function
    // capability, not a route-registration one.
    const results: Record<string, string> = {};

    const pageManifest = manifest("page-plugin", {
      dependsOn: { "html-renderer": "^1.0.0" },
      requires: ["render:template"],
    });

    const pageModule: PluginModule = {
      onEnable(context) {
        const obtained =
          context.capabilities.obtain<RenderTemplateCapability>("render:template");
        if (isErr(obtained)) {
          throw obtained.error;
        }
        const { compile, render } = obtained.value;

        // compile() once, render() many — the reuse-across-contexts path.
        const compiled = compile("<p>Hello, {{name}}!</p>");
        if (isErr(compiled)) {
          throw compiled.error;
        }
        results.alice = compiled.value.render({ name: "Alice" });
        results.bob = compiled.value.render({ name: "Bob" });

        // The auto-escaping contract (feature #47) holds through the
        // capability too, not just when calling compileTemplate directly.
        results.escaped = compiled.value.render({ name: "<script>evil()</script>" });

        // render() — the compile-and-render-once convenience.
        const rendered = render("<p>{{#if loud}}HELLO{{else}}hello{{/if}}</p>", { loud: true });
        if (isErr(rendered)) {
          throw rendered.error;
        }
        results.loud = rendered.value;
      },
    };

    const definitions: PluginDefinition[] = [
      { manifest: HTML_RENDERER_MANIFEST, module: htmlRendererModule },
      { manifest: pageManifest, module: pageModule },
    ];

    const broker = createCapabilityBroker();
    const loadResult = await loadPlugins(definitions, broker);
    expect(isOk(loadResult)).toBe(true);
    if (!isOk(loadResult)) {
      return;
    }
    expect(loadResult.value.failed).toEqual([]);
    expect(loadResult.value.loaded.map((plugin) => plugin.id).sort()).toEqual([
      "html-renderer",
      "page-plugin",
    ]);

    expect(results.alice).toBe("<p>Hello, Alice!</p>");
    expect(results.bob).toBe("<p>Hello, Bob!</p>");
    expect(results.escaped).toBe("<p>Hello, &lt;script&gt;evil()&lt;/script&gt;!</p>");
    expect(results.loud).toBe("<p>HELLO</p>");
  });

  it("a malformed template surfaces as a typed Result error through the capability, not a thrown exception", async () => {
    const brokenManifest = manifest("broken-consumer", {
      dependsOn: { "html-renderer": "^1.0.0" },
      requires: ["render:template"],
    });

    let sawValidationError = false;

    const brokenModule: PluginModule = {
      onEnable(context) {
        const obtained =
          context.capabilities.obtain<RenderTemplateCapability>("render:template");
        if (isErr(obtained)) {
          throw obtained.error;
        }
        const compiled = obtained.value.compile("{{#if unclosed}}oops");
        sawValidationError = isErr(compiled);
      },
    };

    const definitions: PluginDefinition[] = [
      { manifest: HTML_RENDERER_MANIFEST, module: htmlRendererModule },
      { manifest: brokenManifest, module: brokenModule },
    ];

    const broker = createCapabilityBroker();
    const loadResult = await loadPlugins(definitions, broker);
    expect(isOk(loadResult)).toBe(true);
    if (!isOk(loadResult)) {
      return;
    }
    expect(loadResult.value.failed).toEqual([]);
    expect(sawValidationError).toBe(true);
  });

  it("a fixture plugin that never declared render:template under capabilities.requires fails its own onEnable, isolating it without affecting html-renderer or unrelated plugins", async () => {
    const undeclaredManifest = manifest("undeclared-consumer", {
      dependsOn: { "html-renderer": "^1.0.0" },
      requires: [], // deliberately omits "render:template"
    });

    const undeclaredModule: PluginModule = {
      onEnable(context) {
        const obtained =
          context.capabilities.obtain<RenderTemplateCapability>("render:template");
        if (isErr(obtained)) {
          throw obtained.error;
        }
      },
    };

    const unrelatedManifest = manifest("unrelated", {});
    const unrelatedModule: PluginModule = {};

    const definitions: PluginDefinition[] = [
      { manifest: HTML_RENDERER_MANIFEST, module: htmlRendererModule },
      { manifest: undeclaredManifest, module: undeclaredModule },
      { manifest: unrelatedManifest, module: unrelatedModule },
    ];

    const broker = createCapabilityBroker();
    const loadResult = await loadPlugins(definitions, broker);
    expect(isOk(loadResult)).toBe(true);
    if (!isOk(loadResult)) {
      return;
    }

    expect(loadResult.value.loaded.map((plugin) => plugin.id).sort()).toEqual([
      "html-renderer",
      "unrelated",
    ]);
    expect(loadResult.value.failed.map((plugin) => plugin.id)).toEqual(["undeclared-consumer"]);
    // loadPlugins() normalizes any thrown onEnable error into a
    // PluginLoadError (see loader.ts's toPluginLoadError()), preserving the
    // original CapabilityDeniedError as its `cause` — assert both layers so
    // this test proves the *right* thing failed (broker declare-gating),
    // not just that *something* failed. Mirrors
    // check-capability.integration.test.ts's identical cause-chain check.
    const failure = loadResult.value.failed[0];
    expect(failure?.error.cause).toBeInstanceOf(CapabilityDeniedError);
    expect((failure?.error.cause as CapabilityDeniedError).details).toMatchObject({
      reason: "not_declared",
    });

    // html-renderer itself is unaffected — a fresh consumer that *does*
    // declare the capability can still obtain it in a later load.
    expect(broker.isGranted("undeclared-consumer", "render:template")).toBe(false);
  });
});

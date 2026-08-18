import { describe, expect, it } from "vitest";
import { RenderError, ValidationError } from "../../../src/core/errors.js";
import { isErr, unwrap } from "../../../src/core/types.js";
import { compileTemplate } from "../../../src/plugins/html-renderer/src/template.js";
import { compileWithPartials } from "../../../src/plugins/html-renderer/src/partial.js";
import { escapeHtml } from "../../../src/plugins/html-renderer/src/escape.js";

/** Convenience: compile a template through its partial registry and render, asserting compilation succeeded. */
function render(
  source: string,
  partials: Record<string, string>,
  context?: Record<string, unknown>,
): string {
  const compiled = unwrap(compileWithPartials(source, partials));
  return compiled.render(context);
}

describe("basic partial inclusion", () => {
  it("includes a partial with no parameters", () => {
    expect(render("<p>{{> greeting}}</p>", { greeting: "Hello!" })).toBe("<p>Hello!</p>");
  });

  it("includes the same partial multiple times", () => {
    expect(render("{{> star}}{{> star}}{{> star}}", { star: "*" })).toBe("***");
  });

  it("renders a partial's own text and variables against the params it was given, not global context", () => {
    const html = render('<div>{{> row name="Ada"}}</div>', { row: "<span>{{name}}</span>" });
    expect(html).toBe("<div><span>Ada</span></div>");
  });
});

describe("parameterized partials", () => {
  const partials = { greet: "Hello, {{name}}! You are {{age}}." };

  it("passes a quoted string literal parameter", () => {
    expect(render('{{> greet name="Ada" age="unknown"}}', partials)).toBe(
      "Hello, Ada! You are unknown.",
    );
  });

  it("passes a single-quoted string literal parameter", () => {
    expect(render("{{> greet name='Grace' age='30'}}", partials)).toBe("Hello, Grace! You are 30.");
  });

  it("resolves a path parameter against the call site's scope", () => {
    expect(
      render("{{> greet name=user.name age=user.age}}", partials, {
        user: { name: "Lin", age: 42 },
      }),
    ).toBe("Hello, Lin! You are 42.");
  });

  it("resolves `this` (the current loop item) as a parameter value", () => {
    const html = render(
      "{{#each items}}{{> item value=this}}{{/each}}",
      { item: "[{{value}}]" },
      { items: ["a", "b"] },
    );
    expect(html).toBe("[a][b]");
  });

  it("mixes literal and path parameters in the same call", () => {
    expect(
      render('{{> greet name=user.name age="unknown"}}', partials, { user: { name: "Zed" } }),
    ).toBe("Hello, Zed! You are unknown.");
  });

  it("leaves an unpassed parameter empty, same as a missing top-level variable", () => {
    expect(render('{{> greet name="Solo"}}', partials)).toBe("Hello, Solo! You are .");
  });
});

describe("isolated scope", () => {
  it("does not leak the call site's own context into the partial body", () => {
    const html = render("{{> body}}", { body: "[{{secret}}]" }, { secret: "leaked" });
    expect(html).toBe("[]");
  });

  it("does not fall back to the call site's context for a parameter the partial references but the call didn't pass", () => {
    // The caller's `name` is never passed as a parameter, so the partial must not see it despite
    // being rendered from a context that happens to define `name` at the top level.
    const html = render("{{> greeting}}", { greeting: "Hi, {{name}}." }, { name: "Ada" });
    expect(html).toBe("Hi, .");
  });

  it("scopes {{#each}} inside a partial to the partial's own params, not the caller's arrays", () => {
    const html = render(
      "{{> list items=fruits}}",
      { list: "{{#each items}}({{this}}){{/each}}" },
      { fruits: ["a", "b"], other: ["x", "y"] },
    );
    expect(html).toBe("(a)(b)");
  });

  it("still auto-escapes variables inside a partial's own body", () => {
    const html = render("{{> row bio=bio}}", { row: "<p>{{bio}}</p>" }, { bio: "<b>hi</b>" });
    expect(html).toBe(`<p>${escapeHtml("<b>hi</b>")}</p>`);
  });
});

describe("recursion", () => {
  const partials = {
    // Each level renders its own value, then recurses into the next node (if any) with a fresh,
    // isolated set of params -- the classic "linked list" partial-recursion shape.
    node: "({{value}}{{#if next}}{{> node value=next.value next=next.next}}{{/if}})",
  };

  function chain(depth: number): unknown {
    let node: Record<string, unknown> | null = null;
    for (let i = depth; i >= 1; i--) {
      node = { value: i, next: node };
    }
    return node;
  }

  /** Mirrors the `node` partial's own recursive definition, to avoid hand-counting parens. */
  function expectedChainOutput(depth: number): string {
    let out = "";
    for (let i = 1; i <= depth; i++) {
      out += `(${i}`;
    }
    out += ")".repeat(depth);
    return out;
  }

  it("supports a partial that includes itself, terminating via ordinary template logic", () => {
    const html = render("{{> node value=root.value next=root.next}}", partials, {
      root: chain(4),
    });
    expect(html).toBe(expectedChainOutput(4));
    expect(html).toBe("(1(2(3(4))))");
  });

  it("renders a deeply-but-not-infinitely recursive self-including partial without error", () => {
    const html = render("{{> node value=root.value next=root.next}}", partials, {
      root: chain(15),
    });
    expect(html).toBe(expectedChainOutput(15));
  });

  it("throws a RenderError once an unconditionally self-including partial exceeds the max depth", () => {
    expect(() => render("{{> loop}}", { loop: "x{{> loop}}" })).toThrow(RenderError);
  });

  it("the max-depth error message names the recursion/depth problem", () => {
    try {
      render("{{> loop}}", { loop: "x{{> loop}}" });
      expect.unreachable("expected render() to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RenderError);
      expect((error as RenderError).message).toMatch(/depth/i);
    }
  });

  it("also guards a two-partial mutual-recursion cycle", () => {
    expect(() => render("{{> ping}}", { ping: "{{> pong}}", pong: "{{> ping}}" })).toThrow(
      RenderError,
    );
  });
});

describe("error handling", () => {
  it("rejects compileTemplate on a template containing {{> partial}}", () => {
    const result = compileTemplate("{{> row}}");
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.message).toContain("compileWithPartials");
    }
  });

  it("rejects a template with a malformed {{> }} tag (no name)", () => {
    const result = compileWithPartials("{{> }}", {});
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.message).toContain("expected a partial name");
    }
  });

  it("rejects a malformed parameter list", () => {
    const result = compileWithPartials("{{> row ???}}", {});
    expect(isErr(result)).toBe(true);
  });

  it("throws a RenderError for an unknown partial name at render time", () => {
    expect(() => render("{{> nope}}", {})).toThrow(RenderError);
  });

  it("throws a RenderError when a referenced partial's own source fails to parse", () => {
    expect(() => render("{{> broken}}", { broken: "{{#if x}}unclosed" })).toThrow(RenderError);
  });

  it("rejects compileWithPartials on a template containing {{extends}}", () => {
    const result = compileWithPartials("{{extends base}}", {});
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.message).toContain("compileWithLayout");
    }
  });
});

describe("using a resolver function instead of a plain map", () => {
  it("accepts a name => source | undefined function for partials", () => {
    const registry = new Map([["greeting", "Hi, {{name}}!"]]);
    const result = compileWithPartials('{{> greeting name="Ada"}}', (name) => registry.get(name));
    expect(unwrap(result).render()).toBe("Hi, Ada!");
  });
});

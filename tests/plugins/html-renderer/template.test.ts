import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../src/core/errors.js";
import { isErr, isOk, unwrap } from "../../../src/core/types.js";
import { compileTemplate, parseTemplate } from "../../../src/plugins/html-renderer/src/template.js";

/** Convenience: compile and render in one step, asserting compilation succeeded. */
function render(source: string, context?: Record<string, unknown>): string {
  const compiled = unwrap(compileTemplate(source));
  return compiled.render(context);
}

describe("variable interpolation", () => {
  it("renders plain text with no tags unchanged", () => {
    expect(render("hello world")).toBe("hello world");
  });

  it("interpolates a top-level variable", () => {
    expect(render("Hello, {{name}}!", { name: "Ada" })).toBe("Hello, Ada!");
  });

  it("interpolates multiple variables surrounded by text", () => {
    expect(render("{{greeting}}, {{name}}!", { greeting: "Hi", name: "Grace" })).toBe("Hi, Grace!");
  });

  it("interpolates a nested dotted path", () => {
    expect(render("{{user.name}}", { user: { name: "Ada" } })).toBe("Ada");
  });

  it("interpolates a deeply nested dotted path", () => {
    expect(render("{{a.b.c.d}}", { a: { b: { c: { d: "deep" } } } })).toBe("deep");
  });

  it("tolerates surrounding whitespace inside a tag", () => {
    expect(render("{{  name  }}", { name: "Ada" })).toBe("Ada");
  });

  it("renders an empty string for a missing top-level variable", () => {
    expect(render("[{{missing}}]")).toBe("[]");
  });

  it("renders an empty string when an intermediate path segment is missing", () => {
    expect(render("[{{user.name}}]", {})).toBe("[]");
  });

  it("renders an empty string when an intermediate path segment is not an object", () => {
    expect(render("[{{user.name}}]", { user: "not-an-object" })).toBe("[]");
  });

  it("renders an empty string for null and undefined values", () => {
    expect(render("[{{a}}|{{b}}]", { a: null, b: undefined })).toBe("[|]");
  });

  it("stringifies non-string values", () => {
    expect(render("{{n}}", { n: 42 })).toBe("42");
    expect(render("{{t}}", { t: true })).toBe("true");
    expect(render("{{f}}", { f: false })).toBe("false");
  });

  it("renders with no context argument at all", () => {
    expect(render("static only")).toBe("static only");
  });
});

describe("conditionals", () => {
  it("renders the consequent when the condition is truthy", () => {
    expect(render("{{#if ok}}yes{{/if}}", { ok: true })).toBe("yes");
  });

  it("renders nothing when the condition is falsy and there is no else", () => {
    expect(render("[{{#if ok}}yes{{/if}}]", { ok: false })).toBe("[]");
  });

  it("renders the alternate branch when the condition is falsy", () => {
    expect(render("{{#if ok}}yes{{else}}no{{/if}}", { ok: false })).toBe("no");
  });

  it("renders the consequent branch (not the alternate) when truthy", () => {
    expect(render("{{#if ok}}yes{{else}}no{{/if}}", { ok: true })).toBe("yes");
  });

  it("treats a missing variable as falsy", () => {
    expect(render("{{#if missing}}yes{{else}}no{{/if}}")).toBe("no");
  });

  it.each<[string, unknown, boolean]>([
    ["0", 0, false],
    ["empty string", "", false],
    ["NaN", Number.NaN, false],
    ["null", null, false],
    ["undefined", undefined, false],
    ["false", false, false],
    ["empty array", [], false],
    ["non-empty array", [1], true],
    ["non-zero number", 1, true],
    ["non-empty string", "x", true],
    ["empty object", {}, true],
    ["the string 'false'", "false", true],
  ])("treats %s as %s", (_desc, value, truthy) => {
    expect(render("{{#if v}}T{{else}}F{{/if}}", { v: value })).toBe(truthy ? "T" : "F");
  });

  it("supports nested conditionals", () => {
    const template = "{{#if outer}}O[{{#if inner}}I{{else}}i{{/if}}]{{else}}o{{/if}}";
    expect(render(template, { outer: true, inner: true })).toBe("O[I]");
    expect(render(template, { outer: true, inner: false })).toBe("O[i]");
    expect(render(template, { outer: false, inner: true })).toBe("o");
  });

  it("supports three levels of conditional nesting", () => {
    const template =
      "{{#if a}}{{#if b}}{{#if c}}abc{{else}}ab-not-c{{/if}}{{else}}a-not-b{{/if}}{{else}}not-a{{/if}}";
    expect(render(template, { a: true, b: true, c: true })).toBe("abc");
    expect(render(template, { a: true, b: true, c: false })).toBe("ab-not-c");
    expect(render(template, { a: true, b: false, c: true })).toBe("a-not-b");
    expect(render(template, { a: false, b: true, c: true })).toBe("not-a");
  });

  it("evaluates a dotted path as the condition", () => {
    expect(render("{{#if user.active}}yes{{else}}no{{/if}}", { user: { active: true } })).toBe(
      "yes",
    );
  });
});

describe("loops over arrays", () => {
  it("renders nothing for an empty array", () => {
    expect(render("[{{#each items}}{{this}}{{/each}}]", { items: [] })).toBe("[]");
  });

  it("renders nothing when the collection is missing", () => {
    expect(render("[{{#each items}}{{this}}{{/each}}]", {})).toBe("[]");
  });

  it("iterates primitive array items via {{this}}", () => {
    expect(render("{{#each items}}({{this}}){{/each}}", { items: ["a", "b", "c"] })).toBe(
      "(a)(b)(c)",
    );
  });

  it("exposes @index as a zero-based numeric position", () => {
    expect(render("{{#each items}}{{@index}}:{{this}} {{/each}}", { items: ["x", "y"] })).toBe(
      "0:x 1:y ",
    );
  });

  it("exposes @key as the array index string", () => {
    expect(render("{{#each items}}{{@key}}={{this}};{{/each}}", { items: ["x", "y"] })).toBe(
      "0=x;1=y;",
    );
  });

  it("iterates array-of-object items with dotted access", () => {
    const source = "{{#each users}}{{name}}({{age}}) {{/each}}";
    const context = {
      users: [
        { name: "Ada", age: 36 },
        { name: "Grace", age: 85 },
      ],
    };
    expect(render(source, context)).toBe("Ada(36) Grace(85) ");
  });

  it("supports conditionals inside a loop body", () => {
    const source = "{{#each users}}{{#if active}}{{name}} {{/if}}{{/each}}";
    const context = {
      users: [
        { name: "Ada", active: true },
        { name: "Bob", active: false },
      ],
    };
    expect(render(source, context)).toBe("Ada ");
  });
});

describe("loops over objects", () => {
  it("renders nothing for an object with no own keys", () => {
    expect(render("[{{#each obj}}{{@key}}{{/each}}]", { obj: {} })).toBe("[]");
  });

  it("iterates own keys and values via @key/@index/this", () => {
    const source = "{{#each obj}}{{@index}}:{{@key}}={{this}} {{/each}}";
    expect(render(source, { obj: { a: 1, b: 2 } })).toBe("0:a=1 1:b=2 ");
  });

  it("iterates nested object property access per entry", () => {
    const source = "{{#each people}}{{@key}}:{{name}} {{/each}}";
    const context = { people: { alice: { name: "Alice" }, bob: { name: "Bob" } } };
    expect(render(source, context)).toBe("alice:Alice bob:Bob ");
  });
});

describe("nested loops", () => {
  it("iterates a matrix of arrays", () => {
    const source = "{{#each rows}}[{{#each this}}{{this}},{{/each}}]{{/each}}";
    expect(
      render(source, {
        rows: [
          [1, 2],
          [3, 4],
        ],
      }),
    ).toBe("[1,2,][3,4,]");
  });

  it("resolves an outer-scope variable from inside a nested each (context stack fallback)", () => {
    const source = "{{#each items}}{{prefix}}-{{this}} {{/each}}";
    expect(render(source, { prefix: "item", items: ["a", "b"] })).toBe("item-a item-b ");
  });

  it("resolves an outer loop's item field from inside a nested each", () => {
    const source =
      "{{#each groups}}{{label}}:{{#each members}}{{this}}/{{label}} {{/each}}{{/each}}";
    const context = {
      groups: [{ label: "g1", members: ["a", "b"] }],
    };
    expect(render(source, context)).toBe("g1:a/g1 b/g1 ");
  });
});

describe("compileTemplate: parse-once reuse", () => {
  it("renders the same compiled template against different contexts", () => {
    const compiled = unwrap(
      compileTemplate("Hi {{name}}, you are {{#if adult}}an adult{{else}}a minor{{/if}}."),
    );
    expect(compiled.render({ name: "Ada", adult: true })).toBe("Hi Ada, you are an adult.");
    expect(compiled.render({ name: "Sam", adult: false })).toBe("Hi Sam, you are a minor.");
  });

  it("returns a distinct render function per compileTemplate call", () => {
    const a = unwrap(compileTemplate("{{x}}"));
    const b = unwrap(compileTemplate("{{x}}"));
    expect(a.render({ x: 1 })).toBe("1");
    expect(b.render({ x: 2 })).toBe("2");
  });
});

describe("parseTemplate: structural errors", () => {
  it("rejects an unclosed {{#if}} block", () => {
    const result = parseTemplate("{{#if ok}}yes");
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.message).toMatch(/if/i);
    }
  });

  it("rejects an unclosed {{#each}} block", () => {
    const result = parseTemplate("{{#each items}}{{this}}");
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });

  it("rejects a stray {{/if}} with no matching {{#if}}", () => {
    expect(isErr(parseTemplate("hello {{/if}}"))).toBe(true);
  });

  it("rejects a stray {{/each}} with no matching {{#each}}", () => {
    expect(isErr(parseTemplate("hello {{/each}}"))).toBe(true);
  });

  it("rejects a stray {{else}} with no matching {{#if}}", () => {
    expect(isErr(parseTemplate("hello {{else}} world"))).toBe(true);
  });

  it("rejects mismatched block nesting ({{#if}} closed by {{/each}})", () => {
    expect(isErr(parseTemplate("{{#if ok}}x{{/each}}"))).toBe(true);
  });

  it("rejects an empty tag", () => {
    expect(isErr(parseTemplate("{{}}"))).toBe(true);
  });

  it("rejects an {{#if}} with no condition path", () => {
    expect(isErr(parseTemplate("{{#if}}x{{/if}}"))).toBe(true);
  });

  it("rejects an {{#each}} with no collection path", () => {
    expect(isErr(parseTemplate("{{#each}}x{{/each}}"))).toBe(true);
  });

  it("rejects an invalid path expression", () => {
    expect(isErr(parseTemplate("{{user..name}}"))).toBe(true);
    expect(isErr(parseTemplate("{{1invalid}}"))).toBe(true);
    expect(isErr(parseTemplate("{{user-name}}"))).toBe(true);
  });

  it("rejects an unknown block tag", () => {
    expect(isErr(parseTemplate("{{#unless ok}}x{{/unless}}"))).toBe(true);
  });

  it("accepts a well-formed template and returns an AST array", () => {
    const result = parseTemplate("Hi {{name}}{{#if a}}A{{/if}}{{#each xs}}{{this}}{{/each}}");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(Array.isArray(result.value)).toBe(true);
      expect(result.value.length).toBeGreaterThan(0);
    }
  });
});

describe("compileTemplate: propagates parse errors", () => {
  it("returns Err without producing a CompiledTemplate for malformed source", () => {
    const result = compileTemplate("{{#if ok}}unclosed");
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../../src/core/errors.js";
import { isErr, unwrap } from "../../../src/core/types.js";
import {
  createTemplateCache,
  type TemplateFileSnapshot,
} from "../../../src/plugins/html-renderer/src/template-cache.js";

/** A fake, in-memory "file on disk" a test can mutate between `get()` calls, with a call counter. */
function fakeFileSystem(initial: TemplateFileSnapshot) {
  let current = initial;
  const readTemplateFile = vi.fn((_path: string): TemplateFileSnapshot => current);
  return {
    readTemplateFile,
    write(next: TemplateFileSnapshot): void {
      current = next;
    },
  };
}

describe("createTemplateCache: basic caching", () => {
  it("compiles a path on first access and reuses the same compiled instance on a later hit", () => {
    const fs = fakeFileSystem({ source: "Hello, {{name}}!", mtimeMs: 1 });
    const cache = createTemplateCache({
      nodeEnv: "development",
      readTemplateFile: fs.readTemplateFile,
    });

    const first = unwrap(cache.get("/templates/greeting.html"));
    const second = unwrap(cache.get("/templates/greeting.html"));

    expect(first).toBe(second);
    expect(first.render({ name: "Ada" })).toBe("Hello, Ada!");
    expect(cache.size()).toBe(1);
  });

  it("tracks distinct paths as separate cache entries", () => {
    const fs = fakeFileSystem({ source: "A: {{a}}", mtimeMs: 1 });
    const cache = createTemplateCache({
      nodeEnv: "production",
      readTemplateFile: fs.readTemplateFile,
    });

    unwrap(cache.get("/templates/a.html"));
    unwrap(cache.get("/templates/b.html"));

    expect(cache.size()).toBe(2);
  });

  it("returns a ValidationError (never throws) for a template that fails to compile", () => {
    const fs = fakeFileSystem({ source: "{{#if}}", mtimeMs: 1 });
    const cache = createTemplateCache({
      nodeEnv: "development",
      readTemplateFile: fs.readTemplateFile,
    });

    const result = cache.get("/templates/broken.html");

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });

  it("returns a ValidationError (never throws) when the file cannot be read", () => {
    const readTemplateFile = vi.fn((): TemplateFileSnapshot => {
      throw new Error("ENOENT: no such file or directory");
    });
    const cache = createTemplateCache({ nodeEnv: "development", readTemplateFile });

    const result = cache.get("/templates/missing.html");

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.message).toContain("/templates/missing.html");
    }
  });

  it("clear() forces every path to recompile on next access", () => {
    const fs = fakeFileSystem({ source: "v1", mtimeMs: 1 });
    const cache = createTemplateCache({
      nodeEnv: "production",
      readTemplateFile: fs.readTemplateFile,
    });

    const first = unwrap(cache.get("/templates/x.html"));
    cache.clear();
    expect(cache.size()).toBe(0);

    fs.write({ source: "v2", mtimeMs: 2 });
    const second = unwrap(cache.get("/templates/x.html"));

    expect(second).not.toBe(first);
    expect(second.render()).toBe("v2");
  });
});

describe("createTemplateCache: dev-mode invalidation on file change", () => {
  it("picks up a changed template's new content on the next get() after a change", () => {
    const fs = fakeFileSystem({ source: "Hello, {{name}}!", mtimeMs: 1 });
    const cache = createTemplateCache({
      nodeEnv: "development",
      readTemplateFile: fs.readTemplateFile,
    });

    const before = unwrap(cache.get("/templates/greeting.html"));
    expect(before.render({ name: "Ada" })).toBe("Hello, Ada!");

    fs.write({ source: "Goodbye, {{name}}.", mtimeMs: 2 });
    const after = unwrap(cache.get("/templates/greeting.html"));

    expect(after).not.toBe(before);
    expect(after.render({ name: "Ada" })).toBe("Goodbye, Ada.");
  });

  it("does not recompile when re-checked and nothing has changed (same mtime)", () => {
    const fs = fakeFileSystem({ source: "Hello, {{name}}!", mtimeMs: 1 });
    const cache = createTemplateCache({
      nodeEnv: "development",
      readTemplateFile: fs.readTemplateFile,
    });

    const first = unwrap(cache.get("/templates/greeting.html"));
    const second = unwrap(cache.get("/templates/greeting.html"));
    const third = unwrap(cache.get("/templates/greeting.html"));

    // Still re-checks the file each time in dev mode ...
    expect(fs.readTemplateFile).toHaveBeenCalledTimes(3);
    // ... but hands back the exact same compiled instance since nothing actually changed.
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("does not recompile when mtime moves but the content hash is unchanged (e.g. a touch)", () => {
    const fs = fakeFileSystem({ source: "Hello, {{name}}!", mtimeMs: 1 });
    const cache = createTemplateCache({
      nodeEnv: "development",
      readTemplateFile: fs.readTemplateFile,
    });

    const first = unwrap(cache.get("/templates/greeting.html"));
    fs.write({ source: "Hello, {{name}}!", mtimeMs: 2 }); // same bytes, newer mtime
    const second = unwrap(cache.get("/templates/greeting.html"));

    expect(second).toBe(first);
  });

  it("recompiles again if the file changes a second time", () => {
    const fs = fakeFileSystem({ source: "v1", mtimeMs: 1 });
    const cache = createTemplateCache({
      nodeEnv: "development",
      readTemplateFile: fs.readTemplateFile,
    });

    const v1 = unwrap(cache.get("/templates/versioned.html"));
    fs.write({ source: "v2", mtimeMs: 2 });
    const v2 = unwrap(cache.get("/templates/versioned.html"));
    fs.write({ source: "v3", mtimeMs: 3 });
    const v3 = unwrap(cache.get("/templates/versioned.html"));

    expect([v1.render(), v2.render(), v3.render()]).toEqual(["v1", "v2", "v3"]);
    expect(v1).not.toBe(v2);
    expect(v2).not.toBe(v3);
  });
});

describe("createTemplateCache: production immutability", () => {
  it("caches after the first compile and never re-reads the file again, even after it changes on disk", () => {
    const fs = fakeFileSystem({ source: "Hello, {{name}}!", mtimeMs: 1 });
    const cache = createTemplateCache({
      nodeEnv: "production",
      readTemplateFile: fs.readTemplateFile,
    });

    const first = unwrap(cache.get("/templates/greeting.html"));
    expect(fs.readTemplateFile).toHaveBeenCalledTimes(1);

    // Simulate the file changing on disk after the process has already compiled it.
    fs.write({ source: "Goodbye, {{name}}.", mtimeMs: 2 });

    const second = unwrap(cache.get("/templates/greeting.html"));
    const third = unwrap(cache.get("/templates/greeting.html"));

    // Never recompiled: same instance, original rendered output, and no further reads at all.
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(second.render({ name: "Ada" })).toBe("Hello, Ada!");
    expect(fs.readTemplateFile).toHaveBeenCalledTimes(1);
  });

  it("dev mode picks up a change that production, given the exact same file mutation, ignores", () => {
    // Same scenario driven through both modes side by side, so the dev-vs-prod contrast in
    // feature #53's step 2 is asserted directly rather than inferred from two separate tests.
    const devFs = fakeFileSystem({ source: "A", mtimeMs: 1 });
    const prodFs = fakeFileSystem({ source: "A", mtimeMs: 1 });
    const devCache = createTemplateCache({
      nodeEnv: "development",
      readTemplateFile: devFs.readTemplateFile,
    });
    const prodCache = createTemplateCache({
      nodeEnv: "production",
      readTemplateFile: prodFs.readTemplateFile,
    });

    unwrap(devCache.get("/t.html"));
    unwrap(prodCache.get("/t.html"));

    devFs.write({ source: "B", mtimeMs: 2 });
    prodFs.write({ source: "B", mtimeMs: 2 });

    expect(unwrap(devCache.get("/t.html")).render()).toBe("B");
    expect(unwrap(prodCache.get("/t.html")).render()).toBe("A");
  });
});

import { describe, expect, it } from "vitest";
import { PluginLoadError } from "../../src/core/errors.js";
import {
  buildDependencyGraph,
  resolveLoadOrder,
  type DependencyIssue,
} from "../../src/core/graph.js";
import type { PluginManifest } from "../../src/core/manifest.js";
import { isErr, isOk } from "../../src/core/types.js";

/** Build a minimal, schema-shaped manifest fixture without going through validateManifest(). */
function manifest(
  id: string,
  version: string,
  dependsOn: Record<string, string> = {},
): PluginManifest {
  return {
    id,
    version,
    depends_on: dependsOn,
    capabilities: { provides: [], requires: [] },
    entry_point: "index.ts",
  };
}

/** Unwrap an Ok result or fail the test with a readable message. */
function expectOk<T>(result: { ok: boolean; value?: T; error?: PluginLoadError }): T {
  if (!isOk(result as never)) {
    expect.fail(`expected Ok, got Err: ${(result.error as PluginLoadError | undefined)?.message}`);
  }
  return (result as { ok: true; value: T }).value;
}

/** Unwrap an Err result or fail the test with a readable message. */
function expectErr(result: {
  ok: boolean;
  value?: unknown;
  error?: PluginLoadError;
}): PluginLoadError {
  if (!isErr(result as never)) {
    expect.fail("expected Err, got Ok");
  }
  return (result as { ok: false; error: PluginLoadError }).error;
}

describe("buildDependencyGraph", () => {
  it("indexes manifests by id, preserving version and depends_on", () => {
    const graph = buildDependencyGraph([
      manifest("a", "1.0.0"),
      manifest("b", "2.0.0", { a: "^1.0.0" }),
    ]);

    expect(graph.nodes.size).toBe(2);
    expect(graph.nodes.get("a")).toEqual({ id: "a", version: "1.0.0", dependsOn: {} });
    expect(graph.nodes.get("b")).toEqual({
      id: "b",
      version: "2.0.0",
      dependsOn: { a: "^1.0.0" },
    });
  });

  it("keeps the first manifest's slot when ids collide (duplicate detection is resolveLoadOrder's job)", () => {
    const graph = buildDependencyGraph([manifest("a", "1.0.0"), manifest("a", "2.0.0")]);

    expect(graph.nodes.size).toBe(1);
    expect(graph.nodes.get("a")?.version).toBe("1.0.0");
  });

  it("returns an empty graph for an empty manifest set", () => {
    expect(buildDependencyGraph([]).nodes.size).toBe(0);
  });
});

describe("resolveLoadOrder — linear chain", () => {
  it("orders a <- b <- c so every dependency precedes its dependent", () => {
    // c depends on b, b depends on a: a has no dependencies, c depends transitively on a.
    const result = resolveLoadOrder([
      manifest("c", "1.0.0", { b: "^1.0.0" }),
      manifest("a", "1.0.0"),
      manifest("b", "1.0.0", { a: "^1.0.0" }),
    ]);

    expect(expectOk(result)).toEqual(["a", "b", "c"]);
  });

  it("produces the same order regardless of input array order", () => {
    const nodes = [
      manifest("a", "1.0.0"),
      manifest("b", "1.0.0", { a: "^1.0.0" }),
      manifest("c", "1.0.0", { b: "^1.0.0" }),
    ];

    const forward = expectOk(resolveLoadOrder(nodes));
    const shuffled = expectOk(resolveLoadOrder([...nodes].reverse()));

    expect(shuffled).toEqual(forward);
    expect(forward).toEqual(["a", "b", "c"]);
  });
});

describe("resolveLoadOrder — diamond dependency", () => {
  it("orders a diamond (d depends on b and c, both depend on a) with a first and d last", () => {
    const result = resolveLoadOrder([
      manifest("d", "1.0.0", { b: "^1.0.0", c: "^1.0.0" }),
      manifest("b", "1.0.0", { a: "^1.0.0" }),
      manifest("c", "1.0.0", { a: "^1.0.0" }),
      manifest("a", "1.0.0"),
    ]);

    const order = expectOk(result);
    expect(order).toEqual(["a", "b", "c", "d"]);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
  });

  it("is deterministic across independent plugins with no relationship (lexicographic tie-break)", () => {
    const result = resolveLoadOrder([manifest("zebra", "1.0.0"), manifest("apple", "1.0.0")]);

    expect(expectOk(result)).toEqual(["apple", "zebra"]);
  });
});

describe("resolveLoadOrder — missing dependency", () => {
  it("rejects a depends_on entry naming a plugin id that was not discovered", () => {
    const result = resolveLoadOrder([manifest("wiki", "1.0.0", { rbac: "^1.0.0" })]);

    const loadError = expectErr(result);
    expect(loadError).toBeInstanceOf(PluginLoadError);
    expect(loadError.code).toBe("PLUGIN_LOAD_ERROR");
    expect(loadError.message).toContain("wiki");
    expect(loadError.message).toContain("rbac");

    const issues = loadError.details?.["issues"] as DependencyIssue[];
    expect(issues).toEqual([
      expect.objectContaining({
        reason: "missing_dependency",
        pluginId: "wiki",
        dependencyId: "rbac",
        range: "^1.0.0",
      }),
    ]);
  });

  it("collects every missing dependency, not just the first", () => {
    const result = resolveLoadOrder([
      manifest("wiki", "1.0.0", { rbac: "^1.0.0", "database-mysql": "^2.0.0" }),
    ]);

    const loadError = expectErr(result);
    const issues = loadError.details?.["issues"] as DependencyIssue[];
    expect(issues.map((issue) => issue.dependencyId).sort()).toEqual(["database-mysql", "rbac"]);
    expect(issues.every((issue) => issue.reason === "missing_dependency")).toBe(true);
  });
});

describe("resolveLoadOrder — version range mismatch", () => {
  it("rejects a depends_on range the discovered dependency's version does not satisfy", () => {
    const result = resolveLoadOrder([
      manifest("wiki", "1.0.0", { rbac: "^2.0.0" }),
      manifest("rbac", "1.4.0"),
    ]);

    const loadError = expectErr(result);
    expect(loadError.message).toContain("wiki");
    expect(loadError.message).toContain("rbac");
    expect(loadError.message).toContain("^2.0.0");
    expect(loadError.message).toContain("1.4.0");

    const issues = loadError.details?.["issues"] as DependencyIssue[];
    expect(issues).toEqual([
      expect.objectContaining({
        reason: "version_range_mismatch",
        pluginId: "wiki",
        dependencyId: "rbac",
        range: "^2.0.0",
        installedVersion: "1.4.0",
      }),
    ]);
  });

  it("accepts a range the discovered dependency's version satisfies", () => {
    const result = resolveLoadOrder([
      manifest("wiki", "1.0.0", { rbac: "^1.2.0" }),
      manifest("rbac", "1.4.0"),
    ]);

    expect(expectOk(result)).toEqual(["rbac", "wiki"]);
  });
});

describe("resolveLoadOrder — duplicate plugin id", () => {
  it("rejects two discovered manifests declaring the same id", () => {
    const result = resolveLoadOrder([manifest("rbac", "1.0.0"), manifest("rbac", "1.1.0")]);

    const loadError = expectErr(result);
    expect(loadError.message).toContain("rbac");
    const issues = loadError.details?.["issues"] as DependencyIssue[];
    expect(issues).toEqual([
      expect.objectContaining({ reason: "duplicate_plugin_id", pluginId: "rbac" }),
    ]);
  });
});

describe("resolveLoadOrder — circular dependency", () => {
  it("detects and rejects a 3-node cycle (a -> b -> c -> a) with a clear error naming it", () => {
    const result = resolveLoadOrder([
      manifest("a", "1.0.0", { b: "^1.0.0" }),
      manifest("b", "1.0.0", { c: "^1.0.0" }),
      manifest("c", "1.0.0", { a: "^1.0.0" }),
    ]);

    const loadError = expectErr(result);
    expect(loadError).toBeInstanceOf(PluginLoadError);
    expect(loadError.code).toBe("PLUGIN_LOAD_ERROR");
    expect(loadError.message).toContain("Circular dependency");
    expect(loadError.message).toContain("a -> b -> c -> a");

    const cycle = loadError.details?.["cycle"] as string[];
    expect(cycle).toEqual(["a", "b", "c", "a"]);
  });

  it("names the cycle the same way regardless of which node is listed first in the input", () => {
    const nodes = [
      manifest("a", "1.0.0", { b: "^1.0.0" }),
      manifest("b", "1.0.0", { c: "^1.0.0" }),
      manifest("c", "1.0.0", { a: "^1.0.0" }),
    ];

    const first = expectErr(resolveLoadOrder(nodes));
    const rotated = expectErr(resolveLoadOrder([nodes[2]!, nodes[0]!, nodes[1]!]));

    expect(rotated.details?.["cycle"]).toEqual(first.details?.["cycle"]);
  });

  it("detects a direct self-dependency (a -> a) as a one-node cycle", () => {
    const result = resolveLoadOrder([manifest("a", "1.0.0", { a: "^1.0.0" })]);

    const loadError = expectErr(result);
    expect(loadError.message).toContain("a -> a");
    expect(loadError.details?.["cycle"]).toEqual(["a", "a"]);
  });

  it("still finds the cycle when unrelated acyclic plugins are also present in the graph", () => {
    const result = resolveLoadOrder([
      manifest("standalone", "1.0.0"),
      manifest("a", "1.0.0", { b: "^1.0.0" }),
      manifest("b", "1.0.0", { c: "^1.0.0" }),
      manifest("c", "1.0.0", { a: "^1.0.0" }),
      manifest("leaf", "1.0.0", { standalone: "^1.0.0" }),
    ]);

    const loadError = expectErr(result);
    expect(loadError.details?.["cycle"]).toEqual(["a", "b", "c", "a"]);
  });
});

describe("resolveLoadOrder — security review regressions", () => {
  it("security regression: a long but valid (acyclic) dependency chain does not crash resolveLoadOrder with a stack overflow", () => {
    const depth = 20_000;
    const manifests: PluginManifest[] = [];
    for (let i = 0; i < depth; i += 1) {
      const dependsOn = i + 1 < depth ? { [`p${i + 1}`]: "^1.0.0" } : {};
      manifests.push(manifest(`p${i}`, "1.0.0", dependsOn));
    }

    // The old recursive findCycle() blew the call stack well under this
    // depth (observed break point ~5,000 on the machine/Node version this
    // was found on) even though the chain is perfectly valid and acyclic —
    // resolveLoadOrder() is documented to never throw.
    expect(() => resolveLoadOrder(manifests)).not.toThrow();

    const order = expectOk(resolveLoadOrder(manifests));
    expect(order[0]).toBe(`p${depth - 1}`); // leaf (no deps) loads first
    expect(order[order.length - 1]).toBe("p0"); // root loads last
    expect(order).toHaveLength(depth);
  });

  it("security regression: a wide dependency graph (many plugins sharing one common dependency) resolves in near-linear, not quadratic, time", () => {
    const width = 20_000;
    const manifests: PluginManifest[] = [manifest("root", "1.0.0")];
    for (let i = 0; i < width; i += 1) {
      manifests.push(manifest(`dependent-${i}`, "1.0.0", { root: "^1.0.0" }));
    }

    const start = performance.now();
    const order = expectOk(resolveLoadOrder(manifests));
    const elapsedMs = performance.now() - start;

    expect(order).toHaveLength(width + 1);
    expect(order[0]).toBe("root");
    // The pre-fix O(n^2) ready-queue scan took well over a second at this
    // width (~1.3s measured during the security review); the binary-search
    // insertion fix should comfortably finish in well under this bound.
    // Generous on purpose to avoid flaking on a slow CI machine while still
    // clearly catching a regression back to the linear-scan behavior.
    expect(elapsedMs).toBeLessThan(800);
  });
});

describe("resolveLoadOrder — empty graph", () => {
  it("returns an empty load order for no manifests", () => {
    expect(expectOk(resolveLoadOrder([]))).toEqual([]);
  });
});

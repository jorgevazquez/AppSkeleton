import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isErr, isOk } from "../../../src/core/types.js";
// Feature #80 step 1: import *only* the programmatic generator module —
// never `./cli.js` — so this suite can never accidentally exercise the CLI
// wrapper (feature #76) instead of the generator itself.
import {
  generatePlugin,
  type GeneratePluginOptions,
  type GeneratedPlugin,
} from "../../../src/plugins/plugin-builder/src/generate-plugin.js";

/**
 * Feature #80 — "Programmatic generator API (usable by another plugin or
 * an AI agent, not just the CLI)".
 *
 * `generatePlugin` (feature #75) already is the programmatic API: a plain
 * async function taking one typed options object (`GeneratePluginOptions`)
 * and returning a typed `Result`, with no dependency on `process.argv`,
 * `process.stdin`, or any other CLI-only mechanism. Feature #76's CLI
 * (`cli.ts`) is a separate, thin wrapper *over* this function, not a
 * prerequisite for calling it.
 *
 * This suite exists to prove that end to end, from the point of view of
 * two callers named directly in the feature: another plugin's code
 * importing the generator as a library call, and an AI coding agent
 * driving it non-interactively with a fully-formed options object it
 * assembled itself (no prompts, no flags, no subprocess).
 */

let tmpBaseDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpBaseDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpBaseDirs = [];
});

function freshRoots(): { pluginsRoot: string; testsRoot: string } {
  const base = mkdtempSync(join(tmpdir(), "appskeleton-programmatic-api-"));
  tmpBaseDirs.push(base);
  return {
    pluginsRoot: join(base, "src-plugins"),
    testsRoot: join(base, "tests-plugins"),
  };
}

describe("generatePlugin — programmatic API, invoked directly (no CLI involved)", () => {
  it("is a plain function callable with a single typed options object — no argv/env/stdin required", async () => {
    const roots = freshRoots();

    // An "AI agent" (or another plugin's code) assembles this object
    // itself — no command-line parsing, no interactive prompt, nothing
    // read from process.argv or process.stdin.
    const options: GeneratePluginOptions = {
      id: "agent-authored-plugin",
      description: "Scaffolded programmatically by an AI agent, bypassing the CLI entirely.",
      capabilities: { provides: ["agent-authored:widget"], requires: ["db:query"] },
      pluginsRoot: roots.pluginsRoot,
      testsRoot: roots.testsRoot,
    };

    // Spy on stdout/stderr and stdin to positively demonstrate that calling
    // the generator touches none of them — the CLI (cli.ts) is the only
    // layer that ever writes output or reads input; the generator itself
    // does not, which is what makes it independent of any CLI/stdin
    // interaction (feature #80 step 1).
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdinSpy = vi.spyOn(process.stdin, "on");

    let result: Awaited<ReturnType<typeof generatePlugin>>;
    try {
      result = await generatePlugin(options);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      stdinSpy.mockRestore();
    }

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(stdinSpy).not.toHaveBeenCalled();

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      return;
    }

    const generated: GeneratedPlugin = result.value;
    expect(generated.id).toBe("agent-authored-plugin");
    expect(generated.manifest.capabilities).toEqual({
      provides: ["agent-authored:widget"],
      requires: ["db:query"],
    });
    expect(generated.pluginDir).toBe(join(roots.pluginsRoot, "agent-authored-plugin"));
    expect(generated.testDir).toBe(join(roots.testsRoot, "agent-authored-plugin"));

    // Every file the result claims to have written is really on disk, with
    // exactly the contents reported back — a caller (another plugin, or an
    // agent) can trust the returned value without re-reading the
    // filesystem itself.
    for (const file of generated.files) {
      expect(existsSync(file.path)).toBe(true);
      expect(readFileSync(file.path, "utf-8")).toBe(file.contents);
    }
  });

  it("returns a typed Err (never throws, never exits the process) for invalid options an agent might pass", async () => {
    const roots = freshRoots();

    const result = await generatePlugin({
      id: "NOT-a-valid-id",
      description: "irrelevant",
      pluginsRoot: roots.pluginsRoot,
      testsRoot: roots.testsRoot,
    });

    // No `process.exit`, no thrown exception reaching the caller — just a
    // typed Result an embedding plugin/agent can branch on programmatically.
    expect(isErr(result)).toBe(true);
    expect(existsSync(join(roots.pluginsRoot, "NOT-a-valid-id"))).toBe(false);
  });

  it("can be called back-to-back for several plugins in one in-process loop, as a batch-generating agent would", async () => {
    const roots = freshRoots();

    const requests: GeneratePluginOptions[] = [
      { id: "batch-one", description: "First plugin in an agent-driven batch." },
      { id: "batch-two", description: "Second plugin in the same batch." },
    ].map((request) => ({
      ...request,
      pluginsRoot: roots.pluginsRoot,
      testsRoot: roots.testsRoot,
    }));

    const results = [];
    for (const request of requests) {
      results.push(await generatePlugin(request));
    }

    expect(results.every(isOk)).toBe(true);
    expect(existsSync(join(roots.pluginsRoot, "batch-one", "plugin.json"))).toBe(true);
    expect(existsSync(join(roots.pluginsRoot, "batch-two", "plugin.json"))).toBe(true);
  });
});

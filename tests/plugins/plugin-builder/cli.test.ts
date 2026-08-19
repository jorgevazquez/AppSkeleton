import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateManifest } from "../../../src/core/manifest.js";
import { scanPluginDirectories } from "../../../src/core/registry.js";
import { isOk } from "../../../src/core/types.js";
import {
  CREATE_COMMAND,
  parseCliArgs,
  resolveCreateOptions,
  runCreate,
  USAGE,
} from "../../../src/plugins/plugin-builder/src/cli.js";

/**
 * Feature #76 step 3: "Write a test invoking the CLI programmatically
 * (non-interactive flags) and asserting correct output." Every scenario
 * below drives {@link runCreate} — the exact function `main()` calls for a
 * real `npm run create-plugin` invocation — with fully non-interactive
 * flags (an unreachable `prompt` and `isTTY: false`, so any accidental
 * prompt in a "should be non-interactive" path fails loudly rather than
 * hanging), and asserts both the returned stdout/exit code *and* the real
 * files it wrote to an isolated temp directory (mirroring
 * generate-plugin.test.ts's own pattern).
 */

let tmpBaseDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpBaseDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpBaseDirs = [];
});

/** A fresh, isolated `{ pluginsRoot, testsRoot }` pair, cleaned up after the test — never the real repo tree. */
function freshRoots(): { pluginsRoot: string; testsRoot: string } {
  const base = mkdtempSync(join(tmpdir(), "appskeleton-create-plugin-cli-"));
  tmpBaseDirs.push(base);
  return {
    pluginsRoot: join(base, "src-plugins"),
    testsRoot: join(base, "tests-plugins"),
  };
}

/** A `prompt` that fails the test immediately if ever called — every scenario here is meant to be fully non-interactive. */
const unreachablePrompt = async (question: string): Promise<string> => {
  throw new Error(`prompt() should not have been called (question: "${question}")`);
};

describe("parseCliArgs", () => {
  it("parses the create command with repeated and comma-separated capability flags", () => {
    const args = parseCliArgs([
      "create",
      "--id",
      "widget-x",
      "--description",
      "Does widget things.",
      "--provides",
      "widget:render,widget:refresh",
      "--requires",
      "db:query",
      "--requires",
      "rbac:check",
    ]);

    expect(args.command).toBe(CREATE_COMMAND);
    expect(args.id).toBe("widget-x");
    expect(args.description).toBe("Does widget things.");
    expect(args.provides).toEqual(["widget:render", "widget:refresh"]);
    expect(args.requires).toEqual(["db:query", "rbac:check"]);
    expect(args.help).toBe(false);
  });

  it("throws a usage error for an unrecognized flag", () => {
    expect(() => parseCliArgs(["create", "--nonsense", "value"])).toThrow();
  });
});

describe("resolveCreateOptions", () => {
  it("defaults capabilities to empty arrays when neither flag is given, without prompting", async () => {
    const args = parseCliArgs(["create", "--id", "no-caps", "--description", "irrelevant"]);
    const options = await resolveCreateOptions(args, { isTTY: false, prompt: unreachablePrompt });
    expect(options).toEqual({
      id: "no-caps",
      description: "irrelevant",
      capabilities: { provides: [], requires: [] },
      pluginsRoot: undefined,
      testsRoot: undefined,
    });
  });

  it("rejects a missing --id/--description when stdin is not a TTY, instead of hanging on a prompt", async () => {
    const args = parseCliArgs(["create", "--description", "irrelevant"]);
    await expect(
      resolveCreateOptions(args, { isTTY: false, prompt: unreachablePrompt }),
    ).rejects.toThrow(/missing required --id/);
  });
});

describe("runCreate — non-interactive flags end to end", () => {
  it("scaffolds a valid plugin and reports it on stdout, exit code 0", async () => {
    const roots = freshRoots();

    const result = await runCreate(
      [
        "create",
        "--id",
        "cli-widget",
        "--description",
        "Scaffolded via the create-plugin CLI test.",
        "--provides",
        "cli-widget:render",
        "--requires",
        "rbac:check",
        "--plugins-root",
        roots.pluginsRoot,
        "--tests-root",
        roots.testsRoot,
      ],
      { isTTY: false, prompt: unreachablePrompt },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('Created plugin "cli-widget"');
    expect(result.stdout).toContain(join(roots.pluginsRoot, "cli-widget", "plugin.json"));
    expect(result.stdout).toContain("provides: cli-widget:render");
    expect(result.stdout).toContain("requires: rbac:check");

    // The files this CLI invocation claims to have written are real, and the manifest it
    // produced is discoverable and passes the kernel's own validator — same real-machinery
    // assertions generate-plugin.test.ts makes of generatePlugin() directly.
    const { entries } = await scanPluginDirectories(roots.pluginsRoot);
    const entry = entries.find((candidate) => candidate.name === "cli-widget");
    expect(entry).toBeDefined();
    const validated = validateManifest(entry?.manifest);
    expect(isOk(validated)).toBe(true);
    if (isOk(validated)) {
      expect(validated.value.capabilities).toEqual({
        provides: ["cli-widget:render"],
        requires: ["rbac:check"],
      });
    }

    expect(existsSync(join(roots.testsRoot, "cli-widget", "manifest.test.ts"))).toBe(true);
    const readme = readFileSync(join(roots.pluginsRoot, "cli-widget", "README.md"), "utf-8");
    expect(readme).toContain("Scaffolded via the create-plugin CLI test.");
  });

  it("reports an invalid capability id as a clean non-zero exit, without writing anything", async () => {
    const roots = freshRoots();

    const result = await runCreate(
      [
        "create",
        "--id",
        "bad-capability",
        "--description",
        "irrelevant",
        "--provides",
        "NOT-VALID",
        "--plugins-root",
        roots.pluginsRoot,
        "--tests-root",
        roots.testsRoot,
      ],
      { isTTY: false, prompt: unreachablePrompt },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/capabilities\.provides/);
    expect(existsSync(join(roots.pluginsRoot, "bad-capability"))).toBe(false);
  });

  it("rejects an unknown subcommand with usage help and exit code 1", async () => {
    const result = await runCreate(["destroy", "--id", "whatever"], {
      isTTY: false,
      prompt: unreachablePrompt,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`expected the "${CREATE_COMMAND}" command`);
    expect(result.stderr).toContain(USAGE);
  });

  it("rejects missing --id/--description outright when stdin is not a TTY", async () => {
    const roots = freshRoots();

    const result = await runCreate(
      ["create", "--plugins-root", roots.pluginsRoot, "--tests-root", roots.testsRoot],
      { isTTY: false, prompt: unreachablePrompt },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing required --id and --description");
  });

  it("prints usage and exits 0 for --help, without generating anything", async () => {
    const result = await runCreate(["create", "--help"], {
      isTTY: false,
      prompt: unreachablePrompt,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(USAGE);
    expect(result.stderr).toBe("");
  });
});

describe("runCreate — interactive prompt fills in only what flags omitted", () => {
  it("prompts for id, description, and capabilities when none are given as flags", async () => {
    const roots = freshRoots();
    const answers = [
      "prompted-widget", // id
      "Described entirely via prompts.", // description
      "prompted-widget:render, prompted-widget:refresh", // provides
      "rbac:check", // requires
    ];
    let call = 0;
    const scriptedPrompt = async (): Promise<string> => {
      const answer = answers[call];
      call += 1;
      if (answer === undefined) {
        throw new Error("prompt() called more times than expected");
      }
      return answer;
    };

    const result = await runCreate(
      ["create", "--plugins-root", roots.pluginsRoot, "--tests-root", roots.testsRoot],
      { isTTY: true, prompt: scriptedPrompt },
    );

    expect(result.exitCode).toBe(0);
    expect(call).toBe(4);
    expect(result.stdout).toContain('Created plugin "prompted-widget"');

    const { entries } = await scanPluginDirectories(roots.pluginsRoot);
    const entry = entries.find((candidate) => candidate.name === "prompted-widget");
    const validated = validateManifest(entry?.manifest);
    expect(isOk(validated)).toBe(true);
    if (isOk(validated)) {
      expect(validated.value.capabilities).toEqual({
        provides: ["prompted-widget:render", "prompted-widget:refresh"],
        requires: ["rbac:check"],
      });
    }
  });

  it("does not prompt for capabilities when a capability flag was already given", async () => {
    const roots = freshRoots();
    const answers = ["flagged-widget", "Only id/description prompted for."];
    let call = 0;
    const scriptedPrompt = async (): Promise<string> => {
      const answer = answers[call];
      call += 1;
      if (answer === undefined) {
        throw new Error("prompt() called more times than expected");
      }
      return answer;
    };

    const result = await runCreate(
      [
        "create",
        "--requires",
        "rbac:check",
        "--plugins-root",
        roots.pluginsRoot,
        "--tests-root",
        roots.testsRoot,
      ],
      { isTTY: true, prompt: scriptedPrompt },
    );

    expect(result.exitCode).toBe(0);
    expect(call).toBe(2);

    const { entries } = await scanPluginDirectories(roots.pluginsRoot);
    const entry = entries.find((candidate) => candidate.name === "flagged-widget");
    const validated = validateManifest(entry?.manifest);
    expect(isOk(validated)).toBe(true);
    if (isOk(validated)) {
      expect(validated.value.capabilities).toEqual({ provides: [], requires: ["rbac:check"] });
    }
  });
});

#!/usr/bin/env -S npx tsx
/**
 * CLI entry point for `npm run create-plugin` (feature #76 — "CLI entry
 * point wiring `npm run create-plugin`"). A thin wrapper over
 * {@link generatePlugin} (feature #75's programmatic generator — see
 * generate-plugin.ts's docs, which already anticipates this module) — this
 * file owns exactly one concern: turning either command-line flags or an
 * interactive prompt session into the `GeneratePluginOptions` that function
 * already accepts, then formatting its `Result` as CLI-appropriate
 * stdout/stderr and an exit code. It contains no scaffolding logic of its
 * own.
 *
 * Usage (see package.json's `create-plugin` script, which pins the
 * `create` subcommand — everything after `--` in `npm run create-plugin --
 * ...` becomes this script's own argv):
 *
 *   npm run create-plugin -- --id my-plugin --description "What it does" \
 *     [--provides db:query] [--requires rbac:check] \
 *     [--plugins-root <dir>] [--tests-root <dir>]
 *
 * `--provides`/`--requires` may repeat, and/or each be a comma-separated
 * list — `--provides a,b` and `--provides a --provides b` are equivalent.
 * `--plugins-root`/`--tests-root` default to this repo's real
 * `src/plugins`/`tests/plugins` (`generate-plugin.ts`'s
 * `DEFAULT_PLUGINS_ROOT`/`DEFAULT_TESTS_ROOT`) and exist mainly so this CLI
 * can be exercised end-to-end in tests without touching the real tree —
 * see `cli.test.ts`.
 *
 * Non-interactive vs. interactive: if both `--id` and `--description` are
 * given on the command line, no prompt ever runs — this is exactly what
 * feature #76 step 3's "invoking the CLI programmatically (non-interactive
 * flags)" test exercises, via {@link runCreate} directly rather than a real
 * subprocess. If either is missing and stdin is a TTY, the missing
 * field(s) (and, if neither capability flag was given either, the
 * capabilities) are prompted for with `node:readline/promises`. If either
 * is missing and stdin is *not* a TTY (piped input, redirected from
 * `/dev/null`, or the non-interactive case a test harness/CI run is
 * always in), this refuses to hang reading a stream nothing will ever
 * write to, and instead fails fast with a usage error.
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { CAPABILITY_DESCRIPTION, PLUGIN_ID_DESCRIPTION } from "../../../core/manifest.js";
import { isErr } from "../../../core/types.js";
import {
  generatePlugin,
  type GeneratedPlugin,
  type GeneratePluginOptions,
} from "./generate-plugin.js";

/** The one subcommand this CLI currently supports — matches package.json's `create-plugin` script. */
export const CREATE_COMMAND = "create";

export const USAGE = `Usage: create-plugin ${CREATE_COMMAND} --id <id> --description <text> [options]

Scaffold a new plugin directory (feature #75's generator) from the command line.

Required (prompted for interactively if omitted and stdin is a TTY):
  --id <id>              Plugin id, ${PLUGIN_ID_DESCRIPTION}.
  --description <text>   One-line description of what the plugin does.

Optional:
  --provides <cap>       Capability id this plugin will implement. May repeat,
                          or be a comma-separated list. Grammar: ${CAPABILITY_DESCRIPTION}.
  --requires <cap>       Capability id this plugin will obtain from the broker.
                          Same repeat/comma-separated rules as --provides.
  --plugins-root <dir>   Override where <id>/ is created for the plugin's own
                          files. Default: this repo's src/plugins.
  --tests-root <dir>     Override where <id>/ is created for the plugin's test
                          file. Default: this repo's tests/plugins.
  -h, --help             Print this message and exit.
`;

/** Thrown for a malformed/incomplete command line — the message is already user-facing (no stack trace printed for it). */
export class CliUsageError extends Error {}

/** Parsed, not-yet-validated command-line input. `undefined` fields mean "not given on the command line". */
export interface ParsedCliArgs {
  command?: string;
  id?: string;
  description?: string;
  provides: string[];
  requires: string[];
  pluginsRoot?: string;
  testsRoot?: string;
  help: boolean;
}

/**
 * Split one or more `--provides`/`--requires` values on commas, trimming
 * and dropping empties — so `--provides "db:query, http:route"` and
 * `--provides db:query --provides http:route` both produce
 * `["db:query", "http:route"]`.
 */
function splitCapabilityList(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Parse `argv` (already stripped of the node binary and script path — i.e.
 * `process.argv.slice(2)`) into {@link ParsedCliArgs}. Throws
 * {@link CliUsageError} for anything `node:util`'s `parseArgs` itself
 * rejects (an unrecognized flag, an option missing its required value,
 * ...) — `parseArgs` runs in its default `strict: true` mode precisely so
 * a typo'd flag fails loudly instead of being silently ignored.
 */
/**
 * Does the actual `parseArgs` call, kept as its own function (rather than
 * inlined in {@link parseCliArgs}'s `try` block) purely so the options
 * object is passed directly as a call-site literal — that's what makes
 * `node:util`'s generic overload infer each option's exact `type`/
 * `multiple` shape (so `parsed.values.provides` below is `string[] |
 * undefined`, not the widened `string | boolean | (string | boolean)[]`
 * every option's *union* would otherwise produce) without needing an
 * `as const` that then fights `ParseArgsOptionsConfig`'s own (mutable)
 * array element type for `default`.
 */
function parseWithConfig(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      id: { type: "string" },
      description: { type: "string" },
      provides: { type: "string", multiple: true },
      requires: { type: "string", multiple: true },
      "plugins-root": { type: "string" },
      "tests-root": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let parsed: ReturnType<typeof parseWithConfig>;
  try {
    parsed = parseWithConfig(argv);
  } catch (cause) {
    throw new CliUsageError(cause instanceof Error ? cause.message : String(cause));
  }

  const result: ParsedCliArgs = {
    provides: splitCapabilityList(parsed.values.provides ?? []),
    requires: splitCapabilityList(parsed.values.requires ?? []),
    help: parsed.values.help,
  };
  const command = parsed.positionals[0];
  if (command !== undefined) {
    result.command = command;
  }
  if (parsed.values.id !== undefined) {
    result.id = parsed.values.id;
  }
  if (parsed.values.description !== undefined) {
    result.description = parsed.values.description;
  }
  if (parsed.values["plugins-root"] !== undefined) {
    result.pluginsRoot = parsed.values["plugins-root"];
  }
  if (parsed.values["tests-root"] !== undefined) {
    result.testsRoot = parsed.values["tests-root"];
  }
  return result;
}

/** Ask one question and return the trimmed answer — injected so tests never touch real stdin/stdout. */
export type PromptFn = (question: string) => Promise<string>;

/** Real interactive prompt, backed by `node:readline/promises` over the process's actual stdin/stdout. */
const realPrompt: PromptFn = async (question) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
};

export interface ResolveCreateOptionsDeps {
  /** Whether stdin is an interactive terminal — prompting only ever happens when this is `true`. */
  isTTY: boolean;
  prompt: PromptFn;
}

/**
 * Turn {@link ParsedCliArgs} into a full {@link GeneratePluginOptions},
 * prompting for whatever required field(s) (and, if given neither
 * capability flag, the capabilities) are missing — but only when
 * `deps.isTTY` is `true`. Throws {@link CliUsageError} if a required field
 * is still missing once this returns (either because stdin isn't a TTY, or
 * — belt and suspenders — a prompt answer came back empty).
 */
export async function resolveCreateOptions(
  args: ParsedCliArgs,
  deps: ResolveCreateOptionsDeps,
): Promise<GeneratePluginOptions> {
  let id = args.id?.trim();
  let description = args.description?.trim();
  let provides = args.provides;
  let requires = args.requires;

  if (!id || !description) {
    if (!deps.isTTY) {
      const missing = [!id ? "--id" : null, !description ? "--description" : null]
        .filter((flag): flag is string => flag !== null)
        .join(" and ");
      throw new CliUsageError(
        `create-plugin: missing required ${missing} (stdin is not interactive — pass it as a flag).`,
      );
    }
    if (!id) {
      id = (await deps.prompt(`Plugin id (${PLUGIN_ID_DESCRIPTION}): `)).trim();
    }
    if (!description) {
      description = (await deps.prompt("Description: ")).trim();
    }
    if (provides.length === 0 && requires.length === 0) {
      const providesAnswer = await deps.prompt(
        "Capabilities this plugin provides (comma-separated, blank for none): ",
      );
      provides = splitCapabilityList([providesAnswer]);
      const requiresAnswer = await deps.prompt(
        "Capabilities this plugin requires (comma-separated, blank for none): ",
      );
      requires = splitCapabilityList([requiresAnswer]);
    }
  }

  if (!id) {
    throw new CliUsageError("create-plugin: --id is required.");
  }
  if (!description) {
    throw new CliUsageError("create-plugin: --description is required.");
  }

  const options: GeneratePluginOptions = {
    id,
    description,
    capabilities: { provides, requires },
  };
  if (args.pluginsRoot !== undefined) {
    options.pluginsRoot = args.pluginsRoot;
  }
  if (args.testsRoot !== undefined) {
    options.testsRoot = args.testsRoot;
  }
  return options;
}

function formatCapabilityList(capabilities: string[]): string {
  return capabilities.length > 0 ? capabilities.join(", ") : "(none)";
}

/** Human-readable summary of a successful `generatePlugin()` call, printed to stdout. */
export function formatSuccess(generated: GeneratedPlugin): string {
  const lines = [`Created plugin "${generated.id}":`];
  for (const file of generated.files) {
    lines.push(`  ${file.path}`);
  }
  lines.push("");
  lines.push(`  provides: ${formatCapabilityList(generated.manifest.capabilities.provides)}`);
  lines.push(`  requires: ${formatCapabilityList(generated.manifest.capabilities.requires)}`);
  lines.push("");
  lines.push(
    "Next: implement index.ts's `provides` entries for each declared capability, then run `npm test`.",
  );
  return `${lines.join("\n")}\n`;
}

/** Everything {@link runCreate} needs from the outside world — all overridable so tests never touch real stdin or the real plugin tree. */
export interface RunCreateDeps {
  /** Default: `Boolean(process.stdin.isTTY)`. */
  isTTY?: boolean;
  /** Default: a real `node:readline/promises` prompt over process stdin/stdout. */
  prompt?: PromptFn;
}

/** What running the CLI produced — never throws; every failure mode (usage error, generator error) comes back as a non-zero `exitCode` plus a message on `stderr`. */
export interface RunCreateResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Programmatic entry point for the `create-plugin` CLI — everything
 * `main()` below does, minus touching real `process.std{out,err}`/`exit`.
 * This is what feature #76 step 3's test calls directly with fully
 * non-interactive flags, and what `main()` calls for the real `npm run
 * create-plugin` invocation.
 */
export async function runCreate(
  argv: string[],
  deps: RunCreateDeps = {},
): Promise<RunCreateResult> {
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const prompt = deps.prompt ?? realPrompt;

  let args: ParsedCliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { exitCode: 1, stdout: "", stderr: `${message}\n\n${USAGE}` };
  }

  if (args.help) {
    return { exitCode: 0, stdout: USAGE, stderr: "" };
  }

  if (args.command !== CREATE_COMMAND) {
    const got = args.command ? `"${args.command}"` : "no command";
    return {
      exitCode: 1,
      stdout: "",
      stderr: `create-plugin: expected the "${CREATE_COMMAND}" command, got ${got}.\n\n${USAGE}`,
    };
  }

  let options: GeneratePluginOptions;
  try {
    options = await resolveCreateOptions(args, { isTTY, prompt });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { exitCode: 1, stdout: "", stderr: `${message}\n\n${USAGE}` };
  }

  const result = await generatePlugin(options);
  if (isErr(result)) {
    return { exitCode: 1, stdout: "", stderr: `${result.error.message}\n` };
  }

  return { exitCode: 0, stdout: formatSuccess(result.value), stderr: "" };
}

async function main(): Promise<void> {
  const result = await runCreate(process.argv.slice(2));
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((cause: unknown) => {
    console.error("Fatal error in create-plugin CLI:", cause);
    process.exitCode = 1;
  });
}

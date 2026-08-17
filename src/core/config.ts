/**
 * Layered configuration system for the kernel and its plugins.
 *
 * Config is resolved from three layers, lowest to highest precedence:
 *
 *   1. `defaults`         — safe, built-in fallback values.
 *   2. `env`               — `process.env` (or an injected map for tests).
 *   3. `overrideFilePath`  — an optional local JSON file an operator can
 *                            drop next to the deployment to force specific
 *                            values without touching code or the process
 *                            environment (e.g. `config.local.json`, kept
 *                            out of git the same way `.env` is).
 *
 * The merged object is validated with a zod schema the caller supplies —
 * per spec.md, "layered config ... validated per-plugin against a zod
 * schema the plugin exports". `loadConfig()` is that generic engine;
 * `CoreConfigSchema`/`loadCoreConfig()` below are the kernel's own
 * instance of it (port, log level, node env).
 *
 * A merged config that fails validation (missing required field, wrong
 * type, invalid enum value, ...) throws a {@link ConfigError} with a
 * clear, actionable message rather than booting with bad config or
 * leaking a raw ZodError — see spec.md's "fail fast, safe defaults
 * everywhere" baseline.
 */
import { existsSync, readFileSync } from "node:fs";
import { z, ZodError, type ZodObject, type ZodRawShape } from "zod";
import { ConfigError } from "./errors.js";

/** Zod schema for the kernel's own core config. */
export const CoreConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type CoreConfig = z.infer<typeof CoreConfigSchema>;

export interface LoadConfigOptions<Shape extends ZodRawShape> {
  /** The zod schema the fully-merged config must satisfy. */
  schema: ZodObject<Shape>;
  /** Lowest-precedence values. Any field may also come from env/override. */
  defaults?: Record<string, unknown>;
  /**
   * Environment map to read from. Only keys that appear in `schema`'s
   * shape are considered. Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Path to an optional operator override file (JSON object). Highest
   * precedence. It is not an error for the file to not exist — the
   * layer is simply skipped.
   */
  overrideFilePath?: string;
}

function readOverrideFile(filePath: string | undefined): Record<string, unknown> {
  if (!filePath || !existsSync(filePath)) {
    return {};
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (cause) {
    throw new ConfigError(
      `Failed to read config override file at "${filePath}": ${(cause as Error).message}`,
      {
        cause,
      },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(`Config override file at "${filePath}" is not valid JSON.`, { cause });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `Config override file at "${filePath}" must contain a JSON object at the top level.`,
    );
  }

  return parsed as Record<string, unknown>;
}

/** Pick `keys` out of `source`, dropping any that are `undefined`. */
function pickDefined(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      picked[key] = value;
    }
  }
  return picked;
}

/** Render a ZodError as a single, human-readable, actionable message. */
function formatZodError(error: ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    if (issue.code === "invalid_type" && issue.received === "undefined") {
      return `${path} is required but was not set (checked defaults, environment, and override file)`;
    }
    return `${path}: ${issue.message}`;
  });
  return `Invalid configuration: ${issues.join("; ")}`;
}

/**
 * Merge the three config layers and validate the result against `schema`.
 * Throws a {@link ConfigError} — never a raw ZodError — when the merged
 * config does not satisfy the schema.
 */
export function loadConfig<Shape extends ZodRawShape>(
  options: LoadConfigOptions<Shape>,
): z.infer<ZodObject<Shape>> {
  const { schema, defaults = {}, env = process.env, overrideFilePath } = options;
  const keys = Object.keys(schema.shape);

  const envLayer = pickDefined(env as Record<string, unknown>, keys);
  const overrideLayer = readOverrideFile(overrideFilePath);

  const merged: Record<string, unknown> = { ...defaults, ...envLayer, ...overrideLayer };

  const result = schema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(formatZodError(result.error), {
      details: { issues: result.error.issues },
      cause: result.error,
    });
  }

  return result.data;
}

/** Load and validate the kernel's own core config (NODE_ENV, PORT, LOG_LEVEL). */
export function loadCoreConfig(
  options: Omit<LoadConfigOptions<typeof CoreConfigSchema.shape>, "schema"> = {},
): CoreConfig {
  return loadConfig({ schema: CoreConfigSchema, ...options });
}

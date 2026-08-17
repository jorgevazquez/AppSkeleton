import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError } from "../../src/core/errors.js";
import {
  CoreConfigSchema,
  loadConfig,
  loadCoreConfig,
  type CoreConfig,
} from "../../src/core/config.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "appskeleton-config-"));
}

describe("loadConfig — missing required var", () => {
  it("fails fast with a ConfigError when a required field has no value in any layer", () => {
    const schema = z.object({ API_KEY: z.string().min(1) });

    expect(() => loadConfig({ schema, defaults: {}, env: {} })).toThrow(ConfigError);
  });

  it("error message clearly names the missing field and that all layers were checked", () => {
    const schema = z.object({ API_KEY: z.string().min(1) });

    try {
      loadConfig({ schema, defaults: {}, env: {} });
      expect.fail("expected loadConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.code).toBe("CONFIG_ERROR");
      expect(configError.message).toContain("API_KEY");
      expect(configError.message.toLowerCase()).toContain("required");
      expect(configError.message.toLowerCase()).toContain("defaults");
      expect(configError.message.toLowerCase()).toContain("environment");
      expect(configError.message.toLowerCase()).toContain("override file");
      // Public-facing message must not leak the internal detail.
      expect(configError.publicMessage).not.toContain("API_KEY");
    }
  });

  it("still fails when other required fields are satisfied but one is missing", () => {
    const schema = z.object({
      API_KEY: z.string().min(1),
      REGION: z.string().min(1),
    });

    expect(() => loadConfig({ schema, defaults: {}, env: { REGION: "us-east-1" } })).toThrow(
      ConfigError,
    );
  });
});

describe("loadConfig — security review regression: enum/literal rejection must not leak the raw value", () => {
  it("does not include the raw rejected value anywhere in details.issues when an enum-typed field fails validation", () => {
    const schema = z.object({
      SECRET_MODE: z.enum(["alpha", "beta", "gamma"]),
    });
    const leakedSecret = "sk-live-abc123-should-not-leak";

    try {
      loadConfig({ schema, defaults: {}, env: { SECRET_MODE: leakedSecret } });
      expect.fail("expected loadConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;

      // details is what AppError#toJSON() serializes unconditionally into
      // the public API error envelope (unlike stack, which is opt-in) — it
      // must never carry zod's raw `received`/`message` fields, which for
      // invalid_enum_value issues embed the actual offending value.
      const json = configError.toJSON();
      expect(JSON.stringify(json)).not.toContain(leakedSecret);
      expect(JSON.stringify(configError.details)).not.toContain(leakedSecret);
    }
  });

  it("details.issues only carries a safe {path, code} shape, never zod's raw issue object", () => {
    const schema = z.object({ SECRET_MODE: z.literal("expected-value") });

    try {
      loadConfig({ schema, defaults: {}, env: { SECRET_MODE: "sk-live-leaked-value" } });
      expect.fail("expected loadConfig to throw");
    } catch (error) {
      const configError = error as ConfigError;
      const issues = configError.details?.["issues"] as Record<string, unknown>[] | undefined;
      expect(issues).toHaveLength(1);
      const issue = issues?.[0];
      expect(issue).toEqual({ path: "SECRET_MODE", code: expect.any(String) });
      expect(issue).not.toHaveProperty("received");
      expect(issue).not.toHaveProperty("message");
    }
  });
});

describe("loadConfig / loadCoreConfig — valid config loads correctly", () => {
  it("loads the core config from defaults alone when env/override are empty", () => {
    const config = loadCoreConfig({ env: {} });
    expect(config).toEqual<CoreConfig>({ NODE_ENV: "development", PORT: 3000, LOG_LEVEL: "info" });
  });

  it("loads valid values supplied entirely from env, coercing PORT to a number", () => {
    const config = loadCoreConfig({
      env: { NODE_ENV: "production", PORT: "8080", LOG_LEVEL: "warn" },
    });
    expect(config).toEqual<CoreConfig>({ NODE_ENV: "production", PORT: 8080, LOG_LEVEL: "warn" });
    expect(config.PORT).toEqual(expect.any(Number));
  });

  it("rejects an invalid NODE_ENV enum value with a ConfigError", () => {
    expect(() => loadCoreConfig({ env: { NODE_ENV: "staging" } })).toThrow(ConfigError);
  });

  it("rejects an out-of-range PORT with a ConfigError", () => {
    expect(() => loadCoreConfig({ env: { PORT: "70000" } })).toThrow(ConfigError);
  });
});

describe("loadConfig — layering precedence (defaults -> env -> operator override file)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("env overrides defaults", () => {
    const config = loadCoreConfig({ defaults: { PORT: 3000 }, env: { PORT: "4000" } });
    expect(config.PORT).toBe(4000);
  });

  it("override file overrides env, which overrides defaults", () => {
    dir = makeTempDir();
    const overrideFilePath = join(dir, "config.local.json");
    writeFileSync(overrideFilePath, JSON.stringify({ PORT: 9000 }));

    const config = loadCoreConfig({
      defaults: { PORT: 3000 },
      env: { PORT: "4000" },
      overrideFilePath,
    });
    expect(config.PORT).toBe(9000);
  });

  it("a missing override file is not an error and simply falls through to env", () => {
    const config = loadCoreConfig({
      env: { PORT: "4000" },
      overrideFilePath: join(tmpdir(), "appskeleton-does-not-exist-config.json"),
    });
    expect(config.PORT).toBe(4000);
  });

  it("exercises full three-layer precedence across distinct fields at once", () => {
    dir = makeTempDir();
    const overrideFilePath = join(dir, "config.local.json");
    writeFileSync(overrideFilePath, JSON.stringify({ LOG_LEVEL: "debug" }));

    const config = loadConfig({
      schema: CoreConfigSchema,
      defaults: { PORT: 1111, LOG_LEVEL: "error", NODE_ENV: "development" },
      env: { PORT: "2222" },
      overrideFilePath,
    });

    expect(config.PORT).toBe(2222); // env beats default
    expect(config.LOG_LEVEL).toBe("debug"); // override file beats env and default
    expect(config.NODE_ENV).toBe("development"); // only default was ever supplied
  });
});

describe("loadConfig — override file error handling", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("throws a ConfigError for malformed JSON in the override file", () => {
    dir = makeTempDir();
    const overrideFilePath = join(dir, "config.local.json");
    writeFileSync(overrideFilePath, "{ not valid json");

    expect(() => loadCoreConfig({ env: {}, overrideFilePath })).toThrow(ConfigError);
  });

  it("throws a ConfigError when the override file is not a JSON object", () => {
    dir = makeTempDir();
    const overrideFilePath = join(dir, "config.local.json");
    writeFileSync(overrideFilePath, JSON.stringify([1, 2, 3]));

    expect(() => loadCoreConfig({ env: {}, overrideFilePath })).toThrow(ConfigError);
  });
});

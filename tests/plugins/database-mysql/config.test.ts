import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/core/errors.js";
import {
  DbConfigSchema,
  loadDbConfig,
  type DbConfig,
} from "../../../src/plugins/database-mysql/src/config.js";

const VALID_ENV = {
  DB_HOST: "127.0.0.1",
  DB_PORT: "3306",
  DB_USER: "appskeleton",
  DB_PASSWORD: "change-me",
  DB_NAME: "appskeleton",
  DB_CONNECTION_LIMIT: "10",
};

describe("DbConfigSchema / loadDbConfig — required fields fail fast", () => {
  it("throws a ConfigError when DB_USER, DB_PASSWORD, and DB_NAME are all missing", () => {
    expect(() => loadDbConfig({ env: {} })).toThrow(ConfigError);
  });

  it("error message clearly names every missing required field", () => {
    try {
      loadDbConfig({ env: {} });
      expect.fail("expected loadDbConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.code).toBe("CONFIG_ERROR");
      expect(configError.message).toContain("DB_USER");
      expect(configError.message).toContain("DB_PASSWORD");
      expect(configError.message).toContain("DB_NAME");
      expect(configError.message.toLowerCase()).toContain("required");
      // Public-facing message must not leak internal field-level detail.
      expect(configError.publicMessage).not.toContain("DB_USER");
    }
  });

  it("still fails when only DB_PASSWORD is missing and everything else is valid", () => {
    const envWithoutPassword = {
      DB_HOST: VALID_ENV.DB_HOST,
      DB_PORT: VALID_ENV.DB_PORT,
      DB_USER: VALID_ENV.DB_USER,
      DB_NAME: VALID_ENV.DB_NAME,
      DB_CONNECTION_LIMIT: VALID_ENV.DB_CONNECTION_LIMIT,
    };
    expect(() => loadDbConfig({ env: envWithoutPassword })).toThrow(ConfigError);

    try {
      loadDbConfig({ env: envWithoutPassword });
      expect.fail("expected loadDbConfig to throw");
    } catch (error) {
      const configError = error as ConfigError;
      expect(configError.message).toContain("DB_PASSWORD");
      expect(configError.message).not.toContain("DB_USER is required");
    }
  });

  it("rejects an empty-string DB_USER as malformed, not merely absent", () => {
    expect(() => loadDbConfig({ env: { ...VALID_ENV, DB_USER: "" } })).toThrow(ConfigError);
  });
});

describe("DbConfigSchema / loadDbConfig — malformed fields fail fast", () => {
  it("rejects a non-numeric DB_PORT", () => {
    expect(() => loadDbConfig({ env: { ...VALID_ENV, DB_PORT: "not-a-port" } })).toThrow(
      ConfigError,
    );
  });

  it("rejects an out-of-range DB_PORT", () => {
    expect(() => loadDbConfig({ env: { ...VALID_ENV, DB_PORT: "70000" } })).toThrow(ConfigError);
  });

  it("rejects a non-numeric DB_CONNECTION_LIMIT", () => {
    expect(() => loadDbConfig({ env: { ...VALID_ENV, DB_CONNECTION_LIMIT: "lots" } })).toThrow(
      ConfigError,
    );
  });

  it("rejects a zero DB_CONNECTION_LIMIT", () => {
    expect(() => loadDbConfig({ env: { ...VALID_ENV, DB_CONNECTION_LIMIT: "0" } })).toThrow(
      ConfigError,
    );
  });

  it('rejects a DB_SSL value outside "disabled"/"enabled"', () => {
    expect(() => loadDbConfig({ env: { ...VALID_ENV, DB_SSL: "maybe" } })).toThrow(ConfigError);
  });
});

describe("DbConfigSchema / loadDbConfig — valid config loads correctly", () => {
  it("loads required fields plus defaults for everything else", () => {
    const config = loadDbConfig({
      env: { DB_USER: "appskeleton", DB_PASSWORD: "change-me", DB_NAME: "appskeleton" },
    });
    expect(config).toEqual<DbConfig>({
      DB_HOST: "127.0.0.1",
      DB_PORT: 3306,
      DB_USER: "appskeleton",
      DB_PASSWORD: "change-me",
      DB_NAME: "appskeleton",
      DB_CONNECTION_LIMIT: 10,
      DB_SSL: "disabled",
      DB_SSL_REJECT_UNAUTHORIZED: true,
    });
  });

  it("coerces DB_PORT and DB_CONNECTION_LIMIT from env strings to numbers", () => {
    const config = loadDbConfig({
      env: { ...VALID_ENV, DB_PORT: "3307", DB_CONNECTION_LIMIT: "25" },
    });
    expect(config.DB_PORT).toBe(3307);
    expect(config.DB_PORT).toEqual(expect.any(Number));
    expect(config.DB_CONNECTION_LIMIT).toBe(25);
    expect(config.DB_CONNECTION_LIMIT).toEqual(expect.any(Number));
  });

  it("env overrides defaults for DB_HOST/DB_PORT", () => {
    const config = loadDbConfig({
      env: { ...VALID_ENV, DB_HOST: "db.internal", DB_PORT: "3399" },
    });
    expect(config.DB_HOST).toBe("db.internal");
    expect(config.DB_PORT).toBe(3399);
  });
});

describe("DbConfigSchema / loadDbConfig — optional TLS", () => {
  it("defaults DB_SSL to disabled with no ssl-related fields required", () => {
    const config = loadDbConfig({ env: VALID_ENV });
    expect(config.DB_SSL).toBe("disabled");
    expect(config.DB_SSL_CA).toBeUndefined();
    expect(config.DB_SSL_REJECT_UNAUTHORIZED).toBe(true);
  });

  it("accepts DB_SSL=enabled without a CA (encrypt without custom CA verification)", () => {
    const config = loadDbConfig({ env: { ...VALID_ENV, DB_SSL: "enabled" } });
    expect(config.DB_SSL).toBe("enabled");
    expect(config.DB_SSL_CA).toBeUndefined();
  });

  it("carries DB_SSL_CA through untouched when supplied", () => {
    const ca = "-----BEGIN CERTIFICATE-----\nMIIB...fake...\n-----END CERTIFICATE-----";
    const config = loadDbConfig({ env: { ...VALID_ENV, DB_SSL: "enabled", DB_SSL_CA: ca } });
    expect(config.DB_SSL_CA).toBe(ca);
  });

  it('DB_SSL_REJECT_UNAUTHORIZED="false" coerces to boolean false, not truthy-string true', () => {
    const config = loadDbConfig({
      env: { ...VALID_ENV, DB_SSL: "enabled", DB_SSL_REJECT_UNAUTHORIZED: "false" },
    });
    expect(config.DB_SSL_REJECT_UNAUTHORIZED).toBe(false);
  });

  it('DB_SSL_REJECT_UNAUTHORIZED="true" coerces to boolean true', () => {
    const config = loadDbConfig({
      env: { ...VALID_ENV, DB_SSL: "enabled", DB_SSL_REJECT_UNAUTHORIZED: "true" },
    });
    expect(config.DB_SSL_REJECT_UNAUTHORIZED).toBe(true);
  });

  it("rejects a non-boolean-like DB_SSL_REJECT_UNAUTHORIZED value", () => {
    expect(() =>
      loadDbConfig({ env: { ...VALID_ENV, DB_SSL_REJECT_UNAUTHORIZED: "yes-please" } }),
    ).toThrow(ConfigError);
  });
});

describe("DbConfigSchema — exported for direct reuse", () => {
  it("is a zod object schema whose shape includes every DB_* field", () => {
    expect(Object.keys(DbConfigSchema.shape)).toEqual(
      expect.arrayContaining([
        "DB_HOST",
        "DB_PORT",
        "DB_USER",
        "DB_PASSWORD",
        "DB_NAME",
        "DB_CONNECTION_LIMIT",
        "DB_SSL",
        "DB_SSL_CA",
        "DB_SSL_REJECT_UNAUTHORIZED",
      ]),
    );
  });
});

import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/core/errors.js";
import {
  RequestLimitsConfigSchema,
  loadRequestLimitsConfig,
} from "../../../src/plugins/api-gateway/src/request-limits-config.js";

describe("loadRequestLimitsConfig — safe to load with no configuration at all", () => {
  it("defaults REQUEST_BODY_LIMIT_BYTES and REQUEST_TIMEOUT_MS when unset", () => {
    expect(loadRequestLimitsConfig({ env: {} })).toEqual({
      REQUEST_BODY_LIMIT_BYTES: 1048576,
      REQUEST_TIMEOUT_MS: 30000,
    });
  });

  it("honors explicit REQUEST_BODY_LIMIT_BYTES / REQUEST_TIMEOUT_MS from env", () => {
    const config = loadRequestLimitsConfig({
      env: { REQUEST_BODY_LIMIT_BYTES: "2048", REQUEST_TIMEOUT_MS: "5000" },
    });
    expect(config).toEqual({ REQUEST_BODY_LIMIT_BYTES: 2048, REQUEST_TIMEOUT_MS: 5000 });
  });

  it("coerces env-string values to numbers", () => {
    const config = loadRequestLimitsConfig({ env: { REQUEST_BODY_LIMIT_BYTES: "4096" } });
    expect(config.REQUEST_BODY_LIMIT_BYTES).toBe(4096);
    expect(typeof config.REQUEST_BODY_LIMIT_BYTES).toBe("number");
  });

  it("RequestLimitsConfigSchema alone parses an empty object to the documented defaults", () => {
    expect(RequestLimitsConfigSchema.parse({})).toEqual({
      REQUEST_BODY_LIMIT_BYTES: 1048576,
      REQUEST_TIMEOUT_MS: 30000,
    });
  });
});

describe("loadRequestLimitsConfig — fails fast on malformed values", () => {
  it("throws a ConfigError for a non-numeric REQUEST_BODY_LIMIT_BYTES", () => {
    expect(() =>
      loadRequestLimitsConfig({ env: { REQUEST_BODY_LIMIT_BYTES: "not-a-number" } }),
    ).toThrow(ConfigError);
  });

  it("throws a ConfigError for a zero or negative REQUEST_BODY_LIMIT_BYTES", () => {
    expect(() => loadRequestLimitsConfig({ env: { REQUEST_BODY_LIMIT_BYTES: "0" } })).toThrow(
      ConfigError,
    );
    expect(() => loadRequestLimitsConfig({ env: { REQUEST_BODY_LIMIT_BYTES: "-5" } })).toThrow(
      ConfigError,
    );
  });

  it("throws a ConfigError for a non-integer REQUEST_TIMEOUT_MS", () => {
    expect(() => loadRequestLimitsConfig({ env: { REQUEST_TIMEOUT_MS: "1.5" } })).toThrow(
      ConfigError,
    );
  });

  it("throws a ConfigError for a zero or negative REQUEST_TIMEOUT_MS", () => {
    expect(() => loadRequestLimitsConfig({ env: { REQUEST_TIMEOUT_MS: "0" } })).toThrow(
      ConfigError,
    );
    expect(() => loadRequestLimitsConfig({ env: { REQUEST_TIMEOUT_MS: "-1" } })).toThrow(
      ConfigError,
    );
  });
});

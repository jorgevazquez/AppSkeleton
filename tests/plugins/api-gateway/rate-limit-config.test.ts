import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/core/errors.js";
import {
  RateLimitConfigSchema,
  loadRateLimitConfig,
} from "../../../src/plugins/api-gateway/src/rate-limit-config.js";

describe("loadRateLimitConfig — safe to load with no configuration at all", () => {
  it("defaults RATE_LIMIT_MAX and RATE_LIMIT_WINDOW_MS when unset", () => {
    expect(loadRateLimitConfig({ env: {} })).toEqual({
      RATE_LIMIT_MAX: 300,
      RATE_LIMIT_WINDOW_MS: 60000,
    });
  });

  it("honors explicit RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS from env", () => {
    const config = loadRateLimitConfig({
      env: { RATE_LIMIT_MAX: "5", RATE_LIMIT_WINDOW_MS: "1000" },
    });
    expect(config).toEqual({ RATE_LIMIT_MAX: 5, RATE_LIMIT_WINDOW_MS: 1000 });
  });

  it("coerces env-string values to numbers", () => {
    const config = loadRateLimitConfig({ env: { RATE_LIMIT_MAX: "42" } });
    expect(config.RATE_LIMIT_MAX).toBe(42);
    expect(typeof config.RATE_LIMIT_MAX).toBe("number");
  });

  it("RateLimitConfigSchema alone parses an empty object to the documented defaults", () => {
    expect(RateLimitConfigSchema.parse({})).toEqual({
      RATE_LIMIT_MAX: 300,
      RATE_LIMIT_WINDOW_MS: 60000,
    });
  });
});

describe("loadRateLimitConfig — fails fast on malformed values", () => {
  it("throws a ConfigError for a non-numeric RATE_LIMIT_MAX", () => {
    expect(() => loadRateLimitConfig({ env: { RATE_LIMIT_MAX: "not-a-number" } })).toThrow(
      ConfigError,
    );
  });

  it("throws a ConfigError for a zero or negative RATE_LIMIT_MAX", () => {
    expect(() => loadRateLimitConfig({ env: { RATE_LIMIT_MAX: "0" } })).toThrow(ConfigError);
    expect(() => loadRateLimitConfig({ env: { RATE_LIMIT_MAX: "-5" } })).toThrow(ConfigError);
  });

  it("throws a ConfigError for a non-integer RATE_LIMIT_WINDOW_MS", () => {
    expect(() => loadRateLimitConfig({ env: { RATE_LIMIT_WINDOW_MS: "1.5" } })).toThrow(
      ConfigError,
    );
  });
});

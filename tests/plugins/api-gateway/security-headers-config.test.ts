import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/core/errors.js";
import {
  SecurityHeadersConfigSchema,
  loadSecurityHeadersConfig,
} from "../../../src/plugins/api-gateway/src/security-headers-config.js";

describe("loadSecurityHeadersConfig — safe to load with no configuration at all", () => {
  it("defaults to a fully-enabled, secure-by-default policy when unset", () => {
    expect(loadSecurityHeadersConfig({ env: {} })).toEqual({
      HELMET_ENABLED: true,
      HELMET_CSP_ENABLED: true,
      HELMET_HSTS_ENABLED: true,
      HELMET_HSTS_MAX_AGE: 15552000,
    });
  });

  it("honors explicit overrides from env", () => {
    const config = loadSecurityHeadersConfig({
      env: {
        HELMET_ENABLED: "false",
        HELMET_CSP_ENABLED: "false",
        HELMET_HSTS_ENABLED: "false",
        HELMET_HSTS_MAX_AGE: "3600",
      },
    });
    expect(config).toEqual({
      HELMET_ENABLED: false,
      HELMET_CSP_ENABLED: false,
      HELMET_HSTS_ENABLED: false,
      HELMET_HSTS_MAX_AGE: 3600,
    });
  });

  it('treats the string "false" as false, not truthy (not z.coerce.boolean())', () => {
    const config = loadSecurityHeadersConfig({ env: { HELMET_ENABLED: "false" } });
    expect(config.HELMET_ENABLED).toBe(false);
  });

  it("coerces HELMET_HSTS_MAX_AGE from an env string to a number", () => {
    const config = loadSecurityHeadersConfig({ env: { HELMET_HSTS_MAX_AGE: "60" } });
    expect(config.HELMET_HSTS_MAX_AGE).toBe(60);
    expect(typeof config.HELMET_HSTS_MAX_AGE).toBe("number");
  });

  it("SecurityHeadersConfigSchema alone parses an empty object to the documented defaults", () => {
    expect(SecurityHeadersConfigSchema.parse({})).toEqual({
      HELMET_ENABLED: true,
      HELMET_CSP_ENABLED: true,
      HELMET_HSTS_ENABLED: true,
      HELMET_HSTS_MAX_AGE: 15552000,
    });
  });
});

describe("loadSecurityHeadersConfig — fails fast on malformed values", () => {
  it("throws a ConfigError for a non-numeric HELMET_HSTS_MAX_AGE", () => {
    expect(() =>
      loadSecurityHeadersConfig({ env: { HELMET_HSTS_MAX_AGE: "not-a-number" } }),
    ).toThrow(ConfigError);
  });

  it("throws a ConfigError for a negative HELMET_HSTS_MAX_AGE", () => {
    expect(() => loadSecurityHeadersConfig({ env: { HELMET_HSTS_MAX_AGE: "-5" } })).toThrow(
      ConfigError,
    );
  });

  it("throws a ConfigError for a non-integer HELMET_HSTS_MAX_AGE", () => {
    expect(() => loadSecurityHeadersConfig({ env: { HELMET_HSTS_MAX_AGE: "1.5" } })).toThrow(
      ConfigError,
    );
  });

  it("throws a ConfigError for a non-boolean-ish HELMET_ENABLED value", () => {
    expect(() => loadSecurityHeadersConfig({ env: { HELMET_ENABLED: "yes" } })).toThrow(
      ConfigError,
    );
  });
});

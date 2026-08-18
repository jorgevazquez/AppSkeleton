import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/core/errors.js";
import {
  CookieConfigSchema,
  SessionConfigSchema,
  loadCookieConfig,
  loadSessionConfig,
} from "../../../src/plugins/api-gateway/src/session-config.js";

describe("loadCookieConfig — safe to load with no configuration at all", () => {
  it("defaults COOKIE_SECURE to true (secure by default) when unset", () => {
    expect(loadCookieConfig({ env: {} })).toEqual({ COOKIE_SECURE: true });
  });

  it("honors an explicit COOKIE_SECURE=false from env (escape hatch for plain-HTTP local dev)", () => {
    expect(loadCookieConfig({ env: { COOKIE_SECURE: "false" } })).toEqual({
      COOKIE_SECURE: false,
    });
  });

  it("treats the literal string 'false' as false, not merely non-empty/truthy", () => {
    const config = loadCookieConfig({ env: { COOKIE_SECURE: "false" } });
    expect(config.COOKIE_SECURE).toBe(false);
  });

  it("CookieConfigSchema alone parses an empty object to the secure default", () => {
    expect(CookieConfigSchema.parse({})).toEqual({ COOKIE_SECURE: true });
  });
});

describe("loadSessionConfig — SESSION_SECRET is required and fails fast", () => {
  const VALID_ENV = { SESSION_SECRET: "a-sufficiently-long-random-secret-value" };

  it("throws a ConfigError when SESSION_SECRET is entirely missing", () => {
    expect(() => loadSessionConfig({ env: {} })).toThrow(ConfigError);
  });

  it("error message names SESSION_SECRET and the public message stays generic", () => {
    try {
      loadSessionConfig({ env: {} });
      expect.fail("expected loadSessionConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.message).toContain("SESSION_SECRET");
      expect(configError.publicMessage).not.toContain("SESSION_SECRET");
    }
  });

  it("rejects a SESSION_SECRET shorter than 16 characters as too weak", () => {
    expect(() => loadSessionConfig({ env: { SESSION_SECRET: "short" } })).toThrow(ConfigError);
  });

  it("loads successfully with only SESSION_SECRET set, defaulting the rest", () => {
    const config = loadSessionConfig({ env: VALID_ENV });
    expect(config).toEqual({
      SESSION_SECRET: VALID_ENV.SESSION_SECRET,
      COOKIE_SECURE: true,
      SESSION_COOKIE_NAME: "sid",
    });
  });

  it("honors an explicit SESSION_COOKIE_NAME and COOKIE_SECURE override", () => {
    const config = loadSessionConfig({
      env: { ...VALID_ENV, COOKIE_SECURE: "false", SESSION_COOKIE_NAME: "my_session" },
    });
    expect(config.COOKIE_SECURE).toBe(false);
    expect(config.SESSION_COOKIE_NAME).toBe("my_session");
  });

  it("rejects an empty-string SESSION_COOKIE_NAME as malformed, not merely absent", () => {
    expect(() => loadSessionConfig({ env: { ...VALID_ENV, SESSION_COOKIE_NAME: "" } })).toThrow(
      ConfigError,
    );
  });

  it("SessionConfigSchema alone requires SESSION_SECRET", () => {
    const result = SessionConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

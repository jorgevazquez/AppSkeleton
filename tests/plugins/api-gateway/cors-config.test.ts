import { describe, expect, it } from "vitest";
import {
  CorsConfigSchema,
  loadCorsConfig,
} from "../../../src/plugins/api-gateway/src/cors-config.js";

describe("loadCorsConfig — safe to load with no configuration at all", () => {
  it("defaults to an empty allow-list when unset", () => {
    expect(loadCorsConfig({ env: {} })).toEqual({ CORS_ORIGIN: [] });
  });

  it("CorsConfigSchema alone parses an empty object to the documented default", () => {
    expect(CorsConfigSchema.parse({})).toEqual({ CORS_ORIGIN: [] });
  });

  it("parses a single configured origin into a one-element allow-list", () => {
    const config = loadCorsConfig({ env: { CORS_ORIGIN: "https://app.example.com" } });
    expect(config.CORS_ORIGIN).toEqual(["https://app.example.com"]);
  });

  it("splits a comma-separated CORS_ORIGIN into multiple allow-listed origins", () => {
    const config = loadCorsConfig({
      env: { CORS_ORIGIN: "https://a.example.com,https://b.example.com" },
    });
    expect(config.CORS_ORIGIN).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("trims whitespace around each origin and drops empty entries", () => {
    const config = loadCorsConfig({
      env: { CORS_ORIGIN: " https://a.example.com , https://b.example.com ,, " },
    });
    expect(config.CORS_ORIGIN).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it('an empty-string CORS_ORIGIN yields an empty allow-list, not [""]', () => {
    expect(loadCorsConfig({ env: { CORS_ORIGIN: "" } })).toEqual({ CORS_ORIGIN: [] });
  });
});

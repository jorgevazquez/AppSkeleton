/**
 * Unit tests for the wiki plugin's attachment storage config (feature #97,
 * step 1) — mirrors `tests/plugins/api-gateway/request-limits-config.test.ts`'s
 * own structure/style for a `loadConfig()`-backed schema.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/core/errors.js";
import {
  AttachmentStorageConfigSchema,
  loadAttachmentStorageConfig,
} from "../../../src/plugins/wiki/src/attachment-storage-config.js";

describe("loadAttachmentStorageConfig — safe to load with no configuration at all", () => {
  it("defaults WIKI_ATTACHMENTS_DIR and WIKI_ATTACHMENT_MAX_BYTES when unset", () => {
    const config = loadAttachmentStorageConfig({ env: {} });
    expect(config.WIKI_ATTACHMENTS_DIR).toBe(path.join(process.cwd(), "var", "wiki-attachments"));
    expect(config.WIKI_ATTACHMENT_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it("honors explicit WIKI_ATTACHMENTS_DIR / WIKI_ATTACHMENT_MAX_BYTES from env", () => {
    const config = loadAttachmentStorageConfig({
      env: { WIKI_ATTACHMENTS_DIR: "/data/attachments", WIKI_ATTACHMENT_MAX_BYTES: "2048" },
    });
    expect(config).toEqual({
      WIKI_ATTACHMENTS_DIR: "/data/attachments",
      WIKI_ATTACHMENT_MAX_BYTES: 2048,
    });
  });

  it("coerces env-string byte limits to numbers", () => {
    const config = loadAttachmentStorageConfig({ env: { WIKI_ATTACHMENT_MAX_BYTES: "4096" } });
    expect(config.WIKI_ATTACHMENT_MAX_BYTES).toBe(4096);
    expect(typeof config.WIKI_ATTACHMENT_MAX_BYTES).toBe("number");
  });

  it("AttachmentStorageConfigSchema alone parses an empty object to the documented defaults", () => {
    const parsed = AttachmentStorageConfigSchema.parse({});
    expect(parsed.WIKI_ATTACHMENTS_DIR).toBe(path.join(process.cwd(), "var", "wiki-attachments"));
    expect(parsed.WIKI_ATTACHMENT_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("loadAttachmentStorageConfig — fails fast on malformed values", () => {
  it("throws a ConfigError for an empty WIKI_ATTACHMENTS_DIR", () => {
    expect(() => loadAttachmentStorageConfig({ env: { WIKI_ATTACHMENTS_DIR: "" } })).toThrow(
      ConfigError,
    );
  });

  it("throws a ConfigError for a non-numeric WIKI_ATTACHMENT_MAX_BYTES", () => {
    expect(() =>
      loadAttachmentStorageConfig({ env: { WIKI_ATTACHMENT_MAX_BYTES: "not-a-number" } }),
    ).toThrow(ConfigError);
  });

  it("throws a ConfigError for a zero or negative WIKI_ATTACHMENT_MAX_BYTES", () => {
    expect(() => loadAttachmentStorageConfig({ env: { WIKI_ATTACHMENT_MAX_BYTES: "0" } })).toThrow(
      ConfigError,
    );
    expect(() => loadAttachmentStorageConfig({ env: { WIKI_ATTACHMENT_MAX_BYTES: "-5" } })).toThrow(
      ConfigError,
    );
  });

  it("throws a ConfigError for a non-integer WIKI_ATTACHMENT_MAX_BYTES", () => {
    expect(() =>
      loadAttachmentStorageConfig({ env: { WIKI_ATTACHMENT_MAX_BYTES: "1.5" } }),
    ).toThrow(ConfigError);
  });
});

/**
 * Unit tests for the wiki plugin's filesystem-backed attachment blob
 * storage (feature #97 — "Attachments/file upload support for wiki
 * pages"), step 1: "Implement size-limited, content-type-validated file
 * upload ... stored outside the webroot with randomized storage names."
 *
 * No MySQL/HTTP needed — every function under test here is a pure
 * validation helper or a plain filesystem read/write against a disposable
 * temp directory (`mkdtempSync`/`rmSync`, the same pattern
 * `tests/core/config.test.ts` already establishes for this codebase).
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../../src/core/errors.js";
import {
  ALLOWED_ATTACHMENT_CONTENT_TYPES,
  assertAttachmentUploadAllowed,
  deleteAttachmentFile,
  generateStorageName,
  isAllowedAttachmentContentType,
  readAttachmentFile,
  writeAttachmentFile,
} from "../../../src/plugins/wiki/src/attachment-storage.js";

describe("isAllowedAttachmentContentType / ALLOWED_ATTACHMENT_CONTENT_TYPES", () => {
  it("allows every content type in the fixed allowlist", () => {
    for (const contentType of ALLOWED_ATTACHMENT_CONTENT_TYPES) {
      expect(isAllowedAttachmentContentType(contentType)).toBe(true);
    }
  });

  it("rejects an executable/script-shaped content type not in the allowlist", () => {
    expect(isAllowedAttachmentContentType("text/html")).toBe(false);
    expect(isAllowedAttachmentContentType("application/javascript")).toBe(false);
    expect(isAllowedAttachmentContentType("application/x-sh")).toBe(false);
  });
});

describe("assertAttachmentUploadAllowed — content-type and size validation (step 1)", () => {
  const limits = { maxBytes: 1024 };

  it("accepts an allowlisted content type within the size limit", () => {
    expect(() =>
      assertAttachmentUploadAllowed({ contentType: "image/png", sizeBytes: 512 }, limits),
    ).not.toThrow();
  });

  it("rejects a disallowed content type", () => {
    expect(() =>
      assertAttachmentUploadAllowed({ contentType: "text/html", sizeBytes: 10 }, limits),
    ).toThrow(ValidationError);
  });

  it("rejects an oversized upload", () => {
    expect(() =>
      assertAttachmentUploadAllowed({ contentType: "image/png", sizeBytes: 2048 }, limits),
    ).toThrow(ValidationError);
  });

  it("rejects an empty (zero-byte) upload", () => {
    expect(() =>
      assertAttachmentUploadAllowed({ contentType: "image/png", sizeBytes: 0 }, limits),
    ).toThrow(ValidationError);
  });

  it("accepts an upload exactly at the size limit", () => {
    expect(() =>
      assertAttachmentUploadAllowed({ contentType: "image/png", sizeBytes: 1024 }, limits),
    ).not.toThrow();
  });
});

describe("generateStorageName", () => {
  it("produces a 48-character lowercase hex string", () => {
    const name = generateStorageName();
    expect(name).toMatch(/^[0-9a-f]{48}$/);
  });

  it("is different on every call", () => {
    const names = new Set(Array.from({ length: 20 }, () => generateStorageName()));
    expect(names.size).toBe(20);
  });
});

describe("writeAttachmentFile / readAttachmentFile / deleteAttachmentFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "appskeleton-wiki-attachments-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips bytes written under a generated storage name", async () => {
    const storageName = generateStorageName();
    const data = Buffer.from("hello attachment world", "utf-8");

    await writeAttachmentFile(dir, storageName, data);
    const readBack = await readAttachmentFile(dir, storageName);

    expect(readBack.equals(data)).toBe(true);
  });

  it("creates the storage directory if it doesn't already exist", async () => {
    const nestedDir = join(dir, "nested", "subdir");
    const storageName = generateStorageName();

    await writeAttachmentFile(nestedDir, storageName, Buffer.from("x"));

    expect(statSync(join(nestedDir, storageName)).isFile()).toBe(true);
  });

  it("writes the file with an owner-only (0600) file mode", async () => {
    const storageName = generateStorageName();
    await writeAttachmentFile(dir, storageName, Buffer.from("secret"));

    const mode = statSync(join(dir, storageName)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("writes exactly the bytes given, verifiable by reading the raw file off disk", async () => {
    const storageName = generateStorageName();
    const data = Buffer.from([0, 1, 2, 255, 254, 253]);
    await writeAttachmentFile(dir, storageName, data);

    const raw = readFileSync(join(dir, storageName));
    expect(Buffer.from(raw).equals(data)).toBe(true);
  });

  it("deletes a previously-written file", async () => {
    const storageName = generateStorageName();
    await writeAttachmentFile(dir, storageName, Buffer.from("bye"));

    await deleteAttachmentFile(dir, storageName);

    await expect(readAttachmentFile(dir, storageName)).rejects.toThrow();
  });

  it("tolerates deleting a file that was never written (ENOENT is a no-op, not an error)", async () => {
    await expect(deleteAttachmentFile(dir, generateStorageName())).resolves.toBeUndefined();
  });

  it("rejects a path-traversal-shaped storage name on write, read, and delete alike", async () => {
    const traversal = "../../../../etc/passwd";
    await expect(writeAttachmentFile(dir, traversal, Buffer.from("x"))).rejects.toThrow(
      ValidationError,
    );
    await expect(readAttachmentFile(dir, traversal)).rejects.toThrow(ValidationError);
    await expect(deleteAttachmentFile(dir, traversal)).rejects.toThrow(ValidationError);
  });

  it("rejects a storage name that isn't the expected 48-hex-character shape", async () => {
    await expect(
      writeAttachmentFile(dir, "not-a-real-storage-name", Buffer.from("x")),
    ).rejects.toThrow(ValidationError);
  });
});

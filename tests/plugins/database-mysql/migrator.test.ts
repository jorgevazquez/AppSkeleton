/**
 * Unit tests for migrator.ts's pure/filesystem-only logic — no MySQL
 * required (see migrator.integration.test.ts for the full up/down/
 * checksum-rejection suite against real dockerized MySQL). Mirrors
 * registry.test.ts's mkdtempSync-based fixture pattern for
 * `listMigrationFiles()`'s directory-scanning behavior.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MigrationError } from "../../../src/core/errors.js";
import {
  computeChecksum,
  listMigrationFiles,
  planPendingMigrations,
  verifyAppliedChecksums,
  type AppliedMigrationRow,
  type MigrationFile,
} from "../../../src/plugins/database-mysql/src/migrator.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function trackedTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "appskeleton-migrator-"));
  tempRoots.push(dir);
  return dir;
}

function writeMigrationFile(dir: string, name: string, contents: string): void {
  writeFileSync(path.join(dir, name), contents);
}

describe("computeChecksum", () => {
  it("is deterministic for identical source text", () => {
    expect(computeChecksum("hello")).toBe(computeChecksum("hello"));
  });

  it("differs for different source text", () => {
    expect(computeChecksum("hello")).not.toBe(computeChecksum("hellO"));
  });

  it("returns a sha256 hex digest (64 lowercase hex chars)", () => {
    expect(computeChecksum("hello")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("listMigrationFiles", () => {
  it("returns an empty list for a directory that doesn't exist", () => {
    expect(listMigrationFiles(path.join(tmpdir(), "definitely-does-not-exist-12345"))).toEqual([]);
  });

  it("returns an empty list for an empty directory", () => {
    const dir = trackedTempDir();
    expect(listMigrationFiles(dir)).toEqual([]);
  });

  it("discovers migration files sorted lexicographically by filename", () => {
    const dir = trackedTempDir();
    writeMigrationFile(dir, "0002_second.ts", "export async function up() {}");
    writeMigrationFile(dir, "0001_first.ts", "export async function up() {}");
    writeMigrationFile(dir, "0010_tenth.ts", "export async function up() {}");

    const files = listMigrationFiles(dir);
    expect(files.map((f) => f.name)).toEqual(["0001_first.ts", "0002_second.ts", "0010_tenth.ts"]);
  });

  it("computes each file's checksum from its raw source text", () => {
    const dir = trackedTempDir();
    const source = "export async function up() { /* v1 */ }";
    writeMigrationFile(dir, "0001_a.ts", source);

    const [file] = listMigrationFiles(dir);
    expect(file?.checksum).toBe(computeChecksum(source));
  });

  it("ignores files that don't start with a run-order number", () => {
    const dir = trackedTempDir();
    writeMigrationFile(dir, "0001_valid.ts", "export async function up() {}");
    writeMigrationFile(dir, "README.md", "# not a migration");
    writeMigrationFile(dir, "helpers.ts", "export function noop() {}");

    expect(listMigrationFiles(dir).map((f) => f.name)).toEqual(["0001_valid.ts"]);
  });

  it("accepts .ts, .js, .mjs, and .cjs migration files", () => {
    const dir = trackedTempDir();
    writeMigrationFile(dir, "0001_a.ts", "export async function up() {}");
    writeMigrationFile(dir, "0002_b.js", "export async function up() {}");
    writeMigrationFile(dir, "0003_c.mjs", "export async function up() {}");
    writeMigrationFile(dir, "0004_d.cjs", "module.exports.up = async () => {};");

    expect(listMigrationFiles(dir).map((f) => f.name)).toEqual([
      "0001_a.ts",
      "0002_b.js",
      "0003_c.mjs",
      "0004_d.cjs",
    ]);
  });

  it("returns absolute file paths", () => {
    const dir = trackedTempDir();
    writeMigrationFile(dir, "0001_a.ts", "export async function up() {}");

    const [file] = listMigrationFiles(dir);
    expect(file?.filePath).toBe(path.join(dir, "0001_a.ts"));
    expect(path.isAbsolute(file!.filePath)).toBe(true);
  });
});

function appliedRow(name: string, checksum: string): AppliedMigrationRow {
  return { id: 1, name, checksum, applied_at: new Date() };
}

function migrationFile(name: string, checksum: string): MigrationFile {
  return { name, checksum, filePath: `/tmp/${name}` };
}

describe("verifyAppliedChecksums", () => {
  it("passes silently when every applied migration's checksum matches its file", () => {
    const applied = [appliedRow("0001_a.ts", "abc"), appliedRow("0002_b.ts", "def")];
    const files = [migrationFile("0001_a.ts", "abc"), migrationFile("0002_b.ts", "def")];
    expect(() => verifyAppliedChecksums(applied, files)).not.toThrow();
  });

  it("passes silently when there are no applied migrations yet", () => {
    expect(() => verifyAppliedChecksums([], [])).not.toThrow();
  });

  it("ignores pending (not-yet-applied) files with no corresponding applied row", () => {
    const applied = [appliedRow("0001_a.ts", "abc")];
    const files = [migrationFile("0001_a.ts", "abc"), migrationFile("0002_b.ts", "new-file")];
    expect(() => verifyAppliedChecksums(applied, files)).not.toThrow();
  });

  it("throws MigrationError when an applied migration's checksum no longer matches its file", () => {
    const applied = [appliedRow("0001_a.ts", "recorded-checksum")];
    const files = [migrationFile("0001_a.ts", "different-checksum")];

    expect(() => verifyAppliedChecksums(applied, files)).toThrow(MigrationError);
  });

  it("names the migration and both checksums in the mismatch error, without leaking via publicMessage", () => {
    const applied = [appliedRow("0001_a.ts", "recorded-checksum")];
    const files = [migrationFile("0001_a.ts", "different-checksum")];

    try {
      verifyAppliedChecksums(applied, files);
      expect.unreachable("expected verifyAppliedChecksums to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      const migrationError = error as MigrationError;
      expect(migrationError.message).toContain("0001_a.ts");
      expect(migrationError.message).toContain("recorded-checksum");
      expect(migrationError.message).toContain("different-checksum");
      expect(migrationError.details).toMatchObject({
        migration: "0001_a.ts",
        reason: "checksum_mismatch",
        recordedChecksum: "recorded-checksum",
        currentChecksum: "different-checksum",
      });
      expect(migrationError.publicMessage).not.toContain("0001_a.ts");
      expect(migrationError.publicMessage).not.toContain("recorded-checksum");
    }
  });

  it("throws MigrationError when an applied migration's file is missing entirely", () => {
    const applied = [appliedRow("0001_a.ts", "abc"), appliedRow("0002_missing.ts", "def")];
    const files = [migrationFile("0001_a.ts", "abc")];

    expect(() => verifyAppliedChecksums(applied, files)).toThrow(MigrationError);
    try {
      verifyAppliedChecksums(applied, files);
    } catch (error) {
      expect((error as MigrationError).details).toMatchObject({
        migration: "0002_missing.ts",
        reason: "missing_file",
      });
    }
  });

  it("checks migrations in applied order and reports the first problem found", () => {
    const applied = [appliedRow("0001_ok.ts", "abc"), appliedRow("0002_bad.ts", "recorded")];
    const files = [migrationFile("0001_ok.ts", "abc"), migrationFile("0002_bad.ts", "tampered")];

    try {
      verifyAppliedChecksums(applied, files);
      expect.unreachable("expected verifyAppliedChecksums to throw");
    } catch (error) {
      expect((error as MigrationError).details).toMatchObject({ migration: "0002_bad.ts" });
    }
  });
});

describe("planPendingMigrations", () => {
  it("returns every file when nothing has been applied yet", () => {
    const files = [migrationFile("0001_a.ts", "abc"), migrationFile("0002_b.ts", "def")];
    expect(planPendingMigrations(files, [])).toEqual(files);
  });

  it("excludes already-applied migrations by name", () => {
    const files = [migrationFile("0001_a.ts", "abc"), migrationFile("0002_b.ts", "def")];
    const applied = [appliedRow("0001_a.ts", "abc")];
    expect(planPendingMigrations(files, applied).map((f) => f.name)).toEqual(["0002_b.ts"]);
  });

  it("returns an empty list when every file is already applied", () => {
    const files = [migrationFile("0001_a.ts", "abc")];
    const applied = [appliedRow("0001_a.ts", "abc")];
    expect(planPendingMigrations(files, applied)).toEqual([]);
  });

  it("preserves the input files' order (already sorted by listMigrationFiles)", () => {
    const files = [
      migrationFile("0001_a.ts", "a"),
      migrationFile("0002_b.ts", "b"),
      migrationFile("0003_c.ts", "c"),
    ];
    const applied = [appliedRow("0002_b.ts", "b")];
    expect(planPendingMigrations(files, applied).map((f) => f.name)).toEqual([
      "0001_a.ts",
      "0003_c.ts",
    ]);
  });
});

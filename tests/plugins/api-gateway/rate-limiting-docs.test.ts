/**
 * Tests for feature #109 ("Document and tune default rate-limit / DoS
 * mitigation settings"), step 3: asserts `docs/rate-limiting.md`'s
 * documented `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` defaults table never
 * drifts from `RateLimitConfigSchema`'s actual configured defaults
 * (`src/plugins/api-gateway/src/rate-limit-config.ts`).
 *
 * This reads the real markdown file off disk and extracts the values from
 * its "## 2. Current defaults" table via regex, rather than hard-coding an
 * expected number here — the point is to catch exactly the failure mode
 * where a future change bumps a default in the schema (or edits the doc)
 * without updating the other, which a hard-coded expectation in this file
 * would not catch (this file would need updating too, same as the doc).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RateLimitConfigSchema } from "../../../src/plugins/api-gateway/src/rate-limit-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_PATH = resolve(__dirname, "../../../docs/rate-limiting.md");

/**
 * Pulls the `Default` column's backticked value out of the "Current
 * defaults" markdown table row whose `Env var` column is `` `envVar` ``.
 * The table is pipe-delimited GFM, e.g.:
 *   | Requests per window | `RATE_LIMIT_MAX` | `300` | ... |
 */
function extractDocumentedDefault(markdown: string, envVar: string): string {
  const rowPattern = new RegExp(`\\|[^|\\n]*\\|\\s*\`${envVar}\`\\s*\\|\\s*\`([^\`]+)\`\\s*\\|`);
  const match = markdown.match(rowPattern);
  if (!match) {
    throw new Error(
      `Could not find a "Current defaults" table row for ${envVar} in docs/rate-limiting.md — ` +
        "has the table's shape changed? Update this test's parser to match.",
    );
  }
  return match[1] as string;
}

describe("docs/rate-limiting.md — documented defaults match the configured RateLimitConfigSchema defaults (feature #109 step 3)", () => {
  const markdown = readFileSync(DOCS_PATH, "utf-8");
  const actualDefaults = RateLimitConfigSchema.parse({});

  it("documents RATE_LIMIT_MAX as a plain integer matching the schema default", () => {
    const documented = extractDocumentedDefault(markdown, "RATE_LIMIT_MAX");
    expect(Number(documented)).toBe(actualDefaults.RATE_LIMIT_MAX);
  });

  it("documents RATE_LIMIT_WINDOW_MS as a plain integer matching the schema default", () => {
    const documented = extractDocumentedDefault(markdown, "RATE_LIMIT_WINDOW_MS");
    expect(Number(documented)).toBe(actualDefaults.RATE_LIMIT_WINDOW_MS);
  });

  it("also matches .env.example, so a fresh checkout's example env boots with the same documented values", () => {
    const envExample = readFileSync(resolve(__dirname, "../../../.env.example"), "utf-8");
    const maxMatch = envExample.match(/^RATE_LIMIT_MAX=(\d+)$/m);
    const windowMatch = envExample.match(/^RATE_LIMIT_WINDOW_MS=(\d+)$/m);

    expect(maxMatch).not.toBeNull();
    expect(windowMatch).not.toBeNull();
    expect(Number(maxMatch?.[1])).toBe(actualDefaults.RATE_LIMIT_MAX);
    expect(Number(windowMatch?.[1])).toBe(actualDefaults.RATE_LIMIT_WINDOW_MS);
  });
});

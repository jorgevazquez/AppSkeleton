/**
 * Unit tests for `pages.ts` proving slug-grammar validation (feature #87
 * step 2) short-circuits *before* any `db:query` call — the same "`fn` is
 * mocked to fail the test if invoked" technique
 * `tests/plugins/rbac/store.test.ts` uses for its sibling grammar-validation
 * boundary. Business-rule paths that need real rows to exist (namespace
 * existence, duplicate-slug rejection, not-found on update/delete) are
 * covered against real MySQL in `pages-store.integration.test.ts` instead —
 * this file only proves the zero-I/O syntactic check runs first.
 */
import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../../src/core/errors.js";
import {
  createWikiPagesStore,
  type WikiDbQueryCapability,
} from "../../../src/plugins/wiki/src/pages.js";

function createFakeStore() {
  const query = vi.fn(async () => {
    throw new Error("dbQuery.query must not be called for a malformed slug");
  });
  const dbQuery = { query } as unknown as WikiDbQueryCapability;
  return { store: createWikiPagesStore(dbQuery), query };
}

describe("createWikiPagesStore.createPage — slug grammar validation", () => {
  it.each<[string, string]>([
    ["uppercase", "Not-Valid"],
    ["whitespace", "not valid"],
    ["leading hyphen", "-not-valid"],
    ["trailing hyphen", "not-valid-"],
    ["double hyphen", "not--valid"],
    ["empty string", ""],
  ])("rejects %s (%j) before ever calling db:query", async (_description, slug) => {
    const { store, query } = createFakeStore();

    await expect(
      store.createPage({ namespaceId: "any-namespace", slug, title: "T", content: "C" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(query).not.toHaveBeenCalled();
  });

  it("attaches the offending slug at error.details.input", async () => {
    const { store } = createFakeStore();

    try {
      await store.createPage({
        namespaceId: "any-namespace",
        slug: "Not Valid",
        title: "T",
        content: "C",
      });
      throw new Error("expected createPage to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details?.["input"]).toBe("Not Valid");
    }
  });
});

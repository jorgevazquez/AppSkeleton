/**
 * Unit tests for `page-tree.ts` (feature #91 — "Page tree / navigation
 * sidebar reflecting namespace hierarchy").
 *
 * Step 2 ("Write a test asserting a 3-level namespace hierarchy produces
 * the correct nested structure"): the "builds a correct nested structure
 * for a 3-level namespace hierarchy" case below is that test. It — and
 * every other `buildNamespaceTree` case in this file — exercises the pure,
 * synchronous tree-assembly function directly against hand-built
 * `wiki_namespaces`/`wiki_pages` row fixtures, no database involved,
 * mirroring `pages.test.ts`'s own "prove the zero-I/O logic in isolation"
 * precedent.
 *
 * `createWikiPageTreeStore.getPageTree`'s `db:query` wiring (step 1's
 * "query") is covered separately below with a mocked
 * `WikiDbQueryCapability` — the same "`dbQuery.query` mocked to resolve
 * canned rows, no real database" technique `pages.test.ts`'s module doc
 * comment describes for its own sibling boundary tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildNamespaceTree,
  createWikiPageTreeStore,
  type NamespaceRow,
  type PageSlugRow,
} from "../../../src/plugins/wiki/src/page-tree.js";
import type { WikiDbQueryCapability } from "../../../src/plugins/wiki/src/pages.js";

function namespace(overrides: Partial<NamespaceRow> & Pick<NamespaceRow, "id">): NamespaceRow {
  return {
    parent_id: null,
    name: overrides.id,
    description: null,
    ...overrides,
  };
}

function page(
  overrides: Partial<PageSlugRow> & Pick<PageSlugRow, "id" | "namespace_id">,
): PageSlugRow {
  return {
    slug: `page-${overrides.id}`,
    title: `Page ${overrides.id}`,
    ...overrides,
  };
}

describe("buildNamespaceTree — feature #91 step 1", () => {
  it("builds a correct nested structure for a 3-level namespace hierarchy (step 2)", () => {
    // main (root) -> help (child of main) -> getting-started (child of help)
    const namespaces: NamespaceRow[] = [
      namespace({ id: "main", parent_id: null, name: "Main", description: "Top-level namespace" }),
      namespace({ id: "help", parent_id: "main", name: "Help" }),
      namespace({ id: "getting-started", parent_id: "help", name: "Getting Started" }),
    ];
    const pages: PageSlugRow[] = [
      page({ id: 1, namespace_id: "main", slug: "home", title: "Home" }),
      page({ id: 2, namespace_id: "help", slug: "faq", title: "FAQ" }),
      page({ id: 3, namespace_id: "getting-started", slug: "install", title: "Install" }),
      page({ id: 4, namespace_id: "getting-started", slug: "quickstart", title: "Quickstart" }),
    ];

    const tree = buildNamespaceTree(namespaces, pages);

    // Exactly one root: "main".
    expect(tree).toHaveLength(1);
    const main = tree[0]!;
    expect(main).toMatchObject({ id: "main", name: "Main", description: "Top-level namespace" });
    expect(main.pages).toEqual([{ id: 1, slug: "home", title: "Home" }]);

    // "main" has exactly one child: "help".
    expect(main.children).toHaveLength(1);
    const help = main.children[0]!;
    expect(help).toMatchObject({ id: "help", name: "Help", description: null });
    expect(help.pages).toEqual([{ id: 2, slug: "faq", title: "FAQ" }]);

    // "help" has exactly one child: "getting-started" — the 3rd level.
    expect(help.children).toHaveLength(1);
    const gettingStarted = help.children[0]!;
    expect(gettingStarted).toMatchObject({ id: "getting-started", name: "Getting Started" });
    expect(gettingStarted.children).toEqual([]);

    // Pages under the 3rd-level namespace, sorted alphabetically by slug.
    expect(gettingStarted.pages).toEqual([
      { id: 3, slug: "install", title: "Install" },
      { id: 4, slug: "quickstart", title: "Quickstart" },
    ]);
  });

  it("returns an empty array when there are no namespaces at all", () => {
    expect(buildNamespaceTree([], [])).toEqual([]);
  });

  it("treats a namespace with no parent_id as a root with no pages when it has none", () => {
    const tree = buildNamespaceTree([namespace({ id: "solo", name: "Solo" })], []);

    expect(tree).toEqual([
      { id: "solo", name: "Solo", description: null, pages: [], children: [] },
    ]);
  });

  it("supports multiple root namespaces, each with their own independent subtree", () => {
    const namespaces: NamespaceRow[] = [
      namespace({ id: "beta", name: "Beta" }),
      namespace({ id: "alpha", name: "Alpha" }),
      namespace({ id: "beta-child", parent_id: "beta", name: "Beta Child" }),
    ];

    const tree = buildNamespaceTree(namespaces, []);

    // Roots sorted alphabetically by name: "Alpha" before "Beta".
    expect(tree.map((node) => node.id)).toEqual(["alpha", "beta"]);
    expect(tree.find((node) => node.id === "beta")?.children.map((c) => c.id)).toEqual([
      "beta-child",
    ]);
    expect(tree.find((node) => node.id === "alpha")?.children).toEqual([]);
  });

  it("sorts sibling children alphabetically by name regardless of input order", () => {
    const namespaces: NamespaceRow[] = [
      namespace({ id: "root", name: "Root" }),
      namespace({ id: "zeta", parent_id: "root", name: "Zeta" }),
      namespace({ id: "alpha", parent_id: "root", name: "Alpha" }),
      namespace({ id: "mid", parent_id: "root", name: "Mid" }),
    ];

    const tree = buildNamespaceTree(namespaces, []);

    expect(tree[0]!.children.map((c) => c.id)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("treats a namespace whose parent_id references a non-existent namespace as a root (orphan)", () => {
    const namespaces: NamespaceRow[] = [
      namespace({ id: "orphan", parent_id: "does-not-exist", name: "Orphan" }),
    ];

    const tree = buildNamespaceTree(namespaces, []);

    expect(tree.map((node) => node.id)).toEqual(["orphan"]);
  });

  it("attaches no pages to a namespace whose pages belong to a different namespace", () => {
    const namespaces: NamespaceRow[] = [
      namespace({ id: "a", name: "A" }),
      namespace({ id: "b", name: "B" }),
    ];
    const pages: PageSlugRow[] = [page({ id: 1, namespace_id: "a", slug: "only-in-a" })];

    const tree = buildNamespaceTree(namespaces, pages);

    expect(tree.find((n) => n.id === "a")?.pages).toHaveLength(1);
    expect(tree.find((n) => n.id === "b")?.pages).toEqual([]);
  });
});

describe("createWikiPageTreeStore.getPageTree — feature #91 step 1 (db:query wiring)", () => {
  it("reads wiki_namespaces and wiki_pages via db:query and assembles them with buildNamespaceTree", async () => {
    const namespaceRows: NamespaceRow[] = [
      namespace({ id: "root", name: "Root" }),
      namespace({ id: "child", parent_id: "root", name: "Child" }),
    ];
    const pageRows: PageSlugRow[] = [page({ id: 1, namespace_id: "child", slug: "leaf" })];

    const query = vi.fn().mockResolvedValueOnce(namespaceRows).mockResolvedValueOnce(pageRows);
    const dbQuery = { query } as unknown as WikiDbQueryCapability;

    const store = createWikiPageTreeStore(dbQuery);
    const tree = await store.getPageTree();

    expect(query).toHaveBeenCalledTimes(2);
    expect(tree).toEqual(buildNamespaceTree(namespaceRows, pageRows));
    expect(tree[0]!.children[0]!.pages).toEqual([{ id: 1, slug: "leaf", title: "Page 1" }]);
  });

  it("returns an empty array when wiki_namespaces has no rows", async () => {
    const query = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const dbQuery = { query } as unknown as WikiDbQueryCapability;

    const store = createWikiPageTreeStore(dbQuery);

    expect(await store.getPageTree()).toEqual([]);
  });
});

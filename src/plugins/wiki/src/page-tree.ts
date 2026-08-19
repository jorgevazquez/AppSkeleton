/**
 * Page tree / navigation sidebar query (feature #91 — "Page tree /
 * navigation sidebar reflecting namespace hierarchy").
 *
 * Step 1 ("Implement a query building a nested tree structure from
 * wiki_namespaces and page slugs"): {@link WikiPageTreeStore.getPageTree}
 * issues two flat `db:query` reads — every `wiki_namespaces` row and every
 * page's `(id, namespace_id, slug, title)` — through the same
 * {@link WikiDbQueryCapability} `pages.ts` and `revisions.ts` already
 * depend on (see `pages.ts`'s module doc comment for why that's a
 * locally-declared interface, not an import of database-mysql's own
 * type), then assembles both flat result sets into the nested
 * {@link NamespaceTreeNode}[] structure in application code via
 * {@link buildNamespaceTree} — the same "everything through `db:query`, no
 * direct SQL client usage" constraint `pages.ts`'s module doc documents.
 * Two flat selects + an in-memory assembly (rather than a recursive SQL
 * CTE) mirrors `pages.ts`/`revisions.ts`'s own "keep every query a plain
 * Kysely builder call" style and keeps this plugin portable across
 * whichever database-mysql-compatible driver ultimately backs `db:query` —
 * a wiki's namespace count is never large enough to make round-tripping
 * every row worth trading away for a recursive-CTE-only driver dependency.
 *
 * {@link buildNamespaceTree} is exported on its own and takes plain
 * in-memory rows rather than a capability handle, specifically so it can
 * be unit-tested against hand-built fixtures with no database at all —
 * `page-tree.test.ts`'s "3-level namespace hierarchy" case (feature #91
 * step 2) exercises exactly this function.
 */
import type { NamespaceTreeNode, PageTreeEntry } from "./types.js";
import { NAMESPACES_TABLE, PAGES_TABLE, type WikiDbQueryCapability } from "./pages.js";

/**
 * Raw `wiki_namespaces` row shape this module reads — a subset of
 * `pages.ts`'s own `NamespaceIdRow`, plus the hierarchy/display columns
 * that module never needs.
 */
export interface NamespaceRow {
  id: string;
  parent_id: string | null;
  name: string;
  description: string | null;
}

/**
 * Raw `wiki_pages` row shape this module reads — only the columns a
 * navigation-sidebar entry needs, not `pages.ts`'s full `PageRow`.
 */
export interface PageSlugRow {
  id: number;
  namespace_id: string;
  slug: string;
  title: string;
}

function toPageTreeEntry(row: PageSlugRow): PageTreeEntry {
  return { id: row.id, slug: row.slug, title: row.title };
}

/**
 * Assemble flat `wiki_namespaces` + `wiki_pages` rows into the nested
 * {@link NamespaceTreeNode}[] the navigation sidebar renders (feature #91
 * step 1). Pure and synchronous — no I/O — so it can be exercised
 * directly against hand-built fixtures.
 *
 * A namespace is treated as a root if `parent_id` is `null` *or*
 * references a `parent_id` that isn't present in `namespaces` at all (an
 * orphaned reference — the app-level namespace/page validation elsewhere
 * in this plugin has no create/update path for namespaces yet, so this
 * should never actually happen, but surfacing an orphan as a root keeps it
 * visible in the tree instead of silently dropping it). Both a namespace's
 * `children` and its `pages` are sorted alphabetically (by `name` and
 * `slug` respectively) for a stable, predictable render order.
 */
export function buildNamespaceTree(
  namespaces: readonly NamespaceRow[],
  pages: readonly PageSlugRow[],
): NamespaceTreeNode[] {
  const namespaceIds = new Set(namespaces.map((namespace) => namespace.id));

  const pagesByNamespace = new Map<string, PageTreeEntry[]>();
  for (const page of pages) {
    const entries = pagesByNamespace.get(page.namespace_id) ?? [];
    entries.push(toPageTreeEntry(page));
    pagesByNamespace.set(page.namespace_id, entries);
  }
  for (const entries of pagesByNamespace.values()) {
    entries.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  const childrenByParent = new Map<string | null, NamespaceRow[]>();
  for (const namespace of namespaces) {
    const parentKey =
      namespace.parent_id !== null && namespaceIds.has(namespace.parent_id)
        ? namespace.parent_id
        : null;
    const siblings = childrenByParent.get(parentKey) ?? [];
    siblings.push(namespace);
    childrenByParent.set(parentKey, siblings);
  }

  function buildNode(namespace: NamespaceRow): NamespaceTreeNode {
    const children = (childrenByParent.get(namespace.id) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(buildNode);

    return {
      id: namespace.id,
      name: namespace.name,
      description: namespace.description,
      pages: pagesByNamespace.get(namespace.id) ?? [],
      children,
    };
  }

  return (childrenByParent.get(null) ?? [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(buildNode);
}

/** The typed read surface {@link createWikiPageTreeStore} returns. */
export interface WikiPageTreeStore {
  /**
   * Build the full nested namespace/page tree for the navigation sidebar
   * (feature #91 step 1). Reads every `wiki_namespaces` row and every
   * page's `(id, namespace_id, slug, title)` via `db:query`, then
   * assembles them with {@link buildNamespaceTree}. Returns every
   * top-level (root) namespace, each with its full nested `children`/
   * `pages` already attached — an empty array if `wiki_namespaces` has no
   * rows at all.
   */
  getPageTree(): Promise<NamespaceTreeNode[]>;
}

/**
 * Build the page-tree / navigation-sidebar read-only data-access layer
 * over an already-obtained `db:query` capability handle.
 */
export function createWikiPageTreeStore(dbQuery: WikiDbQueryCapability): WikiPageTreeStore {
  return {
    async getPageTree() {
      const namespaceRows = await dbQuery.query((db) =>
        db.selectFrom(NAMESPACES_TABLE).selectAll().execute(),
      );
      const pageRows = await dbQuery.query((db) =>
        db.selectFrom(PAGES_TABLE).select(["id", "namespace_id", "slug", "title"]).execute(),
      );

      return buildNamespaceTree(
        namespaceRows as unknown as NamespaceRow[],
        pageRows as unknown as PageSlugRow[],
      );
    },
  };
}

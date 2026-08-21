/**
 * Tests for feature #98 — "Wiki-level audit log surfaced via the kernel
 * audit trail":
 *
 *   1. "Record create/update/delete/permission-denied events for wiki
 *      pages to the kernel audit trail with actor and page identity" —
 *      exercised directly against `authorized-store.ts`'s
 *      `createAuthorizedWikiStore`, the single choke point every wiki
 *      mutation and permission check already flows through (feature #93).
 *   2. "Write a test asserting an edit produces a queryable audit entry
 *      with the correct actor" — see "an edit (updatePage) produces a
 *      queryable audit entry with the correct actor" below.
 *
 * Mirrors `authorized-store.integration.test.ts`'s own "real rbac module,
 * fake pages/revisions store" pattern (that file's own module doc explains
 * why the store itself doesn't need to be real here — this suite is about
 * proving audit *wiring*, not `db:query`/MySQL persistence again).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryAuditSink } from "../../../src/core/audit.js";
import { AuthenticationError, AuthorizationError } from "../../../src/core/errors.js";
import * as rbacModule from "../../../src/plugins/rbac/index.js";
import type { RbacCheckCapability } from "../../../src/plugins/rbac/index.js";
import { createAuthorizedWikiStore } from "../../../src/plugins/wiki/src/authorized-store.js";
import type { WikiPagesStore } from "../../../src/plugins/wiki/src/pages.js";
import type { WikiRevisionsStore } from "../../../src/plugins/wiki/src/revisions.js";
import { NotFoundError } from "../../../src/core/errors.js";
import type { Page } from "../../../src/plugins/wiki/src/types.js";

function getRbacCheck(): RbacCheckCapability {
  return rbacModule.provides?.["rbac:check"] as RbacCheckCapability;
}

/** Minimal in-memory fake — see `authorized-store.integration.test.ts`'s own module doc for why the real db-backed store isn't needed here. */
function createFakePagesStore(seed: Page[]): WikiPagesStore {
  const pages = [...seed];
  let nextId = Math.max(0, ...pages.map((p) => p.id)) + 1;

  return {
    async createPage(input) {
      const now = new Date();
      const page: Page = { id: nextId++, createdAt: now, updatedAt: now, ...input };
      pages.push(page);
      return page;
    },
    async getPageById(id) {
      return pages.find((p) => p.id === id);
    },
    async getPageBySlug(namespaceId, slug) {
      return pages.find((p) => p.namespaceId === namespaceId && p.slug === slug);
    },
    async listPages(namespaceId) {
      return namespaceId === undefined
        ? [...pages]
        : pages.filter((p) => p.namespaceId === namespaceId);
    },
    async updatePage(id, changes) {
      const index = pages.findIndex((p) => p.id === id);
      if (index === -1) {
        throw new NotFoundError(`Page with id ${id} does not exist.`, { details: { id } });
      }
      const existing = pages[index] as Page;
      const updated: Page = { ...existing, ...changes, updatedAt: new Date() };
      pages[index] = updated;
      return updated;
    },
    async deletePage(id) {
      const index = pages.findIndex((p) => p.id === id);
      if (index === -1) {
        throw new NotFoundError(`Page with id ${id} does not exist.`, { details: { id } });
      }
      pages.splice(index, 1);
    },
  };
}

function createFakeRevisionsStore(): WikiRevisionsStore {
  return {
    async listRevisions() {
      return [];
    },
  };
}

const MAIN_PAGE: Page = {
  id: 1,
  namespaceId: "main",
  slug: "home",
  title: "Home",
  content: "Welcome.",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

/** Mirrors `rbac/seeds/index.ts`'s default roles. */
function seedRoles(): void {
  rbacModule.policyStore.rolePermissions.push(
    { roleId: "viewer", permissionId: "wiki:read" },
    { roleId: "editor", permissionId: "wiki:read" },
    { roleId: "editor", permissionId: "wiki:write" },
    { roleId: "admin", permissionId: "wiki:read" },
    { roleId: "admin", permissionId: "wiki:write" },
    { roleId: "admin", permissionId: "wiki:admin" },
  );
  rbacModule.policyStore.userRoles.push(
    { userId: "vera-viewer", roleId: "viewer" },
    { userId: "eddie-editor", roleId: "editor" },
    { userId: "amy-admin", roleId: "admin" },
  );
}

describe("wiki-level audit trail (feature #98)", () => {
  beforeEach(() => {
    rbacModule.resetPolicyStoreForTests();
    seedRoles();
  });

  function buildStore(auditSink: ReturnType<typeof createInMemoryAuditSink>) {
    return createAuthorizedWikiStore(
      createFakePagesStore([MAIN_PAGE]),
      createFakeRevisionsStore(),
      getRbacCheck(),
      auditSink,
    );
  }

  it("an edit (updatePage) produces a queryable audit entry with the correct actor", async () => {
    const auditSink = createInMemoryAuditSink();
    const store = buildStore(auditSink);

    const updated = await store.updatePage("eddie-editor", MAIN_PAGE.id, { title: "New Title" });
    expect(updated.title).toBe("New Title");

    const entries = auditSink.query({ actor: "eddie-editor" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: "eddie-editor",
      action: "wiki:update",
      target: `wiki:page:${MAIN_PAGE.id}`,
      outcome: "updated",
    });
    expect(typeof entries[0]?.timestamp).toBe("number");
    expect(entries[0]?.details).toMatchObject({ namespaceId: "main", slug: "home" });

    // Also queryable by action/outcome/target, not just actor.
    expect(auditSink.query({ action: "wiki:update", outcome: "updated" })).toHaveLength(1);
    const mainPageTarget = `wiki:page:${MAIN_PAGE.id}`;
    expect(auditSink.query({ target: mainPageTarget })).toHaveLength(1);
  });

  it("createPage records a 'created' audit entry with actor and the new page's identity", async () => {
    const auditSink = createInMemoryAuditSink();
    const store = buildStore(auditSink);

    const created = await store.createPage("eddie-editor", {
      namespaceId: "main",
      slug: "new-page",
      title: "New Page",
      content: "Hello.",
    });

    const entries = auditSink.query({ action: "wiki:create" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: "eddie-editor",
      action: "wiki:create",
      target: `wiki:page:${created.id}`,
      outcome: "created",
      details: { namespaceId: "main", slug: "new-page" },
    });
  });

  it("deletePage records a 'deleted' audit entry with actor and the deleted page's identity", async () => {
    const auditSink = createInMemoryAuditSink();
    const store = buildStore(auditSink);

    await store.deletePage("amy-admin", MAIN_PAGE.id);

    const entries = auditSink.query({ action: "wiki:delete" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: "amy-admin",
      action: "wiki:delete",
      target: `wiki:page:${MAIN_PAGE.id}`,
      outcome: "deleted",
      details: { namespaceId: "main", slug: "home" },
    });
  });

  it("a permission-denied write (viewer attempting to update) records a 'denied' entry with actor and page identity, and no 'updated' entry", async () => {
    const auditSink = createInMemoryAuditSink();
    const store = buildStore(auditSink);

    await expect(
      store.updatePage("vera-viewer", MAIN_PAGE.id, { title: "Nope" }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const denied = auditSink.query({ outcome: "denied" });
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      actor: "vera-viewer",
      action: "wiki:write",
      target: `wiki:page:${MAIN_PAGE.id}`,
      outcome: "denied",
    });
    expect(auditSink.query({ action: "wiki:update" })).toHaveLength(0);
  });

  it("a permission-denied delete (editor attempting admin-only delete) records a 'denied' entry", async () => {
    const auditSink = createInMemoryAuditSink();
    const store = buildStore(auditSink);

    await expect(store.deletePage("eddie-editor", MAIN_PAGE.id)).rejects.toBeInstanceOf(
      AuthorizationError,
    );

    const denied = auditSink.query({ outcome: "denied", action: "wiki:admin" });
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      actor: "eddie-editor",
      target: `wiki:page:${MAIN_PAGE.id}`,
    });
    expect(auditSink.query({ action: "wiki:delete" })).toHaveLength(0);
  });

  it("an unauthenticated (no userId) attempt records a 'denied' entry under actor 'anonymous'", async () => {
    const auditSink = createInMemoryAuditSink();
    const store = buildStore(auditSink);

    await expect(store.getPageById(undefined, MAIN_PAGE.id)).rejects.toBeInstanceOf(
      AuthenticationError,
    );

    const denied = auditSink.query({ outcome: "denied", actor: "anonymous" });
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      action: "wiki:read",
      target: `wiki:page:${MAIN_PAGE.id}`,
      outcome: "denied",
    });
  });

  it("a permission-denied create (before the page exists) still carries a page identity, built from namespaceId/slug", async () => {
    const auditSink = createInMemoryAuditSink();
    const store = buildStore(auditSink);

    await expect(
      store.createPage("vera-viewer", {
        namespaceId: "main",
        slug: "denied-create",
        title: "Nope",
        content: "x",
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const denied = auditSink.query({ outcome: "denied", action: "wiki:write" });
    expect(denied).toHaveLength(1);
    expect(denied[0]?.target).toBe("wiki:page:main/denied-create");
  });

  it("successful reads are not recorded — only create/update/delete/permission-denied are", async () => {
    const auditSink = createInMemoryAuditSink();
    const store = buildStore(auditSink);

    await store.getPageById("vera-viewer", MAIN_PAGE.id);
    await store.listPages("vera-viewer", "main");

    expect(auditSink.all()).toHaveLength(0);
  });

  it("no auditSink wired: mutations and denials still work, just unaudited (no throw)", async () => {
    const store = createAuthorizedWikiStore(
      createFakePagesStore([MAIN_PAGE]),
      createFakeRevisionsStore(),
      getRbacCheck(),
    );

    await expect(
      store.updatePage("eddie-editor", MAIN_PAGE.id, { title: "Still Works" }),
    ).resolves.toMatchObject({ title: "Still Works" });
    await expect(
      store.updatePage("vera-viewer", MAIN_PAGE.id, { title: "Denied" }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

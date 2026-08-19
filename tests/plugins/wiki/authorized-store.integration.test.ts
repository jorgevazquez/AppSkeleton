/**
 * Integration test for feature #93 ("RBAC integration: read/write/admin
 * permissions per page or namespace"), step 3: "Write integration tests for
 * allowed and denied access at each permission level." Driven through the
 * *real* `rbac` plugin module — its actual `check()`/`can()` policy engine,
 * not a hand-rolled fake — mirroring
 * `tests/plugins/api-gateway/rbac-protection.integration.test.ts`'s own
 * "real rbac module, seeded policy data" pattern (that file imports
 * `rbacModule`/`policyStore`/`resetPolicyStoreForTests` from
 * `src/plugins/rbac/index.js` directly for the exact same reason: proving a
 * *consumer* plugin's RBAC wiring actually works end-to-end against rbac's
 * real decisions, not just against a stand-in).
 *
 * `pages`/`revisions` themselves are fakes (a plain in-memory array) — this
 * suite is about proving `authorized-store.ts`'s authorization wiring is
 * correct, not about exercising `db:query`/MySQL again (already covered by
 * `pages-store.integration.test.ts`/`revisions-store.integration.test.ts`).
 *
 * Role/permission data mirrors `rbac/seeds/index.ts`'s real default-roles
 * seed (`viewer` → `wiki:read`; `editor` → `wiki:read`+`wiki:write`;
 * `admin` → all three) plus one namespace-scoped override permission
 * (`wiki-engineering:write`) that isn't part of the default seed, to prove
 * step 2's "unless a namespace overrides it."
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
} from "../../../src/core/errors.js";
import * as rbacModule from "../../../src/plugins/rbac/index.js";
import type { RbacCheckCapability } from "../../../src/plugins/rbac/index.js";
import { createAuthorizedWikiStore } from "../../../src/plugins/wiki/src/authorized-store.js";
import type { WikiPagesStore } from "../../../src/plugins/wiki/src/pages.js";
import type { WikiRevisionsStore } from "../../../src/plugins/wiki/src/revisions.js";
import type { Page } from "../../../src/plugins/wiki/src/types.js";

function getRbacCheck(): RbacCheckCapability {
  return rbacModule.provides?.["rbac:check"] as RbacCheckCapability;
}

/** Minimal in-memory fake — see this file's module doc for why the real db-backed store isn't needed here. */
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

const ENGINEERING_PAGE: Page = {
  id: 2,
  namespaceId: "engineering",
  slug: "runbook",
  title: "Runbook",
  content: "Internal only.",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

/** Seeds rbac's real, exported `policyStore` — mirrors `rbac/seeds/index.ts`'s default roles plus one namespace override. */
function seedRoles(): void {
  rbacModule.policyStore.rolePermissions.push(
    { roleId: "viewer", permissionId: "wiki:read" },
    { roleId: "editor", permissionId: "wiki:read" },
    { roleId: "editor", permissionId: "wiki:write" },
    { roleId: "admin", permissionId: "wiki:read" },
    { roleId: "admin", permissionId: "wiki:write" },
    { roleId: "admin", permissionId: "wiki:admin" },
    // Namespace override (step 2): "eng-contractor" gets write access
    // scoped to the "engineering" namespace only — narrower than a global
    // editor grant, and never assigned wiki:write globally.
    { roleId: "eng-contractor", permissionId: "wiki-engineering:write" },
  );
  rbacModule.policyStore.userRoles.push(
    { userId: "vera-viewer", roleId: "viewer" },
    { userId: "eddie-editor", roleId: "editor" },
    { userId: "amy-admin", roleId: "admin" },
    { userId: "carl-contractor", roleId: "eng-contractor" },
  );
}

describe("wiki RBAC integration (feature #93)", () => {
  beforeEach(() => {
    rbacModule.resetPolicyStoreForTests();
    seedRoles();
  });

  function buildStore() {
    return createAuthorizedWikiStore(
      createFakePagesStore([MAIN_PAGE, ENGINEERING_PAGE]),
      createFakeRevisionsStore(),
      getRbacCheck(),
    );
  }

  describe("read", () => {
    it("allows a viewer to read a page", async () => {
      const store = buildStore();
      await expect(store.getPageById("vera-viewer", MAIN_PAGE.id)).resolves.toMatchObject({
        id: MAIN_PAGE.id,
      });
    });

    it("allows an editor and an admin to read too (additive across role levels)", async () => {
      const store = buildStore();
      await expect(store.getPageById("eddie-editor", MAIN_PAGE.id)).resolves.toBeDefined();
      await expect(store.getPageById("amy-admin", MAIN_PAGE.id)).resolves.toBeDefined();
    });

    it("denies an unauthenticated caller (no userId) with AuthenticationError", async () => {
      const store = buildStore();
      await expect(store.getPageById(undefined, MAIN_PAGE.id)).rejects.toBeInstanceOf(
        AuthenticationError,
      );
    });

    it("denies a caller with no role at all with AuthorizationError", async () => {
      const store = buildStore();
      await expect(store.getPageById("nobody", MAIN_PAGE.id)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });

    it("denies read access even for a nonexistent page id, rather than leaking existence to an unauthorized caller", async () => {
      const store = buildStore();
      await expect(store.getPageById("nobody", 9999)).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("an authorized caller gets undefined (not an error) for a genuinely nonexistent page id", async () => {
      const store = buildStore();
      await expect(store.getPageById("vera-viewer", 9999)).resolves.toBeUndefined();
    });

    it("listPages scoped to a namespace only requires read on that namespace", async () => {
      const store = buildStore();
      await expect(store.listPages("vera-viewer", "main")).resolves.toHaveLength(1);
    });
  });

  describe("write", () => {
    it("denies a viewer from creating a page", async () => {
      const store = buildStore();
      await expect(
        store.createPage("vera-viewer", {
          namespaceId: "main",
          slug: "new-page",
          title: "New",
          content: "C",
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("allows an editor to create a page", async () => {
      const store = buildStore();
      await expect(
        store.createPage("eddie-editor", {
          namespaceId: "main",
          slug: "new-page",
          title: "New",
          content: "C",
        }),
      ).resolves.toMatchObject({ slug: "new-page" });
    });

    it("allows an editor to update an existing page", async () => {
      const store = buildStore();
      await expect(
        store.updatePage("eddie-editor", MAIN_PAGE.id, { title: "Updated" }),
      ).resolves.toMatchObject({ title: "Updated" });
    });

    it("denies a viewer from updating a page", async () => {
      const store = buildStore();
      await expect(
        store.updatePage("vera-viewer", MAIN_PAGE.id, { title: "Nope" }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("denies write access for an update on a nonexistent page id, rather than leaking existence", async () => {
      const store = buildStore();
      await expect(store.updatePage("vera-viewer", 9999, { title: "X" })).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });

    it("an authorized-but-nonexistent update surfaces NotFoundError, not an authorization error", async () => {
      const store = buildStore();
      await expect(store.updatePage("eddie-editor", 9999, { title: "X" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe("admin", () => {
    it("denies an editor from deleting a page (editor lacks wiki:admin)", async () => {
      const store = buildStore();
      await expect(store.deletePage("eddie-editor", ENGINEERING_PAGE.id)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });

    it("allows an admin to delete a page", async () => {
      const store = buildStore();
      await expect(store.deletePage("amy-admin", ENGINEERING_PAGE.id)).resolves.toBeUndefined();
    });
  });

  describe("namespace override (step 2)", () => {
    it("grants a contractor write access to the overridden namespace even without a global wiki:write grant", async () => {
      const store = buildStore();
      await expect(
        store.updatePage("carl-contractor", ENGINEERING_PAGE.id, { title: "Runbook v2" }),
      ).resolves.toMatchObject({ title: "Runbook v2" });
    });

    it("does not extend the contractor's override to a different namespace", async () => {
      const store = buildStore();
      await expect(
        store.updatePage("carl-contractor", MAIN_PAGE.id, { title: "Hijacked" }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("does not grant the contractor read access — the override permission only covers write", async () => {
      const store = buildStore();
      await expect(
        store.getPageById("carl-contractor", ENGINEERING_PAGE.id),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("a global editor's blanket wiki:write still covers the engineering namespace via the global-default fallback — the override adds access, it never takes any away", async () => {
      const store = buildStore();
      await expect(
        store.updatePage("eddie-editor", ENGINEERING_PAGE.id, { title: "Still works" }),
      ).resolves.toMatchObject({ title: "Still works" });
    });
  });
});

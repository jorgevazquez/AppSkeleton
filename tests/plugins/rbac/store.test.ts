/**
 * Unit tests for feature #42 ("Permission grammar validator rejects
 * malformed resource:action strings at every entry point"), as applied to
 * `store.ts` — the rbac plugin's persistence/management-layer boundary
 * (feature #34's data-access surface; the future feature #36 `rbac:manage`
 * management API is layered directly on top of it, per that feature's own
 * notes — see `store.ts`'s "Permission-grammar validation (feature #42)"
 * doc comment).
 *
 * Every {@link RbacStore} method that accepts a caller-supplied permission
 * identifier — `createPermission`'s `permission.id`, `getPermission`'s
 * `id`, and `assignPermissionToRole`'s `permissionId` — must reject a
 * malformed `resource:action` string with the same {@link ValidationError}
 * `permission.ts`'s `parsePermissionString` itself produces, and must do so
 * *before* ever reaching the database: `dbQuery.query` is a `vi.fn` here
 * that fails the test if invoked, so a passing "rejects" test also proves
 * validation short-circuits ahead of any query — no malformed permission
 * string can ever reach a `db:query` call, let alone get persisted.
 *
 * This deliberately does not need a real (or even fake) `Kysely<Database>`
 * — `RbacDbQueryCapability.query(fn)` is mocked at the top level (mirrors
 * `tests/plugins/database-mysql/query-capability.test.ts`'s `FAKE_DB`
 * precedent one level up: here the capability's `query` method itself is
 * the seam, since `fn`'s internal Kysely chain is irrelevant to whether
 * grammar validation ran).
 */
import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../../src/core/errors.js";
import {
  createRbacStore,
  type RbacDbQueryCapability,
} from "../../../src/plugins/rbac/src/store.js";

/** Every case `permission.test.ts` already exercises against the raw parser, reused here per-entry-point. */
const MALFORMED_PERMISSION_STRINGS: ReadonlyArray<[string, string]> = [
  ["empty string", ""],
  ["missing colon", "wikiread"],
  ["missing action", "wiki:"],
  ["missing resource", ":read"],
  ["double colon", "wiki::read"],
  ["extra segment", "wiki:read:extra"],
  ["uppercase resource", "Wiki:read"],
  ["uppercase action", "wiki:Read"],
  ["leading hyphen in resource", "-wiki:read"],
  ["trailing hyphen in action", "wiki:read-"],
  ["double hyphen", "wiki:re--ad"],
  ["leading digit in resource", "1wiki:read"],
  ["space in permission", "wiki: read"],
  ["underscore instead of hyphen", "user_profile:update"],
  ["wildcard action", "wiki:*"],
  ["wildcard resource", "*:read"],
  ["just a colon", ":"],
];

function createFakeStore() {
  const query = vi.fn(async () => {
    throw new Error("dbQuery.query must not be called for a malformed permission string");
  });
  const dbQuery = { query } as unknown as RbacDbQueryCapability;
  return { store: createRbacStore(dbQuery), query };
}

/**
 * Build a real `RbacDbQueryCapability` whose `query(fn)` actually invokes
 * `fn` against `fakeDb` — for the "accepts a well-formed id" happy-path
 * tests below, which need to prove validation does NOT block a valid
 * permission string from reaching the database. `fakeDb` only needs to
 * support whatever chain the method under test's `fn` calls (mirrors
 * `tests/plugins/database-mysql/query-capability.test.ts`'s `FAKE_DB`
 * precedent — an opaque stand-in `query()` never inspects itself).
 */
function createQueryCapability(fakeDb: unknown): {
  dbQuery: RbacDbQueryCapability;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (fn: (db: unknown) => Promise<unknown>) => fn(fakeDb));
  const dbQuery = { query } as unknown as RbacDbQueryCapability;
  return { dbQuery, query };
}

describe("RbacStore.createPermission — permission-grammar validation (feature #42)", () => {
  it.each(MALFORMED_PERMISSION_STRINGS)(
    "rejects %s (%j) without ever calling dbQuery.query",
    async (_description, badId) => {
      const { store, query } = createFakeStore();

      await expect(
        store.createPermission({ id: badId, resource: "wiki", action: "read" }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-string id", async () => {
    const { store, query } = createFakeStore();

    await expect(
      store.createPermission({
        id: 42 as unknown as string,
        resource: "wiki",
        action: "read",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(query).not.toHaveBeenCalled();
  });

  it("attaches the offending input to the thrown error's details, like the raw parser does", async () => {
    const { store } = createFakeStore();

    try {
      await store.createPermission({ id: "not-valid", resource: "wiki", action: "read" });
      expect.fail("expected createPermission to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details?.["input"]).toBe("not-valid");
    }
  });

  it("accepts a well-formed id and persists the parser-derived resource/action, not the caller's", async () => {
    const inserted: unknown[] = [];
    const fakeDb = {
      insertInto: () => ({
        values: (row: unknown) => {
          inserted.push(row);
          return { execute: async () => undefined };
        },
      }),
    };
    const { dbQuery, query } = createQueryCapability(fakeDb);
    const store = createRbacStore(dbQuery);

    // A hand-built Permission literal whose resource/action disagree with
    // its own id — exactly what toPermission()'s invariant guards against —
    // must still persist the id's own parsed segments, not the caller's.
    await store.createPermission({ id: "wiki:read", resource: "bogus", action: "nope" });

    expect(query).toHaveBeenCalledTimes(1);
    expect(inserted).toEqual([
      { id: "wiki:read", resource: "wiki", action: "read", description: null },
    ]);
  });
});

describe("RbacStore.getPermission — permission-grammar validation (feature #42)", () => {
  it.each(MALFORMED_PERMISSION_STRINGS)(
    "rejects %s (%j) without ever calling dbQuery.query",
    async (_description, badId) => {
      const { store, query } = createFakeStore();

      await expect(store.getPermission(badId)).rejects.toBeInstanceOf(ValidationError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("accepts a well-formed id and returns undefined when no row is found", async () => {
    const fakeDb = {
      selectFrom: () => ({
        selectAll: () => ({
          where: () => ({
            executeTakeFirst: async () => undefined,
          }),
        }),
      }),
    };
    const { dbQuery, query } = createQueryCapability(fakeDb);
    const store = createRbacStore(dbQuery);

    await expect(store.getPermission("wiki:read")).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("RbacStore.assignPermissionToRole — permission-grammar validation (feature #42)", () => {
  it.each(MALFORMED_PERMISSION_STRINGS)(
    "rejects %s (%j) without ever calling dbQuery.query",
    async (_description, badPermissionId) => {
      const { store, query } = createFakeStore();

      await expect(
        store.assignPermissionToRole("wiki-editor", badPermissionId),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("leaves roleId's own validity untouched — a malformed permissionId is rejected regardless of roleId", async () => {
    const { store, query } = createFakeStore();

    await expect(store.assignPermissionToRole("", "not-valid")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts a well-formed permissionId and reaches the database", async () => {
    const fakeDb = {
      insertInto: () => ({
        values: () => ({ execute: async () => undefined }),
      }),
    };
    const { dbQuery, query } = createQueryCapability(fakeDb);
    const store = createRbacStore(dbQuery);

    await expect(store.assignPermissionToRole("wiki-editor", "wiki:read")).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

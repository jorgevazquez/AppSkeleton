/**
 * Unit tests for seed.ts's pure/registry logic — no MySQL required (see
 * tests/plugins/database-mysql/seed.integration.test.ts for the full
 * runSeeds() idempotency suite against real dockerized MySQL). Mirrors
 * migrator.test.ts's split between pure-logic unit tests and a Docker-backed
 * integration suite.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SeedError } from "../../src/core/errors.js";
import {
  assertSeedingAllowed,
  clearSeedRegistryForTests,
  listRegisteredSeeds,
  planPendingSeeds,
  registerSeed,
  seedKey,
  type AppliedSeedRow,
  type SeedRegistration,
} from "../../src/core/seed.js";

afterEach(() => {
  clearSeedRegistryForTests();
});

describe("seedKey", () => {
  it("joins pluginId and name with a colon", () => {
    expect(seedKey("rbac", "default-roles")).toBe("rbac:default-roles");
  });
});

describe("registerSeed / listRegisteredSeeds / clearSeedRegistryForTests", () => {
  it("registers a seed and makes it visible via listRegisteredSeeds", async () => {
    const run = async () => {};
    registerSeed("rbac", "default-roles", run);

    const seeds = listRegisteredSeeds();
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      key: "rbac:default-roles",
      pluginId: "rbac",
      name: "default-roles",
    });
    expect(seeds[0]?.run).toBe(run);
  });

  it("returns seeds sorted by key for a deterministic run order", async () => {
    registerSeed("wiki", "home-page", async () => {});
    registerSeed("rbac", "default-roles", async () => {});
    registerSeed("rbac", "aardvark", async () => {});

    expect(listRegisteredSeeds().map((s) => s.key)).toEqual([
      "rbac:aardvark",
      "rbac:default-roles",
      "wiki:home-page",
    ]);
  });

  it("throws SeedError when the same pluginId:name is registered twice", () => {
    registerSeed("rbac", "default-roles", async () => {});

    expect(() => registerSeed("rbac", "default-roles", async () => {})).toThrow(SeedError);
    try {
      registerSeed("rbac", "default-roles", async () => {});
      expect.unreachable("expected registerSeed to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SeedError);
      const seedError = error as SeedError;
      expect(seedError.code).toBe("SEED_ERROR");
      expect(seedError.message).toContain("rbac:default-roles");
      expect(seedError.details).toMatchObject({
        pluginId: "rbac",
        name: "default-roles",
        reason: "duplicate_seed",
      });
    }
  });

  it("allows two different plugins to register a seed with the same name (no cross-plugin collision)", () => {
    expect(() => {
      registerSeed("rbac", "defaults", async () => {});
      registerSeed("wiki", "defaults", async () => {});
    }).not.toThrow();
    expect(listRegisteredSeeds().map((s) => s.key)).toEqual(["rbac:defaults", "wiki:defaults"]);
  });

  it("clearSeedRegistryForTests empties the registry", () => {
    registerSeed("rbac", "default-roles", async () => {});
    expect(listRegisteredSeeds()).toHaveLength(1);

    clearSeedRegistryForTests();

    expect(listRegisteredSeeds()).toEqual([]);
  });

  it("a seed name freed by clearSeedRegistryForTests can be re-registered", () => {
    registerSeed("rbac", "default-roles", async () => {});
    clearSeedRegistryForTests();

    expect(() => registerSeed("rbac", "default-roles", async () => {})).not.toThrow();
  });
});

function seedRegistration(key: string): SeedRegistration {
  const [pluginId = "", name = ""] = key.split(":");
  return { key, pluginId, name, run: async () => {} };
}

function appliedRow(name: string): AppliedSeedRow {
  return { id: 1, name, applied_at: new Date() };
}

describe("planPendingSeeds", () => {
  it("returns every seed when nothing has been applied yet", () => {
    const seeds = [seedRegistration("rbac:a"), seedRegistration("rbac:b")];
    expect(planPendingSeeds(seeds, [])).toEqual(seeds);
  });

  it("excludes already-applied seeds by key", () => {
    const seeds = [seedRegistration("rbac:a"), seedRegistration("rbac:b")];
    const applied = [appliedRow("rbac:a")];
    expect(planPendingSeeds(seeds, applied).map((s) => s.key)).toEqual(["rbac:b"]);
  });

  it("returns an empty list when every seed is already applied — the idempotency guarantee at the planning level", () => {
    const seeds = [seedRegistration("rbac:a"), seedRegistration("rbac:b")];
    const applied = [appliedRow("rbac:a"), appliedRow("rbac:b")];
    expect(planPendingSeeds(seeds, applied)).toEqual([]);
  });

  it("ignores applied rows that no longer correspond to any registered seed", () => {
    const seeds = [seedRegistration("rbac:a")];
    const applied = [appliedRow("rbac:a"), appliedRow("wiki:stale-seed-no-longer-registered")];
    expect(planPendingSeeds(seeds, applied).map((s) => s.key)).toEqual([]);
  });
});

describe("assertSeedingAllowed", () => {
  it("throws SeedError when nodeEnv is production", () => {
    expect(() => assertSeedingAllowed("production")).toThrow(SeedError);
    try {
      assertSeedingAllowed("production");
      expect.unreachable("expected assertSeedingAllowed to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SeedError);
      const seedError = error as SeedError;
      expect(seedError.code).toBe("SEED_ERROR");
      expect(seedError.details).toMatchObject({
        nodeEnv: "production",
        reason: "production_environment",
      });
      // Never leaks via the safe, API-facing message.
      expect(seedError.publicMessage).not.toContain("production");
    }
  });

  it("does not throw for development", () => {
    expect(() => assertSeedingAllowed("development")).not.toThrow();
  });

  it("does not throw for test", () => {
    expect(() => assertSeedingAllowed("test")).not.toThrow();
  });

  it("does not throw when nodeEnv is undefined", () => {
    expect(() => assertSeedingAllowed(undefined)).not.toThrow();
  });
});

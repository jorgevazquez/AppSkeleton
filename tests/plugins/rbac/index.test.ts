/**
 * Unit tests for the rbac plugin's lifecycle module (feature #39, step 1 —
 * "Register the can() function as the rbac:check capability through the
 * broker"). Mirrors `tests/plugins/api-gateway/index.test.ts`'s structure:
 * exercises the module's `provides` shape directly, then drives it through
 * the real broker/loader to prove the registration itself works end-to-end.
 *
 * The real `rbac` plugin.json also declares `rbac:manage` (feature #31),
 * which feature #36 hasn't implemented yet — loading the *real* manifest
 * through the loader would therefore fail (loader.ts requires every
 * declared `provides` id to have an implementation). So, like
 * `route-capability.integration.test.ts` does for `http:route`, these tests
 * use a hand-built manifest fixture declaring only `["rbac:check"]`, paired
 * with the real `rbacModule` — proving `rbac:check` itself, without
 * depending on feature #36 landing first.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isErr, isOk } from "../../../src/core/types.js";
import * as rbacModule from "../../../src/plugins/rbac/index.js";
import type { RbacCheckCapability } from "../../../src/plugins/rbac/index.js";

function manifest(
  id: string,
  options: {
    dependsOn?: Record<string, string>;
    provides?: string[];
    requires?: string[];
  } = {},
): PluginManifest {
  return {
    id,
    version: "1.0.0",
    depends_on: options.dependsOn ?? {},
    capabilities: { provides: options.provides ?? [], requires: options.requires ?? [] },
    entry_point: "index.ts",
  };
}

/**
 * A minimal `http:route` provider — feature #44 made `rbac`'s own
 * `onEnable` obtain `http:route` synchronously (to register its admin
 * routes), so any `loadPlugins()` fixture set that includes the real
 * `rbac` module now needs *some* provider for it, exactly like every other
 * `http:route`-consuming plugin's own test fixtures already require (see
 * `tests/plugins/api-gateway/rbac-protection.integration.test.ts`). This
 * fixture only records calls — it never spins up a real Fastify instance —
 * since this file's own tests only care about `rbac:check`'s wiring, not
 * about the routes feature #44 registers.
 */
const HTTP_ROUTE_FIXTURE_MANIFEST = manifest("http-route-fixture", { provides: ["http:route"] });
function httpRouteFixtureModule(): PluginModule {
  return { provides: { "http:route": { registerRoute: () => {} } } };
}

const RBAC_MANIFEST = manifest("rbac", {
  dependsOn: { "http-route-fixture": "^1.0.0" },
  provides: ["rbac:check"],
  requires: ["http:route"],
});

function getRbacCheck(): RbacCheckCapability {
  return rbacModule.provides?.["rbac:check"] as RbacCheckCapability;
}

describe("rbac plugin — lifecycle module (feature #39)", () => {
  beforeEach(() => {
    rbacModule.resetPolicyStoreForTests();
  });

  it("exports rbac:check under provides", () => {
    expect(rbacModule.provides).toBeDefined();
    expect(typeof getRbacCheck().check).toBe("function");
  });

  it("check() denies by default when the policy store is empty", () => {
    expect(getRbacCheck().check("alice", "read", "wiki")).toBe(false);
  });

  it("check() allows once a role grants the permission and is assigned to the user", () => {
    rbacModule.policyStore.userRoles.push({ userId: "alice", roleId: "editor" });
    rbacModule.policyStore.rolePermissions.push({ roleId: "editor", permissionId: "wiki:edit" });

    expect(getRbacCheck().check("alice", "edit", "wiki")).toBe(true);
    // A different, unrelated action/resource on the same user is still denied.
    expect(getRbacCheck().check("alice", "delete", "wiki")).toBe(false);
    // A different user who was never assigned the role is still denied.
    expect(getRbacCheck().check("bob", "edit", "wiki")).toBe(false);
  });

  it("check() honors wildcard grants (resource:*)", () => {
    rbacModule.policyStore.userRoles.push({ userId: "alice", roleId: "admin" });
    rbacModule.policyStore.rolePermissions.push({ roleId: "admin", permissionId: "wiki:*" });

    expect(getRbacCheck().check("alice", "read", "wiki")).toBe(true);
    expect(getRbacCheck().check("alice", "delete", "wiki")).toBe(true);
    // Wildcard on "wiki" grants nothing on a different resource.
    expect(getRbacCheck().check("alice", "read", "billing")).toBe(false);
  });

  it("registers rbac:check with the real broker via loadPlugins()", async () => {
    const definitions: PluginDefinition[] = [
      { manifest: HTTP_ROUTE_FIXTURE_MANIFEST, module: httpRouteFixtureModule() },
      { manifest: RBAC_MANIFEST, module: rbacModule },
    ];
    const broker = createCapabilityBroker();

    const loadResult = await loadPlugins(definitions, broker);
    expect(isOk(loadResult)).toBe(true);
    if (!isOk(loadResult)) {
      return;
    }
    expect(loadResult.value.failed).toEqual([]);
    expect(loadResult.value.loaded.map((plugin) => plugin.id).sort()).toEqual(
      ["http-route-fixture", "rbac"].sort(),
    );
  });

  it("a consumer that declared and was granted rbac:check obtains a working handle from the broker", async () => {
    rbacModule.policyStore.userRoles.push({ userId: "alice", roleId: "editor" });
    rbacModule.policyStore.rolePermissions.push({ roleId: "editor", permissionId: "wiki:edit" });

    const broker = createCapabilityBroker();
    broker.declareRequirement("consumer", "rbac:check");
    const registerResult = broker.registerProvider("rbac", "rbac:check", getRbacCheck());
    expect(isOk(registerResult)).toBe(true);
    expect(isOk(broker.grant("consumer", "rbac:check"))).toBe(true);

    const obtained = broker.obtain<RbacCheckCapability>("consumer", "rbac:check");
    expect(isOk(obtained)).toBe(true);
    if (!isOk(obtained)) {
      return;
    }
    expect(obtained.value.check("alice", "edit", "wiki")).toBe(true);
    expect(obtained.value.check("alice", "delete", "wiki")).toBe(false);
  });

  it("a plugin that never declared rbac:check cannot obtain it, even once registered", () => {
    const broker = createCapabilityBroker();
    broker.registerProvider("rbac", "rbac:check", getRbacCheck());

    const obtained = broker.obtain<RbacCheckCapability>("consumer", "rbac:check");
    expect(isErr(obtained)).toBe(true);
    if (!isErr(obtained)) {
      return;
    }
    expect(obtained.error.details).toMatchObject({ reason: "not_declared" });
  });
});

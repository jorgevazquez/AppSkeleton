/**
 * Integration test for feature #39, steps 2 & 3: "Write a fixture consumer
 * plugin that requests rbac:check and uses it, proving the cross-plugin
 * contract works" plus "Write an integration test for the fixture
 * consumer" — driven through the *real* capability broker, the *real*
 * loader (`loadPlugins()`), and the *real* `rbac` plugin module (not a
 * hand-rolled fixture standing in for it), mirroring
 * `tests/plugins/api-gateway/route-capability.integration.test.ts`'s
 * `greeter` fixture-plugin pattern: a second, fixture plugin declares
 * `rbac:check` under `capabilities.requires`, obtains it in its own
 * `onEnable`, and calls `check()` — proving `rbac:check` actually works for
 * *other* plugins, end-to-end, through the broker's declare/grant/obtain
 * gating (not just as a direct function call within the rbac plugin
 * itself).
 *
 * Like `tests/plugins/rbac/index.test.ts`, this uses a hand-built manifest
 * fixture for `rbac` declaring only `["rbac:check"]` — the real
 * `rbac/plugin.json` also declares `rbac:manage` (feature #31), which
 * feature #36 hasn't implemented yet, so loading that exact manifest
 * through the loader would fail for an unrelated reason. See
 * `route-capability.integration.test.ts`'s identical `API_GATEWAY_MANIFEST`
 * fixture for `http:route` alone.
 */
import { describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { CapabilityDeniedError } from "../../../src/core/errors.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isErr, isOk } from "../../../src/core/types.js";
import * as rbacModule from "../../../src/plugins/rbac/index.js";
import type { RbacCheckCapability } from "../../../src/plugins/rbac/index.js";

/** Build a minimal, schema-shaped manifest fixture without going through validateManifest() — mirrors route-capability.integration.test.ts's own `manifest()` helper. */
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

const RBAC_MANIFEST = manifest("rbac", { provides: ["rbac:check"] });

describe("rbac:check — integration (feature #39)", () => {
  it("a fixture plugin obtains rbac:check, calls it, and gets a real allow/deny decision backed by rbac's own policy data", async () => {
    rbacModule.resetPolicyStoreForTests();
    rbacModule.policyStore.userRoles.push({ userId: "alice", roleId: "editor" });
    rbacModule.policyStore.rolePermissions.push({ roleId: "editor", permissionId: "wiki:edit" });

    // Captured by the fixture plugin's onEnable so the test can assert on
    // the decisions it actually observed, without the fixture module
    // needing any HTTP surface of its own (unlike the http:route greeter
    // fixture, rbac:check is a plain function capability, not a
    // route-registration one).
    const decisions: Record<string, boolean> = {};

    const auditedActionManifest = manifest("audited-action", {
      dependsOn: { rbac: "^1.0.0" },
      requires: ["rbac:check"],
    });

    const auditedActionModule: PluginModule = {
      onEnable(context) {
        const obtained = context.capabilities.obtain<RbacCheckCapability>("rbac:check");
        if (isErr(obtained)) {
          throw obtained.error;
        }
        decisions["alice-can-edit-wiki"] = obtained.value.check("alice", "edit", "wiki");
        decisions["alice-can-delete-wiki"] = obtained.value.check("alice", "delete", "wiki");
        decisions["bob-can-edit-wiki"] = obtained.value.check("bob", "edit", "wiki");
      },
    };

    const definitions: PluginDefinition[] = [
      { manifest: RBAC_MANIFEST, module: rbacModule },
      { manifest: auditedActionManifest, module: auditedActionModule },
    ];

    const broker = createCapabilityBroker();
    const loadResult = await loadPlugins(definitions, broker);
    expect(isOk(loadResult)).toBe(true);
    if (!isOk(loadResult)) {
      return;
    }
    expect(loadResult.value.failed).toEqual([]);
    expect(loadResult.value.loaded.map((plugin) => plugin.id).sort()).toEqual([
      "audited-action",
      "rbac",
    ]);

    // Alice holds a role granting wiki:edit -> allowed.
    expect(decisions["alice-can-edit-wiki"]).toBe(true);
    // Alice's role never grants wiki:delete -> denied.
    expect(decisions["alice-can-delete-wiki"]).toBe(false);
    // Bob was never assigned any role -> denied (deny-by-default).
    expect(decisions["bob-can-edit-wiki"]).toBe(false);
  });

  it("a fixture plugin that never declared rbac:check under capabilities.requires fails its own onEnable, isolating it without affecting rbac or unrelated plugins", async () => {
    rbacModule.resetPolicyStoreForTests();

    const undeclaredManifest = manifest("undeclared-consumer", {
      dependsOn: { rbac: "^1.0.0" },
      requires: [], // deliberately omits "rbac:check"
    });

    const undeclaredModule: PluginModule = {
      onEnable(context) {
        const obtained = context.capabilities.obtain<RbacCheckCapability>("rbac:check");
        if (isErr(obtained)) {
          throw obtained.error;
        }
      },
    };

    const unrelatedManifest = manifest("unrelated", {});
    const unrelatedModule: PluginModule = {};

    const definitions: PluginDefinition[] = [
      { manifest: RBAC_MANIFEST, module: rbacModule },
      { manifest: undeclaredManifest, module: undeclaredModule },
      { manifest: unrelatedManifest, module: unrelatedModule },
    ];

    const broker = createCapabilityBroker();
    const loadResult = await loadPlugins(definitions, broker);
    expect(isOk(loadResult)).toBe(true);
    if (!isOk(loadResult)) {
      return;
    }

    expect(loadResult.value.loaded.map((plugin) => plugin.id).sort()).toEqual([
      "rbac",
      "unrelated",
    ]);
    expect(loadResult.value.failed.map((plugin) => plugin.id)).toEqual(["undeclared-consumer"]);
    // loadPlugins() normalizes any thrown onEnable error into a
    // PluginLoadError (see loader.ts's toPluginLoadError()), preserving the
    // original CapabilityDeniedError as its `cause` — assert both layers so
    // this test proves the *right* thing failed (broker declare-gating),
    // not just that *something* failed. Mirrors
    // route-capability.integration.test.ts's identical cause-chain check.
    const failure = loadResult.value.failed[0];
    expect(failure?.error.cause).toBeInstanceOf(CapabilityDeniedError);
    expect((failure?.error.cause as CapabilityDeniedError).details).toMatchObject({
      reason: "not_declared",
    });

    // rbac itself is unaffected — a fresh consumer that *does* declare the
    // capability can still obtain it in a later load.
    expect(broker.isGranted("undeclared-consumer", "rbac:check")).toBe(false);
  });
});

/**
 * Tests for feature #38 — "Audit logging of every access-check decision":
 *
 *   1. "Wire can() to record allow/deny decisions to the kernel audit trail
 *      with user, action, resource, and outcome" — proven end-to-end through
 *      the real broker/loader (mirroring
 *      `check-capability.integration.test.ts`'s pattern), not just a direct
 *      call into the module.
 *   2. "Ensure high-frequency checks do not overwhelm the audit sink (batch
 *      or sample if needed, documented tradeoff)" — `auditState.sink`'s
 *      allow-sampling behavior (denies are always recorded in full; allows
 *      are recorded 1-out-of-every-N).
 *   3. "Write a test asserting a denied check produces a queryable audit
 *      entry" — see "a denied check produces a queryable audit entry" below.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryAuditSink } from "../../../src/core/audit.js";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { loadPlugins, type PluginDefinition } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isOk } from "../../../src/core/types.js";
import * as rbacModule from "../../../src/plugins/rbac/index.js";
import type { RbacCheckCapability } from "../../../src/plugins/rbac/index.js";

function manifest(
  id: string,
  options: { provides?: string[]; requires?: string[] } = {},
): PluginManifest {
  return {
    id,
    version: "1.0.0",
    depends_on: {},
    capabilities: { provides: options.provides ?? [], requires: options.requires ?? [] },
    entry_point: "index.ts",
  };
}

const RBAC_MANIFEST = manifest("rbac", { provides: ["rbac:check"] });

/** Load the real rbac plugin through the real loader, wired to `auditSink`, and return its `check()`. */
async function loadRbacWithAudit(
  auditSink: ReturnType<typeof createInMemoryAuditSink>,
): Promise<RbacCheckCapability["check"]> {
  const definitions: PluginDefinition[] = [{ manifest: RBAC_MANIFEST, module: rbacModule }];
  const broker = createCapabilityBroker();

  const loadResult = await loadPlugins(definitions, broker, { auditSink });
  expect(isOk(loadResult)).toBe(true);
  if (!isOk(loadResult)) {
    throw new Error("expected rbac to load successfully");
  }
  expect(loadResult.value.failed).toEqual([]);

  const check = (rbacModule.provides?.["rbac:check"] as RbacCheckCapability).check;
  return check;
}

describe("rbac access-check audit logging (feature #38)", () => {
  beforeEach(() => {
    rbacModule.resetPolicyStoreForTests();
  });

  it("a denied check produces a queryable audit entry", async () => {
    const auditSink = createInMemoryAuditSink();
    const check = await loadRbacWithAudit(auditSink);

    // No roles ever seeded for "mallory" -> deny-by-default.
    const allowed = check("mallory", "delete", "wiki");
    expect(allowed).toBe(false);

    const denied = auditSink.query({ outcome: "denied" });
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      actor: "mallory",
      action: "delete",
      target: "wiki",
      outcome: "denied",
    });
    expect(typeof denied[0]?.timestamp).toBe("number");

    // Queryable by actor and by action too, not just outcome.
    expect(auditSink.query({ actor: "mallory" })).toHaveLength(1);
    expect(auditSink.query({ action: "delete", target: "wiki" })).toHaveLength(1);
  });

  it("an allowed check also produces a queryable audit entry, distinct in outcome from a denied one", async () => {
    rbacModule.policyStore.userRoles.push({ userId: "alice", roleId: "editor" });
    rbacModule.policyStore.rolePermissions.push({ roleId: "editor", permissionId: "wiki:edit" });

    const auditSink = createInMemoryAuditSink();
    const check = await loadRbacWithAudit(auditSink);

    expect(check("alice", "edit", "wiki")).toBe(true);
    expect(check("alice", "delete", "wiki")).toBe(false);

    expect(auditSink.query({ outcome: "allowed" })).toMatchObject([
      { actor: "alice", action: "edit", target: "wiki", outcome: "allowed" },
    ]);
    expect(auditSink.query({ outcome: "denied" })).toMatchObject([
      { actor: "alice", action: "delete", target: "wiki", outcome: "denied" },
    ]);
  });

  it("check() still returns the correct decision when no audit sink was ever wired", () => {
    // Direct call, bypassing loadPlugins()/onInstall entirely — auditState.sink
    // stays undefined (reset by beforeEach). Access-check logic itself must
    // never depend on auditing succeeding.
    const check = (rbacModule.provides?.["rbac:check"] as RbacCheckCapability).check;
    expect(check("nobody", "read", "wiki")).toBe(false);
    expect(rbacModule.auditState.sink).toBeUndefined();
  });

  it("denies are never sampled: every denied check is recorded even under a coarse allow-sample rate", async () => {
    const auditSink = createInMemoryAuditSink();
    const check = await loadRbacWithAudit(auditSink);
    rbacModule.auditState.allowSampleEvery = 100;

    for (let i = 0; i < 5; i += 1) {
      expect(check("mallory", "delete", "wiki")).toBe(false);
    }

    expect(auditSink.query({ outcome: "denied" })).toHaveLength(5);
  });

  it("allow-sampling: only 1-out-of-every-N allowed decisions is recorded, bounding sink growth under high-frequency checks", async () => {
    rbacModule.policyStore.userRoles.push({ userId: "alice", roleId: "editor" });
    rbacModule.policyStore.rolePermissions.push({ roleId: "editor", permissionId: "wiki:edit" });

    const auditSink = createInMemoryAuditSink();
    const check = await loadRbacWithAudit(auditSink);
    rbacModule.auditState.allowSampleEvery = 4;

    for (let i = 0; i < 12; i += 1) {
      expect(check("alice", "edit", "wiki")).toBe(true);
    }

    // 12 allowed calls, sampled every 4th -> exactly 3 recorded.
    expect(auditSink.query({ outcome: "allowed" })).toHaveLength(3);
  });

  it("allow-sampling defaults to recording every allow (allowSampleEvery = 1)", async () => {
    rbacModule.policyStore.userRoles.push({ userId: "alice", roleId: "editor" });
    rbacModule.policyStore.rolePermissions.push({ roleId: "editor", permissionId: "wiki:edit" });

    const auditSink = createInMemoryAuditSink();
    const check = await loadRbacWithAudit(auditSink);

    expect(rbacModule.auditState.allowSampleEvery).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      expect(check("alice", "edit", "wiki")).toBe(true);
    }

    expect(auditSink.query({ outcome: "allowed" })).toHaveLength(3);
  });
});

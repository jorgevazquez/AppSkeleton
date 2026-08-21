import { describe, expect, it } from "vitest";
import { createInMemoryAuditSink, type AuditEvent } from "../../src/core/audit.js";
import { createCapabilityBroker } from "../../src/core/broker.js";
import {
  auditCapabilityUsage,
  formatCapabilityAuditReport,
  isCapabilityAuditReportClean,
} from "../../src/core/capability-audit.js";
import type { PluginManifest } from "../../src/core/manifest.js";
import { isOk } from "../../src/core/types.js";

function manifest(
  id: string,
  options: { requires?: string[]; provides?: string[] } = {},
): PluginManifest {
  return {
    id,
    version: "1.0.0",
    depends_on: {},
    capabilities: { provides: options.provides ?? [], requires: options.requires ?? [] },
    entry_point: "index.ts",
  };
}

function obtainedEvent(actor: string, target: string, outcome: string): AuditEvent {
  return { actor, action: "capability:obtain", target, outcome, timestamp: 0 };
}

describe("auditCapabilityUsage", () => {
  it("reports a plugin clean when every declared capability was observed in use", () => {
    const manifests = [manifest("wiki", { requires: ["db:query", "rbac:check"] })];
    const events = [
      obtainedEvent("wiki", "db:query", "granted"),
      obtainedEvent("wiki", "rbac:check", "granted"),
    ];

    const report = auditCapabilityUsage(manifests, events);

    expect(report.plugins).toEqual([
      {
        pluginId: "wiki",
        declared: ["db:query", "rbac:check"],
        used: ["db:query", "rbac:check"],
        overPrivileged: [],
        impossibleUsage: [],
        acknowledgedOverPrivileged: [],
      },
    ]);
    expect(isCapabilityAuditReportClean(report)).toBe(true);
  });

  it("flags a declared-but-never-obtained capability as over-privileged", () => {
    const manifests = [
      manifest("api-gateway", { requires: ["rbac:check", "render:template", "html:error-pages"] }),
    ];
    const events = [
      obtainedEvent("api-gateway", "rbac:check", "granted"),
      obtainedEvent("api-gateway", "html:error-pages", "granted"),
      // render:template is declared but this plugin is never observed
      // obtaining it — see scripts/capability-audit.ts's own findings.
    ];

    const report = auditCapabilityUsage(manifests, events);

    expect(report.plugins[0]?.overPrivileged).toEqual(["render:template"]);
    expect(report.plugins[0]?.impossibleUsage).toEqual([]);
    expect(isCapabilityAuditReportClean(report)).toBe(false);
  });

  it("ignores denied capability:obtain events — only a granted obtain counts as used", () => {
    const manifests = [manifest("wiki", { requires: ["db:query"] })];
    const events = [obtainedEvent("wiki", "db:query", "denied")];

    const report = auditCapabilityUsage(manifests, events);

    expect(report.plugins[0]?.used).toEqual([]);
    expect(report.plugins[0]?.overPrivileged).toEqual(["db:query"]);
  });

  it("ignores audit events for actions other than capability:obtain", () => {
    const manifests = [manifest("wiki", { requires: ["db:query"] })];
    const events: AuditEvent[] = [
      {
        actor: "wiki",
        action: "capability:grant",
        target: "db:query",
        outcome: "granted",
        timestamp: 0,
      },
    ];

    const report = auditCapabilityUsage(manifests, events);

    expect(report.plugins[0]?.used).toEqual([]);
    expect(report.plugins[0]?.overPrivileged).toEqual(["db:query"]);
  });

  it("flags a used-but-undeclared capability as impossibleUsage — should be unreachable given broker.ts's construction, but is still detected defensively", () => {
    const manifests = [manifest("wiki", { requires: ["db:query"] })];
    // A real broker (see the "wired against a real broker" test below) can
    // never actually produce this shape — obtain() denies with
    // "not_declared" before recording a "granted" event for an undeclared
    // capability. This directly, syntheticly, feeds the comparison
    // function a shape the broker's own construction rules out, to prove
    // the audit's detection code path itself is correct and would catch a
    // violation of that invariant if one ever slipped through.
    const events = [obtainedEvent("wiki", "some:undeclared-capability", "granted")];

    const report = auditCapabilityUsage(manifests, events);

    expect(report.plugins[0]?.impossibleUsage).toEqual(["some:undeclared-capability"]);
    expect(isCapabilityAuditReportClean(report)).toBe(false);
  });

  it("acknowledged over-privileged findings still appear in the report but do not make it unclean", () => {
    const manifests = [manifest("api-gateway", { requires: ["rbac:check", "render:template"] })];
    const events = [obtainedEvent("api-gateway", "rbac:check", "granted")];

    const unacknowledged = auditCapabilityUsage(manifests, events);
    expect(isCapabilityAuditReportClean(unacknowledged)).toBe(false);

    const acknowledged = auditCapabilityUsage(manifests, events, {
      acknowledgedOverPrivileged: { "api-gateway": ["render:template"] },
    });
    expect(acknowledged.plugins[0]?.overPrivileged).toEqual(["render:template"]);
    expect(acknowledged.plugins[0]?.acknowledgedOverPrivileged).toEqual(["render:template"]);
    expect(isCapabilityAuditReportClean(acknowledged)).toBe(true);
  });

  it("an acknowledged id that isn't actually over-privileged has no effect", () => {
    const manifests = [manifest("wiki", { requires: ["db:query"] })];
    const events = [obtainedEvent("wiki", "db:query", "granted")];

    const report = auditCapabilityUsage(manifests, events, {
      acknowledgedOverPrivileged: { wiki: ["db:query"] },
    });

    expect(report.plugins[0]?.overPrivileged).toEqual([]);
    expect(report.plugins[0]?.acknowledgedOverPrivileged).toEqual([]);
  });

  it("a plugin with no declared capabilities is always clean, regardless of other plugins' activity", () => {
    const manifests = [manifest("hello-world"), manifest("wiki", { requires: ["db:query"] })];
    const events = [obtainedEvent("wiki", "db:query", "granted")];

    const report = auditCapabilityUsage(manifests, events);

    expect(report.plugins[0]).toMatchObject({ pluginId: "hello-world", declared: [], used: [] });
    expect(isCapabilityAuditReportClean(report)).toBe(true);
  });

  it("attributes used capabilities per-plugin — one plugin's obtain never counts toward another's declared set", () => {
    const manifests = [
      manifest("wiki", { requires: ["db:query"] }),
      manifest("rbac", { requires: ["http:route"] }),
    ];
    const events = [
      obtainedEvent("wiki", "db:query", "granted"),
      obtainedEvent("rbac", "http:route", "granted"),
    ];

    const report = auditCapabilityUsage(manifests, events);

    const wiki = report.plugins.find((p) => p.pluginId === "wiki");
    const rbac = report.plugins.find((p) => p.pluginId === "rbac");
    expect(wiki?.used).toEqual(["db:query"]);
    expect(rbac?.used).toEqual(["http:route"]);
    expect(isCapabilityAuditReportClean(report)).toBe(true);
  });

  it("wired against a real broker: obtained capabilities show as used, denied/undeclared attempts never do", () => {
    const auditSink = createInMemoryAuditSink();
    const broker = createCapabilityBroker({ auditSink });

    broker.declareRequirements("wiki", ["db:query", "render:template", "rbac:check"]);
    expect(isOk(broker.registerProvider("database-mysql", "db:query", () => "db"))).toBe(true);
    expect(isOk(broker.registerProvider("html-renderer", "render:template", () => "html"))).toBe(
      true,
    );
    // rbac:check is declared and granted, but this plugin never actually
    // calls obtain() for it in this scenario — the over-privileged case.
    expect(isOk(broker.grant("wiki", "db:query"))).toBe(true);
    expect(isOk(broker.grant("wiki", "render:template"))).toBe(true);
    expect(isOk(broker.grant("wiki", "rbac:check"))).toBe(true);

    const wikiAccess = broker.forPlugin("wiki");
    expect(isOk(wikiAccess.obtain("db:query"))).toBe(true);
    expect(isOk(wikiAccess.obtain("render:template"))).toBe(true);
    // A plugin cannot obtain something it never declared — broker.ts's own
    // construction — so this attempt is denied and never counts as "used".
    expect(isOk(broker.forPlugin("other-plugin").obtain("db:query"))).toBe(false);

    const manifests = [
      manifest("wiki", { requires: ["db:query", "render:template", "rbac:check"] }),
    ];
    const report = auditCapabilityUsage(manifests, auditSink.all());

    expect(report.plugins[0]?.used).toEqual(["db:query", "render:template"]);
    expect(report.plugins[0]?.overPrivileged).toEqual(["rbac:check"]);
    expect(report.plugins[0]?.impossibleUsage).toEqual([]);
  });
});

describe("formatCapabilityAuditReport", () => {
  it("renders a human-readable report naming over-privileged and impossible findings", () => {
    const manifests = [manifest("api-gateway", { requires: ["rbac:check", "render:template"] })];
    const events = [obtainedEvent("api-gateway", "rbac:check", "granted")];

    const text = formatCapabilityAuditReport(auditCapabilityUsage(manifests, events));

    expect(text).toContain("api-gateway:");
    expect(text).toContain("OVER-PRIVILEGED (declared, never obtained): render:template");
    expect(text).not.toContain("IMPOSSIBLE");
  });

  it("renders a clean plugin with no findings", () => {
    const manifests = [manifest("wiki", { requires: ["db:query"] })];
    const events = [obtainedEvent("wiki", "db:query", "granted")];

    const text = formatCapabilityAuditReport(auditCapabilityUsage(manifests, events));

    expect(text).toContain("clean: every declared capability was observed in use.");
  });

  it("renders acknowledged over-privileged findings distinctly from fresh ones", () => {
    const manifests = [manifest("api-gateway", { requires: ["rbac:check", "render:template"] })];
    const events = [obtainedEvent("api-gateway", "rbac:check", "granted")];

    const text = formatCapabilityAuditReport(
      auditCapabilityUsage(manifests, events, {
        acknowledgedOverPrivileged: { "api-gateway": ["render:template"] },
      }),
    );

    expect(text).toContain("over-privileged (acknowledged");
    expect(text).not.toContain("OVER-PRIVILEGED (declared, never obtained)");
  });
});

/**
 * Least-privilege capability audit (feature #118).
 *
 * spec.md's Capability/Permission Broker (`core/broker.ts`, feature #7) is
 * built so a plugin can *never* obtain a capability it did not declare
 * under `capabilities.requires` — `broker.ts`'s own `obtain()` denies with
 * `reason: "not_declared"` before it ever records a `"granted"` audit
 * event (see `core/audit.ts`, feature #11). That is the "declares more
 * than it needs" half of least privilege enforced structurally, at
 * construction time, with no way to violate it from plugin code.
 *
 * What the broker's construction does *not* catch is the opposite
 * direction: a plugin whose manifest lists a capability under
 * `capabilities.requires` that its own code never actually calls
 * `capabilities.obtain()` for at runtime — a real, live grant to a
 * capability that just sits there unused. That is an over-privileged
 * declaration: it widens the plugin's ceiling (what an operator *could*
 * grant it, and what a stricter-than-default `GrantPolicy` — see
 * `loader.ts` — would have to reason about) for no actual benefit. This
 * module is the audit that catches *that* half, by comparing each
 * plugin's declared `capabilities.requires` against the capability ids it
 * was actually observed obtaining at runtime, per the kernel's own audit
 * trail (`core/audit.ts`'s `AuditEvent`s with
 * `action: "capability:obtain"`).
 *
 * ## Why this needs a real runtime run, not a static read
 *
 * `plugin-builder`'s conventions linter (feature #77,
 * `src/plugins/plugin-builder/src/conventions-linter.ts`) already performs
 * a *static* version of the mirror-image check (`undeclared_capability_use`
 * — a source-level `.obtain(...)` call for an id missing from
 * `capabilities.requires`), by regex-scanning source text. This module is
 * deliberately not another static scan: several real `obtain()` call sites
 * in this codebase are *lazy* — invoked only when a specific request path
 * is actually taken (e.g. `api-gateway/src/rbac-protection.ts` only calls
 * `obtain("rbac:check")` for a request that both matches a
 * `requiredPermission`-protected route AND carries a valid session; see
 * that module's own docs). A static read of the source can prove a
 * capability id is *reachable* from some `obtain()` call site, but it
 * cannot prove that call site ever actually executes in a real, live
 * deployment. This audit answers a different, complementary question: of
 * everything a plugin is *allowed* to obtain, what did it actually reach
 * for during a real run against the real broker? See
 * `scripts/capability-audit.ts` for the runtime harness that produces the
 * `AuditEvent[]` this module consumes.
 *
 * ## What counts as "used"
 *
 * A capability id counts as used by a plugin the moment that plugin
 * successfully obtains a live handle for it — i.e. one
 * `{ action: "capability:obtain", outcome: "granted" }` audit event with
 * that plugin as `actor` and that capability id as `target`
 * (`core/broker.ts`'s `obtain()` records exactly one such event per
 * successful call). Whether the plugin's code goes on to actually *call* a
 * method on the resulting handle is deliberately out of scope — obtaining
 * the handle is already the broker-mediated boundary crossing this
 * module's least-privilege audit cares about (the same boundary
 * `capabilities.requires` exists to bound in the first place).
 */
import type { AuditEvent } from "./audit.js";
import type { PluginManifest } from "./manifest.js";

/** One plugin's declared-vs-used capability comparison. */
export interface CapabilityAuditPluginReport {
  /** This plugin's manifest id. */
  readonly pluginId: string;
  /** `capabilities.requires` from this plugin's manifest, as declared. */
  readonly declared: readonly string[];
  /** Capability ids this plugin was observed successfully obtaining at runtime. */
  readonly used: readonly string[];
  /**
   * Declared but never observed being obtained — over-privileged. Every id
   * here is a candidate for removal from `capabilities.requires`, unless a
   * documented, deliberate reason keeps it (see
   * {@link AuditCapabilityOptions.acknowledgedOverPrivileged}).
   */
  readonly overPrivileged: readonly string[];
  /**
   * Observed being obtained but absent from `capabilities.requires` —
   * should be impossible by construction (broker.ts's `obtain()` denies
   * before ever recording a `"granted"` audit event for an undeclared
   * capability). A non-empty list here means either this plugin's audit
   * events were attributed to the wrong actor, or the broker's own
   * declare-before-obtain invariant has been broken — either way, a
   * critical finding, never a normal one.
   */
  readonly impossibleUsage: readonly string[];
  /**
   * The subset of {@link overPrivileged} explicitly acknowledged as a known,
   * deliberate exception (see {@link AuditCapabilityOptions.acknowledgedOverPrivileged}) —
   * still reported, but does not by itself make the audit "unclean" (see
   * {@link isCapabilityAuditReportClean}).
   */
  readonly acknowledgedOverPrivileged: readonly string[];
}

/** The full audit, one entry per plugin manifest passed in. */
export interface CapabilityAuditReport {
  readonly plugins: readonly CapabilityAuditPluginReport[];
}

export interface AuditCapabilityOptions {
  /**
   * Known, deliberate "declares more than it currently uses" exceptions,
   * keyed by plugin id, each naming the specific capability ids to
   * acknowledge rather than flag as a fresh regression. Every entry here
   * must be justified in the caller's own code/docs (see
   * `scripts/capability-audit.ts`'s own `KNOWN_OVER_PRIVILEGED` for this
   * repo's one current instance, with its reasoning) — this module does
   * not itself judge whether an acknowledgment is warranted, only records
   * which findings were pre-reviewed and accepted versus new/unreviewed.
   * An id listed here that is NOT actually over-privileged (i.e. the
   * plugin now uses it, or never declared it) has no effect — it simply
   * never appears in `overPrivileged` for that plugin to acknowledge.
   */
  readonly acknowledgedOverPrivileged?: Readonly<Record<string, readonly string[]>>;
}

/** Capability ids a plugin was observed successfully obtaining, per `pluginId`. */
function usedCapabilitiesByPlugin(auditEvents: readonly AuditEvent[]): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  for (const event of auditEvents) {
    if (event.action !== "capability:obtain" || event.outcome !== "granted") {
      continue;
    }
    const existing = used.get(event.actor);
    if (existing) {
      existing.add(event.target);
    } else {
      used.set(event.actor, new Set([event.target]));
    }
  }
  return used;
}

/**
 * Compare every manifest's declared `capabilities.requires` against what
 * its plugin id was actually observed obtaining in `auditEvents`. Pure and
 * synchronous — takes no action itself, has no I/O; see
 * `scripts/capability-audit.ts` for the runtime harness that produces
 * real `AuditEvent[]` to feed this.
 */
export function auditCapabilityUsage(
  manifests: readonly PluginManifest[],
  auditEvents: readonly AuditEvent[],
  options: AuditCapabilityOptions = {},
): CapabilityAuditReport {
  const usedByPlugin = usedCapabilitiesByPlugin(auditEvents);
  const acknowledged = options.acknowledgedOverPrivileged ?? {};

  const plugins = manifests.map((manifest): CapabilityAuditPluginReport => {
    const declared = manifest.capabilities.requires;
    const declaredSet = new Set(declared);
    const used = usedByPlugin.get(manifest.id) ?? new Set<string>();
    const acknowledgedSet = new Set(acknowledged[manifest.id] ?? []);

    const overPrivileged = declared.filter((capabilityId) => !used.has(capabilityId));
    const impossibleUsage = [...used].filter((capabilityId) => !declaredSet.has(capabilityId));

    return {
      pluginId: manifest.id,
      declared,
      used: [...used].sort((a, b) => a.localeCompare(b)),
      overPrivileged,
      impossibleUsage: impossibleUsage.sort((a, b) => a.localeCompare(b)),
      acknowledgedOverPrivileged: overPrivileged.filter((capabilityId) =>
        acknowledgedSet.has(capabilityId),
      ),
    };
  });

  return { plugins };
}

/**
 * `true` if every finding this report contains is either absent or
 * explicitly acknowledged — i.e. nothing a caller (e.g.
 * `scripts/capability-audit.ts`'s process exit code) needs to treat as a
 * fresh regression. `impossibleUsage` is never acknowledgeable (see that
 * field's own docs) — any occurrence makes a report unclean.
 */
export function isCapabilityAuditReportClean(report: CapabilityAuditReport): boolean {
  return report.plugins.every(
    (plugin) =>
      plugin.impossibleUsage.length === 0 &&
      plugin.overPrivileged.length === plugin.acknowledgedOverPrivileged.length,
  );
}

/** Render a {@link CapabilityAuditReport} as human-readable text for CLI output. */
export function formatCapabilityAuditReport(report: CapabilityAuditReport): string {
  const lines: string[] = [];
  for (const plugin of report.plugins) {
    lines.push(`${plugin.pluginId}:`);
    lines.push(
      `  declares: ${plugin.declared.length === 0 ? "(none)" : plugin.declared.join(", ")}`,
    );
    lines.push(`  used:     ${plugin.used.length === 0 ? "(none)" : plugin.used.join(", ")}`);

    if (plugin.impossibleUsage.length > 0) {
      lines.push(
        `  IMPOSSIBLE (used but never declared — broker invariant violated): ` +
          plugin.impossibleUsage.join(", "),
      );
    }

    const freshOverPrivileged = plugin.overPrivileged.filter(
      (capabilityId) => !plugin.acknowledgedOverPrivileged.includes(capabilityId),
    );
    if (freshOverPrivileged.length > 0) {
      lines.push(`  OVER-PRIVILEGED (declared, never obtained): ${freshOverPrivileged.join(", ")}`);
    }
    if (plugin.acknowledgedOverPrivileged.length > 0) {
      lines.push(
        `  over-privileged (acknowledged, see scripts/capability-audit.ts): ` +
          plugin.acknowledgedOverPrivileged.join(", "),
      );
    }
    if (
      plugin.impossibleUsage.length === 0 &&
      plugin.overPrivileged.length === 0 &&
      plugin.declared.length > 0
    ) {
      lines.push(`  clean: every declared capability was observed in use.`);
    }
  }
  return lines.join("\n");
}

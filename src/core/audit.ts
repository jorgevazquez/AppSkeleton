/**
 * In-memory audit trail sink for the kernel (spec.md's "Structured Logger &
 * Audit Trail" requirement: "every capability grant, permission check, and
 * mutating action is logged with actor/target/outcome, ready to be consumed
 * by the RBAC plugin's audit views").
 *
 * {@link AuditSink} is deliberately the smallest possible contract — a
 * single `record(event)` method — so any kernel component that produces
 * audit-worthy activity (the capability broker in this feature; later, the
 * RBAC plugin's own access decisions) can depend on it without pulling in
 * storage/query concerns. {@link createInMemoryAuditSink} is the kernel's
 * default implementation: a process-local, unbounded, insertion-ordered
 * event log with a small read-side `query()` API layered on top of the
 * `AuditSink` contract, for the "consumed by the RBAC plugin's audit views"
 * half of the spec requirement.
 *
 * Not durable — this sink only exists as long as the process does, matching
 * this feature's "in-memory audit trail sink" title. A future feature that
 * wants a persistent sink (e.g. writing to database-mysql) can implement
 * the same `AuditSink` interface without touching any of this module's
 * callers.
 */

/**
 * One audit entry. Generic on purpose (not capability-broker-specific) so
 * any kernel/plugin subsystem can produce entries in the same shape:
 *
 *  - `actor`  — who/what performed or attempted the action (e.g. a plugin
 *    id, or "operator" for an operator-initiated action).
 *  - `action` — a stable, machine-readable identifier for what happened
 *    (e.g. `"capability:grant"`, `"capability:obtain"`).
 *  - `target` — what the action was performed against (e.g. a capability
 *    id, a resource id).
 *  - `outcome` — the result (e.g. `"granted"`, `"denied"`, `"revoked"`).
 *    Left as a free-form string rather than a fixed union so every producer
 *    (capability broker today, RBAC access decisions later) can use its own
 *    outcome vocabulary without modifying this module.
 *  - `timestamp` — when the event was recorded, as epoch milliseconds
 *    (`Date.now()`). The producer stamps this, not the sink, so a producer
 *    that already has a trusted clock (or, in tests, a fixed value) has
 *    full control over it.
 *  - `details` — optional structured context beyond the four required
 *    fields (e.g. a denial reason). Must not contain secrets — this module
 *    does no redaction of its own; see logger.ts if a sink implementation
 *    ever needs to emit these entries as log lines.
 */
export interface AuditEvent {
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly outcome: string;
  readonly timestamp: number;
  readonly details?: Record<string, unknown>;
}

/** The minimal contract every audit sink implementation must satisfy. */
export interface AuditSink {
  /** Record one audit entry. Must never throw for a well-formed AuditEvent. */
  record(event: AuditEvent): void;
}

/** Filter for {@link InMemoryAuditSink.query}. Every provided field is ANDed together. */
export interface AuditQuery {
  readonly actor?: string;
  readonly action?: string;
  readonly target?: string;
  readonly outcome?: string;
  /** Only entries with `timestamp >= since` (inclusive). */
  readonly since?: number;
  /** Only entries with `timestamp <= until` (inclusive). */
  readonly until?: number;
}

/** The kernel's default {@link AuditSink}, with a read-side query API layered on top. */
export interface InMemoryAuditSink extends AuditSink {
  /** All recorded entries matching every provided filter, in the order they were recorded. */
  query(filter?: AuditQuery): readonly AuditEvent[];
  /** Every recorded entry, in the order they were recorded. Equivalent to `query()`. */
  all(): readonly AuditEvent[];
  /** Discard every recorded entry. */
  clear(): void;
}

function matches(event: AuditEvent, filter: AuditQuery): boolean {
  if (filter.actor !== undefined && event.actor !== filter.actor) {
    return false;
  }
  if (filter.action !== undefined && event.action !== filter.action) {
    return false;
  }
  if (filter.target !== undefined && event.target !== filter.target) {
    return false;
  }
  if (filter.outcome !== undefined && event.outcome !== filter.outcome) {
    return false;
  }
  if (filter.since !== undefined && event.timestamp < filter.since) {
    return false;
  }
  if (filter.until !== undefined && event.timestamp > filter.until) {
    return false;
  }
  return true;
}

/**
 * Create a fresh, isolated in-memory audit sink. A factory, not a
 * singleton — matching broker.ts's "no ambient authority" precedent, each
 * caller (kernel bootstrap in production, individual tests in isolation)
 * gets its own private, independent event log.
 */
export function createInMemoryAuditSink(): InMemoryAuditSink {
  const entries: AuditEvent[] = [];

  function record(event: AuditEvent): void {
    entries.push(event);
  }

  function query(filter: AuditQuery = {}): readonly AuditEvent[] {
    return entries.filter((event) => matches(event, filter));
  }

  function all(): readonly AuditEvent[] {
    return [...entries];
  }

  function clear(): void {
    entries.length = 0;
  }

  return Object.freeze({ record, query, all, clear });
}

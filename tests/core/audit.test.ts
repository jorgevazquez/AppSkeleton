import { describe, expect, it } from "vitest";
import { createInMemoryAuditSink, type AuditEvent } from "../../src/core/audit.js";

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    actor: "wiki",
    action: "capability:grant",
    target: "db:query",
    outcome: "granted",
    timestamp: 1000,
    ...overrides,
  };
}

describe("createInMemoryAuditSink — record + query basics", () => {
  it("record() then all() returns exactly what was recorded, in call order", () => {
    const sink = createInMemoryAuditSink();
    const first = makeEvent({ timestamp: 1 });
    const second = makeEvent({ timestamp: 2, outcome: "denied" });

    sink.record(first);
    sink.record(second);

    expect(sink.all()).toEqual([first, second]);
  });

  it("all() returns a snapshot — mutating the returned array does not affect the sink's internal state", () => {
    const sink = createInMemoryAuditSink();
    sink.record(makeEvent());

    const snapshot = sink.all() as AuditEvent[];
    snapshot.push(makeEvent({ target: "injected" }));

    expect(sink.all()).toHaveLength(1);
  });

  it("query() with no filter returns every recorded entry", () => {
    const sink = createInMemoryAuditSink();
    sink.record(makeEvent({ actor: "a" }));
    sink.record(makeEvent({ actor: "b" }));

    expect(sink.query()).toHaveLength(2);
  });

  it("query() filters by actor", () => {
    const sink = createInMemoryAuditSink();
    sink.record(makeEvent({ actor: "wiki" }));
    sink.record(makeEvent({ actor: "rbac" }));

    const results = sink.query({ actor: "rbac" });
    expect(results).toHaveLength(1);
    expect(results[0]?.actor).toBe("rbac");
  });

  it("query() filters by target", () => {
    const sink = createInMemoryAuditSink();
    sink.record(makeEvent({ target: "db:query" }));
    sink.record(makeEvent({ target: "http:route" }));

    const results = sink.query({ target: "http:route" });
    expect(results).toHaveLength(1);
    expect(results[0]?.target).toBe("http:route");
  });

  it("query() filters by outcome", () => {
    const sink = createInMemoryAuditSink();
    sink.record(makeEvent({ outcome: "granted" }));
    sink.record(makeEvent({ outcome: "denied" }));
    sink.record(makeEvent({ outcome: "revoked" }));

    expect(sink.query({ outcome: "denied" })).toHaveLength(1);
    expect(sink.query({ outcome: "revoked" })[0]?.outcome).toBe("revoked");
  });

  it("query() filters by action", () => {
    const sink = createInMemoryAuditSink();
    sink.record(makeEvent({ action: "capability:grant" }));
    sink.record(makeEvent({ action: "capability:obtain" }));

    expect(sink.query({ action: "capability:obtain" })).toHaveLength(1);
  });

  it("query() filters by a since/until timestamp range (inclusive on both ends)", () => {
    const sink = createInMemoryAuditSink();
    sink.record(makeEvent({ timestamp: 100 }));
    sink.record(makeEvent({ timestamp: 200 }));
    sink.record(makeEvent({ timestamp: 300 }));

    expect(sink.query({ since: 150 })).toHaveLength(2);
    expect(sink.query({ until: 250 })).toHaveLength(2);
    expect(sink.query({ since: 100, until: 300 })).toHaveLength(3);
    expect(sink.query({ since: 200, until: 200 })).toHaveLength(1);
  });

  it("query() combines multiple filters with AND semantics", () => {
    const sink = createInMemoryAuditSink();
    sink.record(makeEvent({ actor: "wiki", outcome: "granted" }));
    sink.record(makeEvent({ actor: "wiki", outcome: "denied" }));
    sink.record(makeEvent({ actor: "rbac", outcome: "granted" }));

    const results = sink.query({ actor: "wiki", outcome: "granted" });
    expect(results).toHaveLength(1);
    expect(results[0]?.actor).toBe("wiki");
    expect(results[0]?.outcome).toBe("granted");
  });

  it("query() preserves details on returned entries", () => {
    const sink = createInMemoryAuditSink();
    sink.record(makeEvent({ details: { reason: "not_declared" } }));

    expect(sink.query()[0]?.details).toEqual({ reason: "not_declared" });
  });

  it("clear() empties the sink", () => {
    const sink = createInMemoryAuditSink();
    sink.record(makeEvent());
    sink.record(makeEvent());

    sink.clear();

    expect(sink.all()).toEqual([]);
    expect(sink.query()).toEqual([]);
  });

  it("two independently created sinks have fully independent state", () => {
    const sinkA = createInMemoryAuditSink();
    const sinkB = createInMemoryAuditSink();

    sinkA.record(makeEvent());

    expect(sinkA.all()).toHaveLength(1);
    expect(sinkB.all()).toHaveLength(0);
  });
});

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/core/logger.js";
import { createEventBus, type EventMap } from "../../src/core/events.js";

/** In-memory sink for a pino logger's raw ndjson output, mirroring logger.test.ts's helper. */
function createCapturingLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({ stream, level: "trace" });
  return {
    logger,
    lines: (): Record<string, unknown>[] =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

interface TestEvents extends EventMap {
  "user.created": { id: string; email: string };
  "user.deleted": { id: string };
}

describe("createEventBus — multiple subscribers", () => {
  it("delivers a published event to every subscriber, in subscription order, with the typed payload", async () => {
    const bus = createEventBus<TestEvents>();
    const received: string[] = [];

    bus.subscribe("user.created", (payload) => {
      received.push(`first:${payload.id}:${payload.email}`);
    });
    bus.subscribe("user.created", (payload) => {
      received.push(`second:${payload.id}`);
    });

    await bus.publish("user.created", { id: "1", email: "a@example.com" });

    expect(received).toEqual(["first:1:a@example.com", "second:1"]);
  });

  it("only invokes subscribers registered for the published event, not other events", async () => {
    const bus = createEventBus<TestEvents>();
    const createdCalls: string[] = [];
    const deletedCalls: string[] = [];

    bus.subscribe("user.created", (payload) => {
      createdCalls.push(payload.id);
    });
    bus.subscribe("user.deleted", (payload) => {
      deletedCalls.push(payload.id);
    });

    await bus.publish("user.created", { id: "1", email: "a@example.com" });

    expect(createdCalls).toEqual(["1"]);
    expect(deletedCalls).toEqual([]);
    expect(bus.subscriberCount("user.created")).toBe(1);
    expect(bus.subscriberCount("user.deleted")).toBe(1);
  });

  it("publishing an event with no subscribers resolves without error", async () => {
    const bus = createEventBus<TestEvents>();
    await expect(
      bus.publish("user.created", { id: "1", email: "a@example.com" }),
    ).resolves.toBeUndefined();
  });
});

describe("createEventBus — unsubscribe", () => {
  it("stops that handler from receiving future publishes, without affecting other subscribers", async () => {
    const bus = createEventBus<TestEvents>();
    const received: string[] = [];

    const unsubscribeA = bus.subscribe("user.created", () => {
      received.push("a");
    });
    bus.subscribe("user.created", () => {
      received.push("b");
    });

    unsubscribeA();
    await bus.publish("user.created", { id: "1", email: "a@example.com" });

    expect(received).toEqual(["b"]);
    expect(bus.subscriberCount("user.created")).toBe(1);
  });

  it("is idempotent — calling the returned function more than once is a safe no-op", async () => {
    const bus = createEventBus<TestEvents>();
    const received: string[] = [];

    const unsubscribe = bus.subscribe("user.created", () => {
      received.push("a");
    });
    unsubscribe();
    unsubscribe();

    await bus.publish("user.created", { id: "1", email: "a@example.com" });

    expect(received).toEqual([]);
    expect(bus.subscriberCount("user.created")).toBe(0);
  });

  it("unsubscribing one handler mid-publish does not skip other handlers already snapshotted for that publish", async () => {
    const bus = createEventBus<TestEvents>();
    const received: string[] = [];
    let unsubscribeB: () => void = () => {};

    bus.subscribe("user.created", () => {
      received.push("a");
      unsubscribeB();
    });
    unsubscribeB = bus.subscribe("user.created", () => {
      received.push("b");
    });

    await bus.publish("user.created", { id: "1", email: "a@example.com" });
    expect(received).toEqual(["a", "b"]);

    received.length = 0;
    await bus.publish("user.created", { id: "2", email: "b@example.com" });
    expect(received).toEqual(["a"]);
  });
});

describe("createEventBus — isolation from a throwing handler", () => {
  it("a subscriber that throws synchronously does not prevent other subscribers of the same event from running", async () => {
    const bus = createEventBus<TestEvents>();
    const received: string[] = [];

    bus.subscribe("user.created", () => {
      throw new Error("boom");
    });
    bus.subscribe("user.created", (payload) => {
      received.push(payload.id);
    });

    await expect(
      bus.publish("user.created", { id: "1", email: "a@example.com" }),
    ).resolves.toBeUndefined();
    expect(received).toEqual(["1"]);
  });

  it("a subscriber whose returned Promise rejects does not prevent other subscribers of the same event from running", async () => {
    const bus = createEventBus<TestEvents>();
    const received: string[] = [];

    bus.subscribe("user.created", async () => {
      throw new Error("async boom");
    });
    bus.subscribe("user.created", async (payload) => {
      received.push(payload.id);
    });

    await expect(
      bus.publish("user.created", { id: "1", email: "a@example.com" }),
    ).resolves.toBeUndefined();
    expect(received).toEqual(["1"]);
  });

  it("a throwing subscriber's error is logged with the event name, and does not abort the publish for a later-registered subscriber either", async () => {
    const { logger, lines } = createCapturingLogger();
    const bus = createEventBus<TestEvents>({ logger });
    const received: string[] = [];

    bus.subscribe("user.created", (payload) => {
      received.push(`before:${payload.id}`);
    });
    bus.subscribe("user.created", () => {
      throw new Error("boom");
    });
    bus.subscribe("user.created", (payload) => {
      received.push(`after:${payload.id}`);
    });

    await bus.publish("user.created", { id: "1", email: "a@example.com" });

    expect(received).toEqual(["before:1", "after:1"]);
    const errorLines = lines().filter((line) => line["level"] === 50);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]?.["event"]).toBe("user.created");
    expect(errorLines[0]?.["msg"]).toContain('Subscriber for event "user.created" threw');
  });
});

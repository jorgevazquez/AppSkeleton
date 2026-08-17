/**
 * Typed event bus — spec.md's "Event Bus" kernel requirement: "typed pub/sub
 * so plugins can react to each other's lifecycle and domain events without
 * direct coupling (`user.created`, `page.published`, etc.)".
 *
 * Like broker.ts (capabilities) and graph.ts (dependency resolution), this
 * module is a generic, business-logic-free primitive — it knows nothing
 * about `user.created` or `page.published` specifically. A caller (the
 * kernel bootstrap, a plugin, or a test) supplies its own event-name →
 * payload-type map as the `Events` type parameter, and every subscribe/
 * publish call is checked against it at compile time:
 *
 * ```ts
 * interface KernelEvents extends EventMap {
 *   "user.created": { id: string; email: string };
 *   "page.published": { pageId: string; publishedBy: string };
 * }
 *
 * const bus = createEventBus<KernelEvents>();
 * const unsubscribe = bus.subscribe("user.created", (payload) => {
 *   payload.email; // typed as string — no `any` anywhere in this module's surface
 * });
 * await bus.publish("user.created", { id: "1", email: "a@example.com" });
 * unsubscribe();
 * ```
 *
 * ## Multiple subscribers
 *
 * Any number of subscribers may register for the same event id via
 * {@link EventBus.subscribe}; every one of them is invoked, in subscription
 * order, on each {@link EventBus.publish} for that event. `publish()` takes a
 * snapshot of the current subscriber set before invoking anyone, mirroring
 * Node's own `EventEmitter` semantics: a subscriber that unsubscribes itself
 * or another subscriber mid-publish does not change who gets called during
 * *that* publish, and a subscriber added mid-publish is not called until the
 * *next* publish.
 *
 * ## Subscriber isolation
 *
 * `publish()` awaits each subscriber in turn but wraps the call in its own
 * try/catch: a subscriber that throws synchronously, or returns a Promise
 * that rejects, is caught and logged, and every remaining subscriber for
 * that event still runs. `publish()` itself therefore never rejects because
 * of a misbehaving subscriber — one broken plugin reacting to an event must
 * not stop unrelated plugins from receiving it (spec.md's "a broken plugin
 * must not crash the kernel or unrelated plugins").
 */
import { createLogger, type Logger } from "./logger.js";

/**
 * Base shape every event map passed to {@link createEventBus} must satisfy:
 * event name -> payload type. Extend it with your own concrete event names
 * and payload types (see module docs) rather than using this type directly.
 */
export type EventMap = Record<string, unknown>;

/**
 * A subscriber callback for one event's payload type. May be synchronous or
 * return a Promise; either way, an error is isolated per-subscriber — see
 * {@link EventBus.publish}.
 */
export type EventHandler<Payload> = (payload: Payload) => void | Promise<void>;

/**
 * Unsubscribe function returned by {@link EventBus.subscribe}. Idempotent:
 * calling it more than once is a safe no-op.
 */
export type Unsubscribe = () => void;

export interface EventBus<Events extends EventMap = EventMap> {
  /**
   * Register `handler` for `event`. Multiple subscribers may register for
   * the same event; each one receives every subsequent {@link publish} for
   * it (see module docs' "Multiple subscribers"). Returns an
   * {@link Unsubscribe} function that removes this exact handler.
   */
  subscribe<Event extends keyof Events & string>(
    event: Event,
    handler: EventHandler<Events[Event]>,
  ): Unsubscribe;
  /**
   * Invoke every current subscriber of `event` with `payload`, awaited in
   * subscription order. A subscriber that throws (or returns a Promise that
   * rejects) is caught, logged, and does NOT stop or skip any other
   * subscriber — see module docs' "Subscriber isolation". Resolves once
   * every subscriber has settled; never rejects.
   */
  publish<Event extends keyof Events & string>(event: Event, payload: Events[Event]): Promise<void>;
  /** Read-only introspection: how many live subscribers `event` currently has. */
  subscriberCount<Event extends keyof Events & string>(event: Event): number;
}

export interface CreateEventBusOptions {
  /** Defaults to `createLogger({ context: { module: "event-bus" } })`. */
  logger?: Logger;
}

/**
 * Create a fresh, isolated event bus. Deliberately a factory, not a
 * singleton — matching broker.ts's "no ambient authority" stance, the
 * kernel bootstrap creates exactly one bus and threads it explicitly to
 * whatever needs to publish or subscribe; there is no module-level mutable
 * state in this file.
 */
export function createEventBus<Events extends EventMap = EventMap>(
  options: CreateEventBusOptions = {},
): EventBus<Events> {
  const logger = options.logger ?? createLogger({ context: { module: "event-bus" } });

  // Handlers are stored with their payload type erased to `unknown`: a
  // single Map keyed by event name has to hold subscribers whose payload
  // types differ per key, which TypeScript cannot express without either
  // `any` or this kind of internal erasure. Type safety at the public
  // surface (subscribe/publish) is preserved because every lookup is keyed
  // by the same `event` string used to store the handler in the first
  // place, so a handler registered for `Events[Event]` is only ever invoked
  // with a payload of that exact type.
  const subscribers = new Map<string, Set<EventHandler<unknown>>>();

  function subscribe<Event extends keyof Events & string>(
    event: Event,
    handler: EventHandler<Events[Event]>,
  ): Unsubscribe {
    let handlers = subscribers.get(event);
    if (!handlers) {
      handlers = new Set();
      subscribers.set(event, handlers);
    }
    const stored = handler as unknown as EventHandler<unknown>;
    handlers.add(stored);

    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      handlers?.delete(stored);
    };
  }

  async function publish<Event extends keyof Events & string>(
    event: Event,
    payload: Events[Event],
  ): Promise<void> {
    const handlers = subscribers.get(event);
    if (!handlers || handlers.size === 0) {
      return;
    }

    // Snapshot before iterating: unsubscribes/subscribes triggered by one
    // subscriber must not affect who else runs during this publish.
    for (const handler of [...handlers]) {
      try {
        await handler(payload);
      } catch (cause) {
        logger.error(
          { event, err: cause },
          `Subscriber for event "${event}" threw; continuing with the remaining subscribers.`,
        );
      }
    }
  }

  function subscriberCount<Event extends keyof Events & string>(event: Event): number {
    return subscribers.get(event)?.size ?? 0;
  }

  return Object.freeze({ subscribe, publish, subscriberCount });
}

import { describe, expect, it } from "vitest";
import { CapabilityDeniedError, PluginLoadError } from "../../src/core/errors.js";
import {
  createCapabilityBroker,
  type CapabilityBroker,
  type CapabilityDenialReason,
} from "../../src/core/broker.js";
import { isErr, isOk } from "../../src/core/types.js";

/** Assert Ok and return the value, or fail the test with a readable message. */
function expectOk<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isOk(result as never)) {
    expect.fail(`expected Ok, got Err: ${JSON.stringify((result as { error?: unknown }).error)}`);
  }
  return (result as { ok: true; value: T }).value;
}

/** Assert Err and return the error, or fail the test with a readable message. */
function expectErr<E>(result: { ok: boolean; value?: unknown; error?: E }): E {
  if (!isErr(result as never)) {
    expect.fail("expected Err, got Ok");
  }
  return (result as { ok: false; error: E }).error;
}

function expectDenied(
  result: { ok: boolean; value?: unknown; error?: CapabilityDeniedError },
  reason: CapabilityDenialReason,
): CapabilityDeniedError {
  const error = expectErr(result);
  expect(error).toBeInstanceOf(CapabilityDeniedError);
  expect(error.code).toBe("CAPABILITY_DENIED");
  expect(error.details?.["reason"]).toBe(reason);
  return error;
}

/** Wire up a plugin that declares, is granted, and has a live provider for one capability. Returns the broker plus ids for convenience. */
function grantedSetup(implementation: unknown): {
  broker: CapabilityBroker;
  pluginId: string;
  providerId: string;
  capabilityId: string;
} {
  const broker = createCapabilityBroker();
  const pluginId = "wiki";
  const providerId = "database-mysql";
  const capabilityId = "db:query";

  broker.declareRequirement(pluginId, capabilityId);
  expectOk(broker.registerProvider(providerId, capabilityId, implementation));
  expectOk(broker.grant(pluginId, capabilityId));

  return { broker, pluginId, providerId, capabilityId };
}

describe("CapabilityBroker — granted capability is usable", () => {
  it("obtain() returns Ok once declared + provided + granted, and the handle calls through to the provider's function", () => {
    const query = (sql: string) => `ran: ${sql}`;
    const { broker, pluginId, capabilityId } = grantedSetup(query);

    const handle = expectOk(broker.obtain<typeof query>(pluginId, capabilityId));
    expect(handle("select 1")).toBe("ran: select 1");
  });

  it("obtain() works for an object-shaped handle, preserving `this` inside the provider's own methods", () => {
    const service = {
      count: 0,
      increment(this: { count: number }) {
        this.count += 1;
        return this.count;
      },
    };
    const { broker, pluginId, capabilityId } = grantedSetup(service);

    const handle = expectOk(broker.obtain<typeof service>(pluginId, capabilityId));
    expect(handle.increment()).toBe(1);
    expect(handle.increment()).toBe(2);
    // The underlying provider object itself was mutated by the bound method call.
    expect(service.count).toBe(2);
  });

  it("isGranted() reports true once declared + provided + granted", () => {
    const { broker, pluginId, capabilityId } = grantedSetup(() => "ok");
    expect(broker.isGranted(pluginId, capabilityId)).toBe(true);
  });

  it("forPlugin(pluginId).obtain() grants the same access as broker.obtain(pluginId, ...)", () => {
    const { broker, pluginId, capabilityId } = grantedSetup((n: number) => n * 2);
    const access = broker.forPlugin(pluginId);
    const handle = expectOk(access.obtain<(n: number) => number>(capabilityId));
    expect(handle(21)).toBe(42);
  });

  it("declareRequirements() bulk-declares every id in one call", () => {
    const broker = createCapabilityBroker();
    broker.declareRequirements("wiki", ["db:query", "render:template"]);

    expectOk(broker.registerProvider("html-renderer", "render:template", () => "<html/>"));
    expectOk(broker.grant("wiki", "render:template"));

    const handle = expectOk(broker.obtain<() => string>("wiki", "render:template"));
    expect(handle()).toBe("<html/>");
  });
});

describe("CapabilityBroker — undeclared capability request is denied", () => {
  it("obtain() is denied with reason not_declared when the plugin never declared the capability", () => {
    const broker = createCapabilityBroker();
    expectOk(broker.registerProvider("database-mysql", "db:query", () => "rows"));

    const result = broker.obtain("wiki", "db:query");
    expectDenied(result, "not_declared");
  });

  it("grant() itself refuses to authorize an undeclared capability", () => {
    const broker = createCapabilityBroker();
    expectOk(broker.registerProvider("database-mysql", "db:query", () => "rows"));

    const result = broker.grant("wiki", "db:query");
    expectDenied(result, "not_declared");
  });

  it("obtain() is denied with reason not_granted when declared but never granted", () => {
    const broker = createCapabilityBroker();
    broker.declareRequirement("wiki", "db:query");
    expectOk(broker.registerProvider("database-mysql", "db:query", () => "rows"));

    const result = broker.obtain("wiki", "db:query");
    expectDenied(result, "not_granted");
  });

  it("obtain() is denied with reason no_provider when declared and granted but nothing provides it yet", () => {
    const broker = createCapabilityBroker();
    broker.declareRequirement("wiki", "db:query");
    expectOk(broker.grant("wiki", "db:query"));

    const result = broker.obtain("wiki", "db:query");
    expectDenied(result, "no_provider");
  });

  it("declaring/granting one capability does not implicitly grant a different one", () => {
    const broker = createCapabilityBroker();
    broker.declareRequirement("wiki", "db:query");
    expectOk(broker.registerProvider("database-mysql", "db:query", () => "rows"));
    expectOk(broker.grant("wiki", "db:query"));

    const result = broker.obtain("wiki", "db:transaction");
    expectDenied(result, "not_declared");
  });

  it("granting one plugin's declared capability does not grant it to a different plugin", () => {
    const broker = createCapabilityBroker();
    broker.declareRequirement("wiki", "db:query");
    broker.declareRequirement("plugin-builder", "db:query");
    expectOk(broker.registerProvider("database-mysql", "db:query", () => "rows"));
    expectOk(broker.grant("wiki", "db:query"));

    expect(broker.isGranted("wiki", "db:query")).toBe(true);
    expectDenied(broker.obtain("plugin-builder", "db:query"), "not_granted");
  });

  it("isGranted() reports false for an undeclared/ungranted/unprovided capability", () => {
    const broker = createCapabilityBroker();
    expect(broker.isGranted("wiki", "db:query")).toBe(false);
  });

  it("registerProvider() refuses to let a second plugin register the same capability id (no hijacking another plugin's extension point)", () => {
    const broker = createCapabilityBroker();
    expectOk(broker.registerProvider("database-mysql", "db:query", () => "rows"));

    const result = broker.registerProvider("evil-plugin", "db:query", () => "stolen");
    const error = expectErr(result);
    expect(error).toBeInstanceOf(PluginLoadError);
    expect(error.code).toBe("PLUGIN_LOAD_ERROR");
    expect(error.details?.["existingProviderId"]).toBe("database-mysql");
    expect(error.details?.["attemptedProviderId"]).toBe("evil-plugin");
  });
});

describe("CapabilityBroker — revoked capability stops working immediately", () => {
  it("a handle obtained before revoke() throws CapabilityDeniedError on its very next call, with no re-obtain needed to notice", () => {
    const query = (sql: string) => `ran: ${sql}`;
    const { broker, pluginId, capabilityId } = grantedSetup(query);

    const handle = expectOk(broker.obtain<typeof query>(pluginId, capabilityId));
    expect(handle("select 1")).toBe("ran: select 1");

    broker.revoke(pluginId, capabilityId);

    expect(() => handle("select 2")).toThrow(CapabilityDeniedError);
  });

  it("a previously obtained object handle also dies immediately on property access after revoke()", () => {
    const service = { ping: () => "pong" };
    const { broker, pluginId, capabilityId } = grantedSetup(service);

    const handle = expectOk(broker.obtain<typeof service>(pluginId, capabilityId));
    expect(handle.ping()).toBe("pong");

    broker.revoke(pluginId, capabilityId);

    expect(() => handle.ping()).toThrow(CapabilityDeniedError);
  });

  it("obtain() after revoke() is denied with reason not_granted", () => {
    const { broker, pluginId, capabilityId } = grantedSetup(() => "ok");

    broker.revoke(pluginId, capabilityId);

    expectDenied(broker.obtain(pluginId, capabilityId), "not_granted");
  });

  it("isGranted() flips to false immediately after revoke()", () => {
    const { broker, pluginId, capabilityId } = grantedSetup(() => "ok");
    expect(broker.isGranted(pluginId, capabilityId)).toBe(true);

    broker.revoke(pluginId, capabilityId);

    expect(broker.isGranted(pluginId, capabilityId)).toBe(false);
  });

  it("re-granting after a revoke lets obtain() succeed again with a working NEW handle", () => {
    const query = (sql: string) => `ran: ${sql}`;
    const { broker, pluginId, capabilityId } = grantedSetup(query);

    broker.revoke(pluginId, capabilityId);
    expectOk(broker.grant(pluginId, capabilityId));

    const freshHandle = expectOk(broker.obtain<typeof query>(pluginId, capabilityId));
    expect(freshHandle("select 3")).toBe("ran: select 3");
  });

  it("re-granting after a revoke does NOT resurrect the old, already-revoked handle", () => {
    const query = (sql: string) => `ran: ${sql}`;
    const { broker, pluginId, capabilityId } = grantedSetup(query);

    const oldHandle = expectOk(broker.obtain<typeof query>(pluginId, capabilityId));
    broker.revoke(pluginId, capabilityId);
    expectOk(broker.grant(pluginId, capabilityId));

    expect(() => oldHandle("select 4")).toThrow(CapabilityDeniedError);
  });

  it("revoke() on a capability that was never granted is a harmless no-op", () => {
    const broker = createCapabilityBroker();
    broker.declareRequirement("wiki", "db:query");
    expect(() => broker.revoke("wiki", "db:query")).not.toThrow();
    expect(broker.isGranted("wiki", "db:query")).toBe(false);
  });
});

describe("CapabilityBroker — no ambient/global way to reach another plugin's internals", () => {
  it("the broker module exports only the factory function at runtime, never a shared singleton instance", async () => {
    const brokerModule = (await import("../../src/core/broker.js")) as Record<string, unknown>;
    expect(Object.keys(brokerModule)).toEqual(["createCapabilityBroker"]);
    expect(typeof brokerModule["createCapabilityBroker"]).toBe("function");
  });

  it("two brokers created by the factory have fully independent state", () => {
    const brokerA = createCapabilityBroker();
    const brokerB = createCapabilityBroker();

    brokerA.declareRequirement("wiki", "db:query");
    expectOk(brokerA.registerProvider("database-mysql", "db:query", () => "rows"));
    expectOk(brokerA.grant("wiki", "db:query"));

    expect(brokerA.isGranted("wiki", "db:query")).toBe(true);
    expect(brokerB.isGranted("wiki", "db:query")).toBe(false);
    expectDenied(brokerB.obtain("wiki", "db:query"), "not_declared");
  });

  it("forPlugin() returns a facade exposing only obtain() — no grant/revoke/registerProvider escape hatch", () => {
    const broker = createCapabilityBroker();
    const access = broker.forPlugin("wiki") as unknown as Record<string, unknown>;

    expect(Object.keys(access)).toEqual(["obtain"]);
    expect(typeof access["obtain"]).toBe("function");
  });

  it("a plugin's forPlugin() facade cannot reach a capability belonging to a different, unrelated plugin", () => {
    const broker = createCapabilityBroker();
    broker.declareRequirement("rbac-admin", "rbac:manage");
    expectOk(broker.registerProvider("rbac", "rbac:manage", () => "admin powers"));
    expectOk(broker.grant("rbac-admin", "rbac:manage"));

    // "wiki" never declared/was never granted rbac:manage — its own facade must be denied,
    // and there is no parameter or method on the facade that lets it impersonate rbac-admin.
    const wikiAccess = broker.forPlugin("wiki");
    expectDenied(wikiAccess.obtain("rbac:manage"), "not_declared");
  });

  it("registering a provider does not expose the raw implementation anywhere except through a successful obtain()", () => {
    const broker = createCapabilityBroker();
    const secretImplementation = { secret: "internal-only" };
    expectOk(broker.registerProvider("database-mysql", "db:query", secretImplementation));

    // No declare/grant happened for any plugin — there is no broker method that returns
    // registered implementations directly (e.g. no getProvider()/listProviders() escape hatch).
    expect((broker as unknown as Record<string, unknown>)["getProvider"]).toBeUndefined();
    expect((broker as unknown as Record<string, unknown>)["providers"]).toBeUndefined();
    expectDenied(broker.obtain("wiki", "db:query"), "not_declared");
  });
});

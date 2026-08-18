import { describe, expect, it } from "vitest";
import { bootstrapKernel } from "../../src/server/index.js";

describe("toolchain smoke test", () => {
  it("boots the real kernel bootstrap and answers /health via the api-gateway-owned Fastify instance", async () => {
    // Goes through the real bootstrap path (feature #58) rather than
    // constructing a bare Fastify instance itself: the kernel discovers and
    // loads the actual shipped src/plugins tree (env: {} keeps config
    // deterministic regardless of the host environment's own vars), and the
    // Fastify instance under test is the one api-gateway's own onEnable
    // hook constructed, reached only via kernel.httpApp.
    const kernel = await bootstrapKernel({ env: {} });
    expect(kernel.httpApp).toBeDefined();

    const res = await kernel.httpApp?.inject({ method: "GET", url: "/health" });
    expect(res?.statusCode).toBe(200);
    expect(res?.json()).toEqual({ status: "ok" });

    await kernel.httpApp?.close();
  });
});

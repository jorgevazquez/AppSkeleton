import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/server/index.js";

describe("toolchain smoke test", () => {
  it("boots a Fastify instance and answers /health", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});

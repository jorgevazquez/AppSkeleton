/**
 * Feature #108 ("Structured request logging with correlation/request IDs")
 * — drives the *real* `buildApp()` (exported by `../../../src/plugins/
 * api-gateway/index.ts` specifically so this test can inject a capturing
 * stream, mirroring `../../core/logger.test.ts`'s own capturing-stream
 * pattern), then proves all three of the feature's steps end-to-end over a
 * real `app.inject()` HTTP request:
 *
 *   1. every log line produced while handling one request — Fastify's own
 *      built-in "incoming request"/"request completed" lines, plus a
 *      handler's own `request.log.info(...)` call — carries the same
 *      request id
 *   2. that id is echoed back as the `X-Request-Id` response header
 *   3. (this file) the header value and the logged `reqId` field actually
 *      match, and two different requests get two different ids
 */
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, withContext } from "../../../src/core/logger.js";
import type { PluginLifecycleContext } from "../../../src/core/loader.js";
import * as apiGatewayModule from "../../../src/plugins/api-gateway/index.js";
import { REQUEST_ID_HEADER } from "../../../src/plugins/api-gateway/index.js";

/** In-memory sink for a pino logger's raw ndjson output — mirrors ../../core/logger.test.ts's own helper. */
function createCapturingStream() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: (): Record<string, unknown>[] =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** Minimal, hand-built lifecycle context — mirrors index.test.ts's "uses the lifecycle context's logger level" test. */
function makeContext(): PluginLifecycleContext {
  return {
    manifest: {
      id: "api-gateway",
      version: "0.1.0",
      depends_on: {},
      capabilities: { provides: ["http:route"], requires: [] },
      entry_point: "index.ts",
    },
    capabilities: {
      obtain: () => {
        throw new Error("not used in this test");
      },
    },
    logger: withContext(createLogger({ level: "info" }), { plugin: "api-gateway" }),
  };
}

describe("api-gateway — request ID correlation (feature #108)", () => {
  let app: apiGatewayModule.ApiGatewayApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("returns the request id in X-Request-Id, and the same id tags every log line for that request", async () => {
    const { stream, lines } = createCapturingStream();
    app = await apiGatewayModule.buildApp(makeContext(), { loggerStream: stream });

    // A fixture route that also logs via request.log — proving step 1 holds
    // for handler-level application logging, not just Fastify's own
    // built-in request/response lines.
    app.get("/whoami", async (request) => {
      request.log.info({ custom: "marker" }, "handling whoami");
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/whoami" });
    expect(res.statusCode).toBe(200);

    const requestId = res.headers[REQUEST_ID_HEADER];
    expect(typeof requestId).toBe("string");
    expect((requestId as string).length).toBeGreaterThan(0);

    const logged = lines();
    // Fastify's own request/response lines.
    const incoming = logged.find((line) => line.msg === "incoming request");
    const completed = logged.find((line) => line.msg === "request completed");
    // This handler's own application-level log line.
    const handlerLine = logged.find((line) => line.msg === "handling whoami");

    expect(incoming?.reqId).toBe(requestId);
    expect(completed?.reqId).toBe(requestId);
    expect(handlerLine?.reqId).toBe(requestId);
    expect(handlerLine?.custom).toBe("marker");
  });

  it("generates a different request id for each request", async () => {
    const { stream } = createCapturingStream();
    app = await apiGatewayModule.buildApp(makeContext(), { loggerStream: stream });
    await app.ready();

    const first = await app.inject({ method: "GET", url: "/health" });
    const second = await app.inject({ method: "GET", url: "/health" });

    const firstId = first.headers[REQUEST_ID_HEADER];
    const secondId = second.headers[REQUEST_ID_HEADER];
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
  });

  it("still returns X-Request-Id on an error response, correlated to the error log line", async () => {
    const { stream, lines } = createCapturingStream();
    app = await apiGatewayModule.buildApp(makeContext(), { loggerStream: stream });
    app.get("/boom", async () => {
      throw new Error("kaboom");
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);

    const requestId = res.headers[REQUEST_ID_HEADER];
    expect(typeof requestId).toBe("string");
    expect((requestId as string).length).toBeGreaterThan(0);

    const errorLine = lines().find((line) => line.msg?.toString().includes("Unhandled error"));
    expect(errorLine?.reqId).toBe(requestId);
  });
});

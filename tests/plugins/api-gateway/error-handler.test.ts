/**
 * Unit tests for `registerErrorHandling()` (feature #61 — "Centralized error
 * handler with a consistent envelope and no stack-trace leaks in
 * production"), driven directly against a standalone Fastify instance
 * (mirroring `route-capability.test.ts`'s `Fastify() as unknown as
 * ApiGatewayApp` pattern) rather than the full plugin loader — this feature
 * depends on #58 (Fastify instance ownership) and #10 (error isolation), not
 * #60, so it is verified at this module's own boundary directly.
 *
 * `error-handling.integration.test.ts` (feature #60) already covers the
 * uniform *4xx* envelope end-to-end through the real loader; this file
 * focuses on this feature's own three steps: (1) AppError subclasses map to
 * their declared status code + safe message, (2) an unexpected error's
 * response is generic in production but the operator-facing log always gets
 * full detail, and (3) — the crux of the feature — a thrown *internal*
 * error's message/stack can never be observed anywhere in the HTTP response
 * body when running in production mode.
 */
import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { CapabilityDeniedError, ValidationError } from "../../../src/core/errors.js";
import { createLogger, type Logger } from "../../../src/core/logger.js";
import { registerErrorHandling } from "../../../src/plugins/api-gateway/src/error-handler.js";
import type { ApiGatewayApp } from "../../../src/plugins/api-gateway/index.js";

/** In-memory sink for a pino logger's raw ndjson output, mirroring registry.test.ts's helper. */
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

/** Builds a bare Fastify instance with the error handler wired on, optionally with a capturing logger. */
function buildTestApp(
  options: { nodeEnv?: "development" | "test" | "production"; loggerInstance?: Logger } = {},
): ApiGatewayApp {
  const app = Fastify(
    options.loggerInstance !== undefined ? { loggerInstance: options.loggerInstance } : {},
  ) as unknown as ApiGatewayApp;
  registerErrorHandling(app, options.nodeEnv !== undefined ? { nodeEnv: options.nodeEnv } : {});
  return app;
}

const SENSITIVE_INTERNAL_MESSAGE =
  "connection refused talking to db at postgres://admin:hunter2@10.0.0.7:5432/prod";

describe("registerErrorHandling — AppError mapping (feature #61, step 1)", () => {
  it("maps a thrown AppError subclass to its own status code and safe publicMessage", async () => {
    const app = buildTestApp();
    app.get("/secret", async () => {
      throw new CapabilityDeniedError("plugin lacks capability X", {
        details: { capability: "secret:read" },
      });
    });

    const res = await app.inject({ method: "GET", url: "/secret" });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      code: "CAPABILITY_DENIED",
      message: "You do not have permission to perform this action.",
      details: { capability: "secret:read" },
    });

    await app.close();
  });

  it("maps ValidationError to 400 with its safe default publicMessage, not the internal message", async () => {
    const app = buildTestApp();
    app.get("/validate", async () => {
      throw new ValidationError(
        "field 'ssn' failed regex /^\\d{3}-\\d{2}-\\d{4}$/ against '12345'",
      );
    });

    const res = await app.inject({ method: "GET", url: "/validate" });

    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    expect(body["code"]).toBe("VALIDATION_ERROR");
    expect(body["message"]).toBe("The request was invalid.");
    expect(res.payload).not.toContain("ssn");
    expect(res.payload).not.toContain("12345");

    await app.close();
  });
});

describe("registerErrorHandling — unexpected errors never leak internals in production (feature #61, steps 2 & 3)", () => {
  it("a thrown internal Error never appears in the HTTP response body in production mode", async () => {
    const app = buildTestApp({ nodeEnv: "production" });
    app.get("/boom", async () => {
      throw new Error(SENSITIVE_INTERNAL_MESSAGE);
    });

    const res = await app.inject({ method: "GET", url: "/boom" });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
    });
    // Defense in depth: assert on the raw response text too, not just the
    // parsed JSON's known keys — proves the secret isn't smuggled in under
    // an unexpected field, and that no stack trace (which would itself
    // reference this test file's path) is present either.
    expect(res.payload).not.toContain("hunter2");
    expect(res.payload).not.toContain(SENSITIVE_INTERNAL_MESSAGE);
    expect(res.payload).not.toContain("error-handler.test.ts");
    expect(res.json()).not.toHaveProperty("stack");

    await app.close();
  });

  it("a thrown internal Error also never leaks in production even when its message is embedded in a nested/renamed property", async () => {
    const app = buildTestApp({ nodeEnv: "production" });
    app.get("/boom-custom", async () => {
      const err = new Error(SENSITIVE_INTERNAL_MESSAGE) as Error & { context?: unknown };
      err.context = { query: "SELECT * FROM users WHERE ssn = '123-45-6789'" };
      throw err;
    });

    const res = await app.inject({ method: "GET", url: "/boom-custom" });

    expect(res.statusCode).toBe(500);
    expect(res.payload).not.toContain("123-45-6789");
    expect(res.payload).not.toContain("hunter2");

    await app.close();
  });

  it("the same unexpected error outside production (development) attaches a stack trace for local debugging, but still never echoes the raw internal message", async () => {
    const app = buildTestApp({ nodeEnv: "development" });
    app.get("/boom", async () => {
      throw new Error(SENSITIVE_INTERNAL_MESSAGE);
    });

    const res = await app.inject({ method: "GET", url: "/boom" });

    expect(res.statusCode).toBe(500);
    const body = res.json() as Record<string, unknown>;
    expect(body["code"]).toBe("INTERNAL_ERROR");
    // The response `message` field itself is ALWAYS the generic fallback —
    // toErrorEnvelope() never substitutes the raw internal Error#message
    // into it, in any environment. Node's own `Error#stack` format *does*
    // start with `"<name>: <message>"` though (that's how V8 renders it),
    // so — unlike `message` — `stack` legitimately embeds the original
    // text here; that's the intended "full detail" a local developer gets
    // outside production, not a leak this feature is meant to close.
    expect(body["message"]).toBe("An unexpected error occurred.");
    expect(typeof body["stack"]).toBe("string");
    expect(body["stack"]).toContain(SENSITIVE_INTERNAL_MESSAGE);

    await app.close();
  });

  it("defaults to production-safe behavior (generic message) when neither an explicit nodeEnv nor NODE_ENV is a recognized value", async () => {
    const previous = process.env["NODE_ENV"];
    try {
      delete process.env["NODE_ENV"];
      const app = buildTestApp();
      app.get("/boom", async () => {
        throw new Error(SENSITIVE_INTERNAL_MESSAGE);
      });

      const res = await app.inject({ method: "GET", url: "/boom" });

      expect(res.statusCode).toBe(500);
      // Unset NODE_ENV resolves to "development" (matching config.ts's own
      // CoreConfigSchema default) — the response `message` is still always
      // the generic fallback, regardless.
      const body = res.json() as Record<string, unknown>;
      expect(body["code"]).toBe("INTERNAL_ERROR");
      expect(body["message"]).toBe("An unexpected error occurred.");

      await app.close();
    } finally {
      if (previous === undefined) {
        delete process.env["NODE_ENV"];
      } else {
        process.env["NODE_ENV"] = previous;
      }
    }
  });

  it("logs the full internal error detail (message + stack) even while the production response body stays generic", async () => {
    const { logger, lines } = createCapturingLogger();
    const app = buildTestApp({ nodeEnv: "production", loggerInstance: logger });
    app.get("/boom", async () => {
      throw new Error(SENSITIVE_INTERNAL_MESSAGE);
    });

    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.payload).not.toContain(SENSITIVE_INTERNAL_MESSAGE);

    const errorLine = lines().find(
      (line) =>
        typeof line["msg"] === "string" &&
        line["msg"] === "Unhandled error while processing request.",
    );
    expect(errorLine).toBeDefined();
    const err = errorLine?.["err"] as Record<string, unknown> | undefined;
    expect(err?.["message"]).toBe(SENSITIVE_INTERNAL_MESSAGE);
    expect(typeof err?.["stack"]).toBe("string");

    await app.close();
  });
});

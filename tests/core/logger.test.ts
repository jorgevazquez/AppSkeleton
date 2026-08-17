import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createLogger,
  redactSecrets,
  withContext,
  REDACTED_FIELD_NAMES,
  REDACTED_PLACEHOLDER,
  type CreateLoggerOptions,
} from "../../src/core/logger.js";

/** In-memory sink for a pino logger's raw ndjson output, so tests can assert on exactly what would have been emitted. */
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
    /** The full raw ndjson text written so far. */
    raw: (): string => chunks.join(""),
    /** Each emitted line, parsed as JSON. */
    lines: (): Record<string, unknown>[] =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function makeLogger(options: Omit<CreateLoggerOptions, "stream" | "level"> = {}) {
  const { stream, raw, lines } = createCapturingStream();
  const logger = createLogger({ ...options, stream, level: "trace" });
  return { logger, raw, lines };
}

describe("createLogger — structured JSON output with request/plugin context", () => {
  it("emits one JSON object per line, with base context fields merged into every line", () => {
    const { logger, lines } = makeLogger({ context: { plugin: "wiki" } });

    logger.info({ actor: "user:1" }, "page published");

    const [line] = lines();
    expect(line).toBeDefined();
    expect(line?.plugin).toBe("wiki");
    expect(line?.actor).toBe("user:1");
    expect(line?.msg).toBe("page published");
    expect(typeof line?.level).toBe("number");
    expect(typeof line?.time).toBe("number");
  });

  it("withContext layers request context on top of an existing plugin-scoped logger", () => {
    const { logger, lines } = makeLogger({ context: { plugin: "wiki" } });
    const requestLogger = withContext(logger, { requestId: "req-1" });

    requestLogger.warn("access denied");

    const [line] = lines();
    expect(line?.plugin).toBe("wiki");
    expect(line?.requestId).toBe("req-1");
    expect(line?.msg).toBe("access denied");
  });

  it("each log call's own fields are merged alongside the persistent context", () => {
    const { logger, lines } = makeLogger({ context: { plugin: "rbac" } });

    logger.info(
      { actor: "user:1", target: "role:admin", outcome: "granted" },
      "capability granted",
    );

    const [line] = lines();
    expect(line).toMatchObject({
      plugin: "rbac",
      actor: "user:1",
      target: "role:admin",
      outcome: "granted",
    });
  });
});

describe("createLogger — secret redaction never emits a secret-like field's value", () => {
  const secretValue = "sk-live-super-secret-value-should-never-appear";

  it.each([
    "password",
    "Password",
    "PASSWORD",
    "userPassword",
    "secret",
    "clientSecret",
    "token",
    "accessToken",
    "apikey",
    "apiKey",
    "API_KEY",
    "x-api-key",
    "authorization",
    "Authorization",
  ])("redacts a top-level field named %s", (fieldName) => {
    const { logger, raw, lines } = makeLogger();

    logger.info({ [fieldName]: secretValue }, "secret log line");

    expect(raw()).not.toContain(secretValue);
    const [line] = lines();
    expect(line?.[fieldName]).toBe(REDACTED_PLACEHOLDER);
  });

  it("redacts secret-like fields nested arbitrarily deep inside objects and arrays", () => {
    const { logger, raw, lines } = makeLogger();

    logger.info(
      {
        request: {
          headers: { authorization: `Bearer ${secretValue}` },
          body: { user: { credentials: [{ apiKey: secretValue }] } },
        },
      },
      "nested secret",
    );

    expect(raw()).not.toContain(secretValue);
    const [line] = lines();
    const record = line as {
      request: {
        headers: { authorization: string };
        body: { user: { credentials: Array<{ apiKey: string }> } };
      };
    };
    expect(record.request.headers.authorization).toBe(REDACTED_PLACEHOLDER);
    expect(record.request.body.user.credentials[0]?.apiKey).toBe(REDACTED_PLACEHOLDER);
  });

  it("redacts a secret-like property attached to an Error instance while preserving message/stack/type", () => {
    const { logger, raw, lines } = makeLogger();
    class UpstreamError extends Error {}
    const error = new UpstreamError("upstream call failed");
    (error as UpstreamError & { apiToken: string }).apiToken = secretValue;

    logger.error(error, "request failed");

    expect(raw()).not.toContain(secretValue);
    const [line] = lines();
    const err = line?.err as { type: string; message: string; apiToken: string } | undefined;
    expect(err?.type).toBe("UpstreamError");
    expect(err?.message).toBe("upstream call failed");
    expect(err?.apiToken).toBe(REDACTED_PLACEHOLDER);
  });

  it("redacts secret-like fields present in the base context supplied at logger creation", () => {
    const { logger, raw, lines } = makeLogger({
      context: { plugin: "wiki", apiToken: secretValue },
    });

    logger.info("hello");

    expect(raw()).not.toContain(secretValue);
    const [line] = lines();
    expect(line?.apiToken).toBe(REDACTED_PLACEHOLDER);
    expect(line?.plugin).toBe("wiki");
  });

  it("redacts secret-like fields supplied to withContext()", () => {
    const { logger, raw, lines } = makeLogger();
    const requestLogger = withContext(logger, { requestId: "req-1", token: secretValue });

    requestLogger.info("hi");

    expect(raw()).not.toContain(secretValue);
    const [line] = lines();
    expect(line?.token).toBe(REDACTED_PLACEHOLDER);
    expect(line?.requestId).toBe("req-1");
  });

  it("never leaks a secret value across repeated log calls on the same logger", () => {
    const { logger, raw } = makeLogger();

    for (let i = 0; i < 5; i += 1) {
      logger.info({ password: `${secretValue}-${i}` }, "iteration");
    }

    expect(raw()).not.toContain(secretValue);
  });

  it("security regression: redacts a secret-like object passed as a printf-style interpolation value, not just the first argument", () => {
    const { logger, raw, lines } = makeLogger();

    // Pino's documented printf-style calling convention: a string template
    // as the first argument, with later arguments supplying %j/%o/%s
    // placeholders. Only the first ("merging object") argument used to be
    // walked for redaction, so a secret-bearing object passed this way
    // reached the emitted line untouched.
    logger.info("config loaded: %j", { apiKey: secretValue });

    expect(raw()).not.toContain(secretValue);
    const [line] = lines();
    expect(line?.msg).toContain(REDACTED_PLACEHOLDER);
  });
});

describe("redactSecrets — direct unit coverage of the redaction utility", () => {
  it("redacts every declared field-name fragment", () => {
    for (const name of REDACTED_FIELD_NAMES) {
      const input = { [name]: "value" };
      expect(redactSecrets(input)[name]).toBe(REDACTED_PLACEHOLDER);
    }
  });

  it("leaves non-secret fields untouched", () => {
    const input = { username: "bob", nested: { count: 3 } };
    expect(redactSecrets(input)).toEqual(input);
  });

  it("does not mutate the input value", () => {
    const input = { password: "hunter2" };
    redactSecrets(input);
    expect(input.password).toBe("hunter2");
  });

  it("handles circular references without throwing or looping forever", () => {
    const input: Record<string, unknown> = { password: "hunter2" };
    input.self = input;

    const redacted = redactSecrets(input) as Record<string, unknown>;

    expect(redacted.password).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.self).toBe("[Circular]");
  });

  it("leaves opaque built-ins (Date) untouched rather than descending into their internals", () => {
    const date = new Date(0);
    expect(redactSecrets({ date })).toEqual({ date });
  });

  it("evaluates a benign custom toJSON and redacts its (already-safe) output", () => {
    const custom = { toJSON: () => "CUSTOM_JSON" };
    expect(redactSecrets({ custom })).toEqual({ custom: "CUSTOM_JSON" });
  });

  it("security regression: redacts a secret-like field inside a custom toJSON()'s output", () => {
    // A class-shaped value (e.g. a config/connection-string wrapper) whose
    // own toJSON() returns an object containing a secret-like field. Pino
    // calls toJSON() during serialization regardless of what this module
    // does, so leaving such a value untouched (the pre-fix behavior) let
    // the secret reach the emitted log line in the clear.
    class ConfigWrapper {
      toJSON() {
        return { apiKey: "sk-live-should-not-leak", host: "db.internal" };
      }
    }
    const redacted = redactSecrets({ config: new ConfigWrapper() }) as unknown as {
      config: { apiKey: string; host: string };
    };
    expect(redacted.config).toEqual({ apiKey: REDACTED_PLACEHOLDER, host: "db.internal" });
  });

  it("leaves known-safe built-ins with their own toJSON (Date) untouched, not evaluated+redacted", () => {
    const date = new Date(0);
    const redacted = redactSecrets({ date }) as { date: Date };
    expect(redacted.date).toBeInstanceOf(Date);
    expect(redacted.date).toEqual(date);
  });
});

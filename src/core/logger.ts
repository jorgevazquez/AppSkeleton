/**
 * Structured JSON logger for the kernel and its plugins, wrapping pino.
 *
 * `createLogger()` returns a pino logger that emits one JSON object per log
 * line (pino's native ndjson format) so downstream log aggregation can
 * index on fields instead of parsing free text — see spec.md's "Structured
 * Logger & Audit Trail" kernel requirement ("every capability grant,
 * permission check, and mutating action is logged with actor/target/
 * outcome"). `context` is merged into every line the logger (and any
 * descendant created via {@link withContext}) emits — the conventional
 * fields are `plugin` (which plugin owns this logger) and `requestId`
 * (which HTTP request this line belongs to), though any structured field
 * (`actor`, `target`, `outcome`, ...) is supported. `withContext()` derives
 * a child logger that layers further fields on top of an existing logger's
 * context without losing what's already there — e.g. a plugin-scoped
 * logger becomes a request-scoped logger for the duration of one call:
 *
 * ```ts
 * const pluginLogger = createLogger({ context: { plugin: "wiki" } });
 * const requestLogger = withContext(pluginLogger, { requestId: "req-1" });
 * requestLogger.info({ actor: "user:42" }, "page published");
 * // -> {"level":30,...,"plugin":"wiki","requestId":"req-1","actor":"user:42","msg":"page published"}
 * ```
 *
 * ## Automatic secret redaction
 *
 * Before pino serializes ANY log line — the logger's base context, a child
 * logger's bindings, and every individual call's merging object/error —
 * the value is walked recursively and any object key whose name matches
 * one of {@link REDACTED_FIELD_NAMES} (`password`, `secret`, `token`,
 * `apikey`, `authorization`) has its value replaced with
 * {@link REDACTED_PLACEHOLDER}. Matching is case- and punctuation-
 * insensitive (`API_KEY`, `apiKey`, `x-api-key`, `accessToken`,
 * `Authorization` all match) so callers cannot accidentally dodge
 * redaction with a differently-cased or prefixed field name.
 *
 * This runs unconditionally, for every logger returned by this module —
 * there is no opt-out — so a log call built from arbitrary upstream data
 * (a request body, a plugin config object, an error's own properties) can
 * never leak a secret-like field, no matter how deeply nested. See
 * spec.md's "Secrets only from environment/.env, never hard-coded, never
 * logged" security baseline.
 *
 * Redaction is a best-effort deep walk, not pino's path-based `redact`
 * option — it does not require the caller to know field paths in advance.
 * To avoid corrupting values that manage their own JSON representation, it
 * leaves a few kinds of value untouched (returned as-is, not descended
 * into): `Date`, `RegExp`, `Map`, `Set`, typed arrays/`Buffer`, and any
 * object exposing its own `toJSON()`. `Error` instances (including
 * {@link "./errors.js".AppError} subclasses) are handled specially: a
 * redacted clone is produced that preserves the original prototype
 * (so pino's error serializer still reports the right `type`) and
 * `message`/`stack`, with any secret-like own enumerable property (e.g. a
 * mistakenly-attached `err.apiToken`) redacted. An error's `cause` is
 * intentionally dropped from the clone rather than redacted imperfectly,
 * since it can wrap arbitrary, unvalidated data.
 */
import { hostname } from "node:os";
import pino, { type Logger, type LoggerOptions } from "pino";

export type { Logger } from "pino";

/**
 * Field-name fragments treated as secret-like wherever they appear as an
 * object key in a log line, at any nesting depth.
 */
export const REDACTED_FIELD_NAMES = [
  "password",
  "secret",
  "token",
  "apikey",
  "authorization",
] as const;

/** Value substituted for any field whose key matches {@link REDACTED_FIELD_NAMES}. */
export const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * Structured context merged into every line a logger emits. Conventional
 * fields: `plugin` (owning plugin id), `requestId` (correlates one HTTP
 * request's lines) — any other field name is also supported.
 */
export type LoggerContext = Record<string, unknown>;

export interface CreateLoggerOptions {
  /** Minimum level to emit. Defaults to `"info"`. */
  level?: LoggerOptions["level"];
  /** Structured context fields merged into every line, e.g. `{ plugin: "wiki" }`. */
  context?: LoggerContext;
  /**
   * Destination stream for the raw ndjson output. Defaults to pino's
   * normal stdout destination. Tests pass an in-memory `Writable` to
   * capture emitted lines.
   */
  stream?: NodeJS.WritableStream;
}

/** Lowercase and strip separators so `API_KEY`, `apiKey`, and `x-api-key` all compare equal to `apikey`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretLikeKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return REDACTED_FIELD_NAMES.some((name) => normalized.includes(name));
}

/** Values pino/JSON.stringify know how to serialize themselves; redact around them, not into them. */
function isOpaqueValue(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    ArrayBuffer.isView(value) ||
    typeof (value as { toJSON?: unknown }).toJSON === "function"
  );
}

/** Redact an Error's secret-like own enumerable properties, preserving its prototype, message, and stack. */
function redactError(value: Error, seen: WeakSet<object>): Error {
  const clone = Object.create(Object.getPrototypeOf(value) as object) as Record<string, unknown>;
  Object.defineProperty(clone, "message", {
    value: value.message,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(clone, "stack", {
    value: value.stack,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  for (const [key, val] of Object.entries(value)) {
    clone[key] = isSecretLikeKey(key) ? REDACTED_PLACEHOLDER : redactValue(val, seen);
  }
  return clone as unknown as Error;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  if (value instanceof Error) {
    return redactError(value, seen);
  }

  if (isOpaqueValue(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    redacted[key] = isSecretLikeKey(key) ? REDACTED_PLACEHOLDER : redactValue(val, seen);
  }
  return redacted;
}

/**
 * Recursively redact any secret-like field in `value` (see module docs for
 * exactly which values are walked into vs. left opaque), returning a new
 * value — `value` itself is never mutated.
 */
export function redactSecrets<T>(value: T): T {
  return redactValue(value, new WeakSet<object>()) as T;
}

/** Redact only the first ("merging object" / error) argument of a pino log call; message/interpolation args are never objects worth redacting. */
function redactLogArgs(inputArgs: unknown[]): unknown[] {
  const [first, ...rest] = inputArgs;
  if (first !== null && typeof first === "object") {
    return [redactValue(first, new WeakSet<object>()), ...rest];
  }
  return inputArgs;
}

/**
 * Create a pino-backed structured logger. Every line is redacted per this
 * module's secret-redaction policy before it is emitted, with `context`
 * merged into every line alongside pino's usual `level`/`time`/`pid`/
 * `hostname` fields.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const { level = "info", context = {}, stream } = options;

  const pinoOptions: LoggerOptions = {
    level,
    base: {
      pid: process.pid,
      hostname: hostname(),
      ...redactSecrets(context),
    },
    hooks: {
      logMethod(inputArgs, method) {
        return method.apply(this, redactLogArgs(inputArgs) as Parameters<typeof method>);
      },
    },
  };

  return stream ? pino(pinoOptions, stream) : pino(pinoOptions);
}

/**
 * Derive a child logger that layers additional structured context (e.g.
 * `{ requestId: "req-1" }`) on top of `logger`'s existing context. The
 * child inherits the parent's redaction behavior — every line it emits is
 * still redacted per this module's policy.
 */
export function withContext(logger: Logger, context: LoggerContext): Logger {
  return logger.child(redactSecrets(context));
}

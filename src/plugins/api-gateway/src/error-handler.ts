/**
 * Uniform 4xx (and 5xx) error envelope for the api-gateway-owned Fastify
 * instance (feature #60 — "Request validation and a consistent 4xx error
 * envelope" — and feature #61 — "Centralized error handler with a
 * consistent envelope and no stack-trace leaks in production").
 *
 * spec.md frames api-gateway as providing "request validation, consistent
 * error envelopes" over raw Fastify — this module is where that promise is
 * actually kept. Without it, three different failure paths would each
 * produce a *different* JSON shape on the wire:
 *
 *   1. A route registered via `registerRoute()` (feature #59) declares a
 *      request schema; when an incoming request fails Fastify's own ajv
 *      validation, Fastify's *default* error handler replies with its own
 *      `{ statusCode, code, error, message }` shape — not this kernel's
 *      `{code, message, details}` envelope (see `errors.ts`'s
 *      `AppErrorJSON`).
 *   2. A route handler throws an {@link AppError} subclass (`ValidationError`,
 *      `CapabilityDeniedError`, ...) — without a custom handler, Fastify
 *      would serialize the raw Error object (message/stack), not
 *      `AppError#toJSON()`.
 *   3. No route matches at all (404) — Fastify's default not-found handler
 *      replies with yet another ad hoc shape.
 *   4. A route handler throws something that is *not* an `AppError` at all
 *      (a plain `Error`, a thrown string, a bug) — the genuinely
 *      "unexpected" case feature #61 is about. Without a custom handler,
 *      Fastify would serialize that raw error (message + stack) straight
 *      onto the wire, which is exactly the internal-detail leak spec.md's
 *      Error Isolation requirement forbids.
 *
 * `registerErrorHandling(app)` wires one `setErrorHandler` (cases 1, 2 & 4)
 * and one `setNotFoundHandler` (case 3) so every one of these collapses to
 * the exact same `{code, message, details?}` envelope every other AppError
 * already produces, via `AppError#toJSON()` / `toErrorEnvelope()`.
 *
 * ## No stack-trace leaks in production (feature #61)
 *
 * Case 4 (an unexpected, non-`AppError` failure) is always logged with full
 * detail (`request.log.error({ err: error }, ...)`) — the logger's own
 * secret redaction (`logger.ts`, feature #3) already makes this safe at any
 * `NODE_ENV`, and an operator needs the real message/stack to debug it. The
 * HTTP *response* body is a different trust boundary: `toErrorEnvelope()`'s
 * `message` is always the generic `"An unexpected error occurred."` in
 * *every* environment (the raw internal message is never echoed back to a
 * client, production or not) — the only thing environment-gated is whether
 * `stack` is attached at all, via `includeStack: nodeEnv !== "production"`,
 * purely as a local-debugging convenience for `development`/`test`. See
 * {@link RegisterErrorHandlingOptions.nodeEnv}.
 */
import type { CoreConfig } from "../../../core/config.js";
import {
  NotFoundError,
  ValidationError,
  isAppError,
  toErrorEnvelope,
} from "../../../core/errors.js";
import type { ApiGatewayApp } from "../index.js";

/**
 * The shape Fastify's own ajv-backed schema validation actually throws at
 * runtime (`request.validationError` / the error passed to
 * `setErrorHandler`) — Fastify's own types leave `validation` off the base
 * `FastifyError` interface (see `@fastify/error`'s `FastifyError`), so this
 * is a narrow runtime-checked shape, not an import from a Fastify type.
 */
interface FastifyValidationError extends Error {
  readonly validation: readonly unknown[];
  readonly validationContext?: string;
}

function isFastifyValidationError(error: unknown): error is FastifyValidationError {
  return (
    typeof error === "object" &&
    error !== null &&
    "validation" in error &&
    Array.isArray((error as { validation: unknown }).validation)
  );
}

function readStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }
  const value = (error as { statusCode: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const value = (error as { code: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

/**
 * Fastify's own schema-validation failure (case 1 above) normalized into
 * this kernel's error taxonomy: a {@link ValidationError} whose `details`
 * carries ajv's own per-violation `validation` array (instance path,
 * keyword, message, ...) so an API consumer gets the same machine-readable
 * detail Fastify already computed, just wrapped in the uniform envelope
 * instead of Fastify's bespoke shape.
 */
function toValidationError(error: FastifyValidationError): ValidationError {
  return new ValidationError(`Request validation failed: ${error.message}`, {
    details: {
      validation: error.validation,
      ...(error.validationContext !== undefined
        ? { validationContext: error.validationContext }
        : {}),
    },
  });
}

/**
 * A non-AppError, non-validation error Fastify itself raised before a
 * handler ever ran (malformed JSON body, unsupported content-type, a
 * duplicate/invalid route registration surfacing at request time, etc.) —
 * these already carry a real 4xx `statusCode` and Fastify's own stable
 * `FST_ERR_*` code, so they're wrapped as a generic client error rather
 * than collapsed to `INTERNAL_ERROR` like a genuinely unexpected failure
 * would be.
 */
function toGenericClientErrorEnvelope(error: unknown) {
  return {
    code: readErrorCode(error) ?? "BAD_REQUEST",
    message:
      error instanceof Error && error.message.length > 0
        ? error.message
        : "The request was invalid.",
  };
}

export interface RegisterErrorHandlingOptions {
  /**
   * Which runtime environment this Fastify instance is serving — governs
   * only whether an *unexpected* (non-`AppError`) error's response body may
   * include a stack trace for local debugging (`stack` is attached outside
   * `"production"`); the response `message`/`code` never change with
   * environment, and `AppError` responses are entirely unaffected (their
   * `publicMessage` is already safe by construction — see `errors.ts`).
   *
   * Defaults to `process.env.NODE_ENV`, falling back to `"development"` to
   * match `config.ts`'s `CoreConfigSchema` default — mirrors how
   * `bootstrapKernel()` defaults its own `env` option to `process.env`
   * (`src/server/index.ts`). Plugin lifecycle hooks are not currently handed
   * the kernel's resolved `CoreConfig` (`PluginLifecycleContext` only
   * carries `manifest`/`capabilities`/`logger` — see `loader.ts`), so this
   * reads the ambient env directly rather than threading config through the
   * loader; an explicit override is accepted precisely so tests never have
   * to depend on ambient process state (see `error-handler.test.ts`).
   */
  nodeEnv?: CoreConfig["NODE_ENV"];
}

function resolveNodeEnv(nodeEnv: CoreConfig["NODE_ENV"] | undefined): CoreConfig["NODE_ENV"] {
  if (nodeEnv !== undefined) {
    return nodeEnv;
  }
  const fromEnv = process.env["NODE_ENV"];
  return fromEnv === "production" || fromEnv === "test" || fromEnv === "development"
    ? fromEnv
    : "development";
}

/**
 * Wire the uniform error/not-found envelope onto `app` (see module docs).
 * Called once from `buildApp()` in `../index.ts`, right after the instance
 * is constructed — before any route (including `/health`) is registered, so
 * every route this plugin or a consumer registers is covered from the
 * start.
 */
export function registerErrorHandling(
  app: ApiGatewayApp,
  options: RegisterErrorHandlingOptions = {},
): void {
  const nodeEnv = resolveNodeEnv(options.nodeEnv);
  const isProduction = nodeEnv === "production";

  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      reply.status(error.statusCode).send(error.toJSON());
      return;
    }

    if (isFastifyValidationError(error)) {
      const validationError = toValidationError(error);
      reply.status(validationError.statusCode).send(validationError.toJSON());
      return;
    }

    const statusCode = readStatusCode(error) ?? 500;
    if (statusCode >= 400 && statusCode < 500) {
      reply.status(statusCode).send(toGenericClientErrorEnvelope(error));
      return;
    }

    // Unexpected (non-AppError) failure. Always logged with full detail —
    // logger.ts's secret redaction (feature #3) already makes this safe at
    // any NODE_ENV, and an operator needs the real message/stack to debug
    // it — but the HTTP response only ever gets a generic body in
    // production; outside production a stack trace is attached purely as a
    // local-debugging convenience. The response `message` itself is
    // ALWAYS the generic "An unexpected error occurred." — toErrorEnvelope()
    // never echoes the raw internal message back to a client, in any
    // environment (see its own docs in errors.ts).
    request.log.error({ err: error }, "Unhandled error while processing request.");
    reply.status(statusCode).send(toErrorEnvelope(error, { includeStack: !isProduction }));
  });

  app.setNotFoundHandler((request, reply) => {
    // Echoing the request's own method/path back is safe here (unlike most
    // AppError subclasses' generic default publicMessage) — it's exactly
    // what the client itself just sent, not internal server detail, so
    // there's no leak in surfacing it directly as the public message too.
    const message = `No route matches ${request.method} ${request.url}.`;
    const error = new NotFoundError(message, { publicMessage: message });
    reply.status(error.statusCode).send(error.toJSON());
  });
}

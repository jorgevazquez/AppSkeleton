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
 * ## Styled HTML error pages for browser requests (feature #116)
 *
 * spec.md's api-gateway/html-renderer split leaves this module owning *when*
 * a request should see a page instead of an envelope, never *what that page
 * looks like* — feature #55's `renderNotFoundPage`/`renderServerErrorPage`
 * (html-renderer's `./src/error-pages.ts`) already own the latter. This
 * module reaches them the same way `./rbac-protection.ts` reaches
 * `rbac:check`: a lazy, per-request `capabilities.obtain("html:error-pages")`
 * (see {@link RegisterErrorHandlingOptions.capabilities}) — never a direct
 * import of html-renderer's `src/` internals, honoring spec.md's "no plugin
 * imports another plugin's internals directly" rule.
 *
 * Step 2's content negotiation ({@link prefersHtml}) decides *which* requests
 * get a page at all: only ones whose `Accept` header actually prefers
 * `text/html` over `application/json` (a real browser navigation) — a
 * request with no `Accept` header (curl, most API/XHR clients, and every
 * existing test in this codebase that never set one) keeps getting the exact
 * same JSON envelope it always has. Only the two status classes feature #55
 * has a template for — 404 (not-found) and 5xx (server error) — ever switch
 * to HTML; every other status (400/401/403/429/...) is always JSON,
 * regardless of `Accept`, since no page exists for those. And `capabilities`
 * is optional and every failure to obtain it (not supplied, not granted, no
 * provider registered yet) falls back to the exact same JSON path — this
 * feature can only ever *add* a rendering option for a request that already
 * asked for one, never remove the JSON guarantee feature #61 already made.
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
import type { PluginCapabilityAccess } from "../../../core/broker.js";
import type { CoreConfig } from "../../../core/config.js";
import {
  NotFoundError,
  ValidationError,
  isAppError,
  toErrorEnvelope,
} from "../../../core/errors.js";
import { isErr } from "../../../core/types.js";
import type { ErrorPagesCapability } from "../../html-renderer/index.js";
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

/** One `Accept` header entry (e.g. `text/html;q=0.9`), parsed into its type/subtype and effective quality. */
interface AcceptEntry {
  readonly type: string;
  readonly subtype: string;
  readonly q: number;
}

/**
 * Parse a raw `Accept` header value into its comma-separated media-range
 * entries. Deliberately minimal — this codebase has no other content
 * negotiation to share a full RFC 7231 implementation with, and step 2 only
 * ever compares two fixed candidates ({@link prefersHtml}), so this need only
 * extract each entry's type/subtype and optional `q` parameter, not the full
 * accept-params grammar (charset, media-range extension params, etc.). An
 * entry this can't parse cleanly (an empty segment, a malformed `q`) falls
 * back to the RFC default of `q=1` rather than being dropped, so a slightly
 * unusual header never *silently* loses a client's stated preference.
 */
function parseAcceptEntries(header: string): AcceptEntry[] {
  return header
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const [mediaType, ...params] = segment.split(";").map((part) => part.trim());
      const [type, subtype] = (mediaType ?? "*/*").split("/");
      let q = 1;
      for (const param of params) {
        const [key, value] = param.split("=").map((part) => part.trim());
        if (key === "q" && value !== undefined && value.length > 0) {
          const parsed = Number(value);
          if (!Number.isNaN(parsed)) {
            q = parsed;
          }
        }
      }
      return { type: type ?? "*", subtype: subtype ?? "*", q };
    });
}

/** The highest quality value any entry in `entries` assigns to `type/subtype` — via an exact match, a `type` wildcard-subtype range, or a bare wildcard-everything entry — or `0` if nothing matches at all. */
function acceptQuality(entries: readonly AcceptEntry[], type: string, subtype: string): number {
  let best = 0;
  for (const entry of entries) {
    const typeMatches = entry.type === "*" || entry.type === type;
    const subtypeMatches = entry.subtype === "*" || entry.subtype === subtype;
    if (typeMatches && subtypeMatches) {
      best = Math.max(best, entry.q);
    }
  }
  return best;
}

/**
 * Step 2: does this request prefer the styled HTML error page over the JSON
 * envelope? Based purely on the request's own `Accept` header, per this
 * feature's step 2 wording — nothing else (method, path, `X-Requested-With`,
 * ...) factors in.
 *
 * A request with **no** `Accept` header at all (the common case for curl,
 * most API/XHR clients, and every pre-existing test in this codebase) always
 * gets JSON — matching the pre-#116 behavior exactly, so this feature can
 * only ever add HTML for a request that explicitly asked for it, never take
 * JSON away from one that didn't. A browser's typical full navigation Accept
 * header (e.g. `text/html,application/xhtml+xml,application/xml;q=0.9`, plus
 * a trailing wildcard-everything fallback entry) ranks `text/html` above
 * that wildcard fallback and gets HTML; an explicit `Accept: application/json`
 * (or a bare wildcard-everything Accept value, where both candidates tie)
 * gets JSON either way, since HTML only wins on a *strict* preference over
 * JSON, never a tie.
 */
export function prefersHtml(acceptHeader: string | string[] | undefined): boolean {
  if (acceptHeader === undefined) {
    return false;
  }
  const header = Array.isArray(acceptHeader) ? acceptHeader.join(",") : acceptHeader;
  if (header.trim().length === 0) {
    return false;
  }
  const entries = parseAcceptEntries(header);
  const htmlQuality = acceptQuality(entries, "text", "html");
  const jsonQuality = acceptQuality(entries, "application", "json");
  return htmlQuality > 0 && htmlQuality > jsonQuality;
}

/** The capability id html-renderer registers `renderNotFoundPage`/`renderServerErrorPage` under (feature #116, `../../html-renderer/index.js`). */
const HTML_ERROR_PAGES_CAPABILITY_ID = "html:error-pages";

/**
 * Obtain `html:error-pages`, or `undefined` if it can't be reached right
 * now — not granted, html-renderer isn't loaded, or (the common case in this
 * module's own unit tests, see `error-handler.test.ts`) no `capabilities`
 * handle was supplied at all. Every call site treats `undefined` the same
 * way `./rbac-protection.ts` treats a failed `rbac:check` obtain: fall back
 * to the safe, always-available behavior (here, the JSON envelope) rather
 * than failing the request — a deployment that never wires html-renderer in
 * still gets fully correct (JSON-only) error responses.
 *
 * Wrapped in a `try`/`catch`, unlike `rbac-protection.ts`'s own obtain call:
 * this runs unconditionally on *every* error/not-found response — including
 * ones produced by a hand-built test `capabilities` stub that deliberately
 * throws for any capability id it wasn't built to expect (e.g.
 * `request-id.test.ts`'s `makeContext()`), not just real broker denials
 * (which `PluginCapabilityAccess.obtain`'s own contract already returns as
 * an `Err`, never a throw). Either way the outcome is identical: no
 * error-pages capability, so the JSON envelope this feature must never take
 * away wins.
 */
function resolveErrorPages(
  capabilities: PluginCapabilityAccess | undefined,
): ErrorPagesCapability | undefined {
  if (capabilities === undefined) {
    return undefined;
  }
  try {
    const obtained = capabilities.obtain<ErrorPagesCapability>(HTML_ERROR_PAGES_CAPABILITY_ID);
    return isErr(obtained) ? undefined : obtained.value;
  } catch {
    return undefined;
  }
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
  /**
   * The narrow, identity-bound capability-broker handle used to
   * (best-effort) obtain `html:error-pages` (feature #116) — `context.capabilities`
   * from api-gateway's own `PluginLifecycleContext`, the same handle
   * `../index.ts`'s `onEnable` passes to `registerRbacProtection`. Optional,
   * and resolved lazily per-request (see {@link resolveErrorPages}) for the
   * same load-order-race reason `./rbac-protection.ts` obtains `rbac:check`
   * lazily rather than at registration time — html-renderer isn't guaranteed
   * to have registered its provider yet when `buildApp()` calls this
   * function. Omitted entirely by this module's own unit tests
   * (`error-handler.test.ts`), which only need the JSON envelope; those
   * requests never set an `Accept` header preferring `text/html` either way,
   * so the behavior is identical to before this feature.
   */
  capabilities?: PluginCapabilityAccess;
}

/** Minimal structural shape this module needs from a Fastify request — just enough of `request.headers.accept` for {@link prefersHtml}. */
interface ErrorResponseRequest {
  readonly headers: { readonly accept?: string | string[] | undefined };
  readonly url: string;
}

/** Minimal structural shape this module needs from a Fastify reply — real `FastifyReply` satisfies this. */
interface ErrorResponseReply {
  status(statusCode: number): ErrorResponseReply;
  type(contentType: string): ErrorResponseReply;
  send(payload: unknown): ErrorResponseReply;
}

/**
 * Send `jsonBody` at `statusCode` — or, for a request whose `Accept` header
 * prefers HTML ({@link prefersHtml}) and only when `errorPages` was
 * successfully obtained ({@link resolveErrorPages}) and `htmlPage` is
 * supplied (i.e. `statusCode` is one of the two classes feature #55 has a
 * template for), the corresponding styled page instead. Every call site
 * below already computes the exact same `jsonBody` it always has — this
 * function only ever *substitutes* the response body/content-type, never
 * changes the status code feature #61 already decided.
 */
function sendErrorResponse(
  request: ErrorResponseRequest,
  reply: ErrorResponseReply,
  statusCode: number,
  jsonBody: unknown,
  htmlPage: { readonly nodeEnv: CoreConfig["NODE_ENV"]; readonly error?: unknown } | undefined,
  errorPages: ErrorPagesCapability | undefined,
): void {
  if (htmlPage !== undefined && errorPages !== undefined && prefersHtml(request.headers.accept)) {
    const html =
      statusCode === 404
        ? errorPages.renderNotFoundPage({ path: request.url })
        : errorPages.renderServerErrorPage({
            nodeEnv: htmlPage.nodeEnv,
            ...(htmlPage.error !== undefined ? { error: htmlPage.error } : {}),
          });
    reply.status(statusCode).type("text/html; charset=utf-8").send(html);
    return;
  }
  reply.status(statusCode).send(jsonBody);
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
    const errorPages = resolveErrorPages(options.capabilities);

    if (isAppError(error)) {
      // Only the two status classes feature #55 has a template for ever get
      // an HTML alternative — 404 (e.g. a handler's own thrown
      // NotFoundError, not just the setNotFoundHandler path below) and 5xx
      // (an AppError subclass that itself maps to a server error, e.g.
      // DatabaseError). Every other AppError status (400/401/403/429/...)
      // stays JSON-only, matching feature #61's behavior exactly.
      const htmlPage =
        error.statusCode === 404 || error.statusCode >= 500 ? { nodeEnv, error } : undefined;
      sendErrorResponse(request, reply, error.statusCode, error.toJSON(), htmlPage, errorPages);
      return;
    }

    if (isFastifyValidationError(error)) {
      // Always a 400 — no page template applies, so this stays JSON-only
      // regardless of Accept, same as before this feature.
      const validationError = toValidationError(error);
      reply.status(validationError.statusCode).send(validationError.toJSON());
      return;
    }

    const statusCode = readStatusCode(error) ?? 500;
    if (statusCode >= 400 && statusCode < 500) {
      // Same reasoning as the validation-error branch above: no 4xx
      // template exists, so this stays JSON-only.
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
    // environment (see its own docs in errors.ts). The styled 500 page
    // (browser requests only) is governed by the exact same nodeEnv gate —
    // `renderServerErrorPage` only ever shows `error`'s own detail when
    // `nodeEnv === "development"`, see `error-pages.ts`.
    request.log.error({ err: error }, "Unhandled error while processing request.");
    sendErrorResponse(
      request,
      reply,
      statusCode,
      toErrorEnvelope(error, { includeStack: !isProduction }),
      { nodeEnv, error },
      errorPages,
    );
  });

  app.setNotFoundHandler((request, reply) => {
    // Echoing the request's own method/path back is safe here (unlike most
    // AppError subclasses' generic default publicMessage) — it's exactly
    // what the client itself just sent, not internal server detail, so
    // there's no leak in surfacing it directly as the public message too.
    const message = `No route matches ${request.method} ${request.url}.`;
    const error = new NotFoundError(message, { publicMessage: message });
    const errorPages = resolveErrorPages(options.capabilities);
    sendErrorResponse(request, reply, error.statusCode, error.toJSON(), { nodeEnv }, errorPages);
  });
}

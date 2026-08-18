/**
 * Core error taxonomy for the kernel.
 *
 * Every error that can cross a plugin/kernel boundary or reach an API
 * response must be an {@link AppError} (or subclass). AppError enforces a
 * strict split between:
 *
 *   - `message`       — full internal detail. Safe to log, may reference
 *                        internals (file paths, plugin ids, SQL, secrets'
 *                        *names* but never their values). Never sent to a
 *                        client.
 *   - `publicMessage` — a safe, non-leaking string that MAY be shown to an
 *                        API caller or end user. Defaults to a generic,
 *                        class-specific message; callers may override it
 *                        with their own safe copy.
 *   - `code`           — a stable, machine-readable identifier consumers
 *                        can branch on. Must never change across refactors
 *                        once shipped.
 *   - `statusCode`     — the default HTTP status an api-gateway-style
 *                        caller should map this error to.
 *
 * `toJSON()` produces the shape used in API error envelopes. It never
 * includes the stack trace (or the internal `message`) unless the caller
 * explicitly opts in via `{ includeStack: true }` — see spec.md's Error
 * Isolation requirement: a plugin failure must never leak internals to a
 * client by default.
 */

/** JSON shape suitable for an API error envelope (e.g. `{ error: ... }`). */
export interface AppErrorJSON {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  stack?: string;
}

export interface AppErrorOptions {
  /** Safe, user/API-facing message. Defaults to a generic per-class message. */
  publicMessage?: string;
  /** Extra structured context. Must not contain secrets; included in toJSON(). */
  details?: Record<string, unknown>;
  /** Underlying cause, for internal diagnostics only. Never serialized. */
  cause?: unknown;
}

export interface AppErrorToJSONOptions {
  /** Include the stack trace in the serialized output. Default: false. */
  includeStack?: boolean;
}

/**
 * Base class for every error the kernel or a plugin raises through a
 * declared capability boundary. Abstract: always throw/construct a
 * concrete subclass (ValidationError, ConfigError, ...), never AppError
 * itself, so every error carries a real `code`.
 */
export abstract class AppError extends Error {
  /** Stable, machine-readable error code. Fixed per subclass. */
  abstract readonly code: string;

  /** Default HTTP status code an API layer should map this error to. */
  abstract readonly statusCode: number;

  /** Safe message that may be shown to an API caller or end user. */
  readonly publicMessage: string;

  /** Safe structured context, included in the serialized envelope. */
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.publicMessage = options.publicMessage ?? this.defaultPublicMessage();
    if (options.details !== undefined) {
      this.details = options.details;
    }
    Error.captureStackTrace(this, new.target);
  }

  /** Generic, safe fallback public message. Subclasses override this. */
  protected defaultPublicMessage(): string {
    return "An unexpected error occurred.";
  }

  /**
   * Serialize to the JSON shape used in API error envelopes. Never
   * includes the stack trace or the internal `message` unless
   * `includeStack` is explicitly requested (e.g. for a local/dev-only
   * diagnostics surface).
   */
  toJSON(options: AppErrorToJSONOptions = {}): AppErrorJSON {
    const json: AppErrorJSON = {
      code: this.code,
      message: this.publicMessage,
    };
    if (this.details !== undefined) {
      json.details = this.details;
    }
    if (options.includeStack && typeof this.stack === "string") {
      json.stack = this.stack;
    }
    return json;
  }
}

/** Input failed validation against a schema or business rule. */
export class ValidationError extends AppError {
  readonly code = "VALIDATION_ERROR";
  readonly statusCode = 400;

  protected override defaultPublicMessage(): string {
    return "The request was invalid.";
  }
}

/** Kernel or plugin configuration is missing, malformed, or contradictory. */
export class ConfigError extends AppError {
  readonly code = "CONFIG_ERROR";
  readonly statusCode = 500;

  protected override defaultPublicMessage(): string {
    return "The server is misconfigured.";
  }
}

/** A plugin failed to load, validate, or initialize. */
export class PluginLoadError extends AppError {
  readonly code = "PLUGIN_LOAD_ERROR";
  readonly statusCode = 500;

  protected override defaultPublicMessage(): string {
    return "A plugin failed to load.";
  }
}

/** A plugin attempted to use a capability it was not granted. */
export class CapabilityDeniedError extends AppError {
  readonly code = "CAPABILITY_DENIED";
  readonly statusCode = 403;

  protected override defaultPublicMessage(): string {
    return "You do not have permission to perform this action.";
  }
}

/**
 * No resource matched the request. Used by api-gateway's uniform 4xx error
 * envelope (feature #60) for both an unmatched route (no handler registered
 * for the requested method/path) and, optionally, a plugin handler's own
 * "the thing you asked for doesn't exist" case (e.g. wiki's future page
 * lookup) — either way the client sees the same `{code, message, details}`
 * shape every other AppError produces, never Fastify's own default
 * `{statusCode, error, message}` 404 body.
 */
export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  readonly statusCode = 404;

  protected override defaultPublicMessage(): string {
    return "The requested resource was not found.";
  }
}

/**
 * A query or transaction run through the database-mysql plugin's db:query /
 * db:transaction capability failed (a driver-level error such as a
 * constraint violation, an unreachable server, or a malformed query) —
 * never thrown for a capability *permission* problem, which is always
 * {@link CapabilityDeniedError} instead. `message` may safely include the
 * driver's own error text (never a query's bound parameter *values*, which
 * mysql2/kysely keep out of the SQL text entirely — see db:query's own
 * docs); `publicMessage` stays generic so a raw driver error never reaches
 * an API caller.
 */
export class DatabaseError extends AppError {
  readonly code = "DATABASE_ERROR";
  readonly statusCode = 500;

  protected override defaultPublicMessage(): string {
    return "A database error occurred.";
  }
}

/**
 * The database-mysql plugin's migration runner (feature #19) refused to run
 * — either because an already-applied migration file's checksum no longer
 * matches what was recorded when it ran (the file was modified after the
 * fact, or an applied migration's file is missing entirely), or because a
 * migration's `up`/`down` module is malformed (missing a required export).
 * Never thrown for a driver-level failure while actually executing a
 * migration's SQL — that surfaces as {@link DatabaseError} instead, since it
 * crosses the same "real query failed" boundary db:query/db:transaction do.
 * `message` may safely include migration file names/checksums (never file
 * *contents*); `publicMessage` stays generic since this is an
 * operator/CLI-facing failure, not something an API client should ever see.
 */
export class MigrationError extends AppError {
  readonly code = "MIGRATION_ERROR";
  readonly statusCode = 500;

  protected override defaultPublicMessage(): string {
    return "A database migration error occurred.";
  }
}

/**
 * The html-renderer template engine (feature #49 — partials/components)
 * failed while actually rendering a compiled template: a `{{> partial}}`
 * tag named a partial that isn't in the registry passed to
 * `compileWithPartials`, a referenced partial's own source failed to
 * parse, or a chain of partial inclusions (typically one that includes
 * itself, directly or transitively, without a terminating condition) blew
 * past the engine's max recursion depth. Thrown from
 * `CompiledTemplate.render()`, never returned as a `Result`, because these
 * are render-time (data- and registry-dependent) conditions — every other
 * template error (a malformed `{{tag}}`, an unresolvable `{{extends}}`
 * layout, ...) is instead caught by compile-time validation before
 * `render()` is ever reachable, and stays on the `Result` convention.
 */
export class RenderError extends AppError {
  readonly code = "RENDER_ERROR";
  readonly statusCode = 500;

  protected override defaultPublicMessage(): string {
    return "A template failed to render.";
  }
}

/**
 * The dev-only seed/fixtures runner (feature #25 — "Seed data / fixtures
 * mechanism for local development") refused to run. Two distinct causes
 * share this error: (1) the production guard tripped — `runSeeds()` was
 * invoked with `NODE_ENV=production` (see `core/seed.ts`'s
 * `assertSeedingAllowed()`), the second, independent layer behind
 * `init.sh`'s explicit `--seed` opt-in flag that keeps a production run
 * from ever seeding automatically; or (2) a plugin tried to
 * {@link "./seed.js".registerSeed} a name it had already registered,
 * catching a copy-paste bug at registration time rather than letting a
 * seed silently shadow another. Never thrown for a failure *while actually
 * running* a seed's own `run(db)` function — a driver-level failure there
 * surfaces as {@link DatabaseError} instead, exactly like migrator.ts's own
 * split between `MigrationError` (runner-level refusals) and
 * `DatabaseError` (a migration's SQL itself failing).
 */
export class SeedError extends AppError {
  readonly code = "SEED_ERROR";
  readonly statusCode = 500;

  protected override defaultPublicMessage(): string {
    return "A seed data error occurred.";
  }
}

/** Narrow an unknown thrown value down to the AppError taxonomy. */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

const UNKNOWN_ERROR_JSON: AppErrorJSON = {
  code: "INTERNAL_ERROR",
  message: "An unexpected error occurred.",
};

/**
 * Normalize any thrown value into a safe API error envelope. AppErrors
 * serialize via their own `toJSON()`; anything else (a plain Error, a
 * thrown string, whatever a misbehaving plugin does) collapses to a
 * generic, non-leaking `INTERNAL_ERROR` shape so a broken plugin can never
 * smuggle internal detail — or a stack trace — out through an API
 * response. See spec.md's Error Isolation requirement.
 */
export function toErrorEnvelope(error: unknown, options: AppErrorToJSONOptions = {}): AppErrorJSON {
  if (isAppError(error)) {
    return error.toJSON(options);
  }
  if (options.includeStack && error instanceof Error && typeof error.stack === "string") {
    return { ...UNKNOWN_ERROR_JSON, stack: error.stack };
  }
  return { ...UNKNOWN_ERROR_JSON };
}

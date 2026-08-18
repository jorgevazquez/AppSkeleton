/**
 * Compiled-template caching with dev-mode invalidation on file change
 * (feature #53 — "Compiled template caching with dev-mode invalidation on
 * file change"). Builds directly on feature #46's {@link compileTemplate}
 * (`./template.ts`) — this module adds nothing to the template grammar or
 * compiler itself; it is purely a caching layer in front of it for the
 * common case where a template's source lives in a file on disk and the
 * same file path is compiled/rendered over and over (once per request, for
 * example).
 *
 * ## Why cache at all
 *
 * `compileTemplate` is already "parse once, render many times" *within* a
 * single `CompiledTemplate` (see template.ts's module doc) — but a caller
 * that re-reads a template file from disk and calls `compileTemplate` again
 * on every request pays that parse/compile cost every single time anyway,
 * for source text that (outside of active local editing) never changes.
 * {@link createTemplateCache} adds the missing layer: compile a given file
 * path once, and keep handing back the same {@link CompiledTemplate}
 * instance on every subsequent {@link TemplateCache.get} call for that path
 * — until, in development, the file actually changes on disk.
 *
 * ## Keyed by path + mtime/hash
 *
 * The cache is a `Map` keyed by template path, but a path alone isn't
 * enough to know whether a cached entry is still valid — so each entry also
 * records the file's `mtimeMs` (from `fs.statSync`) and a sha256 hash of its
 * source (the same digest-based change-detection `database-mysql`'s
 * migrator.ts and `assets.ts`'s ETag already use elsewhere in this
 * codebase) at the moment it was compiled. `mtimeMs` is checked first, as a
 * cheap fast path that avoids re-hashing (and re-reading, given
 * `readTemplateFile` already had to read the file to know its mtime)
 * unchanged source on every single `get()` call; the hash is only consulted
 * when the mtime has moved, so a `touch` (or a save that round-trips
 * byte-identical content) updates the recorded mtime without paying for a
 * recompile. Only an actual content change — a hash mismatch — triggers one.
 *
 * ## Dev vs. production
 *
 * - In development (and `test`, which behaves the same way here — see
 *   {@link resolveCacheMode}), every `get()` call re-reads the file via
 *   `readTemplateFile` and re-checks mtime/hash against the cached entry,
 *   recompiling when they disagree. This is what makes local edits to a
 *   template show up on the very next render with no server restart.
 * - In production, once a path has been compiled the first time, `get()`
 *   never calls `readTemplateFile` for it again — the cached
 *   `CompiledTemplate` is handed back immediately, for the remainder of the
 *   process, regardless of what happens to the file on disk afterwards.
 *   This is both a performance property (zero filesystem calls per
 *   render/request once warm) and a deliberate safety one: a production
 *   deployment's template set is expected to be static for the process's
 *   lifetime, so silently picking up an on-disk edit (e.g. from a
 *   compromised or partially-deployed filesystem) is not a behavior this
 *   cache offers outside of development.
 *
 * ## What this module deliberately doesn't do
 *
 * Like `layout.ts`/`partial.ts` before it, this is infrastructure living in
 * html-renderer's `src/` without being wired into the `render:template`
 * capability's surface (`../index.ts`) — widening that capability to expose
 * path-based, cached compilation to other plugins is a later feature's job,
 * not this one's. `readTemplateFile`'s default implementation uses plain
 * synchronous `node:fs` (mirroring `core/config.ts`'s override-file loader
 * and `migrator.ts`'s checksum reads — both already read template-shaped
 * files with `readFileSync` elsewhere in this codebase) but is fully
 * injectable, so a caller (or a test) never has to touch a real file on
 * disk to exercise this module's caching/invalidation behavior.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { CoreConfig } from "../../../core/config.js";
import { ValidationError } from "../../../core/errors.js";
import { err, ok, type Result } from "../../../core/types.js";
import { compileTemplate, type CompiledTemplate, type CompileOptions } from "./template.js";

/**
 * A template file's source plus a cheap change-detection signal, as
 * returned by {@link TemplateCacheOptions.readTemplateFile}. `mtimeMs`
 * drives the fast path (see module doc's "Keyed by path + mtime/hash"
 * section); `source` is hashed as the fallback check when `mtimeMs` has
 * moved since the last read.
 */
export interface TemplateFileSnapshot {
  readonly source: string;
  readonly mtimeMs: number;
}

export interface TemplateCacheOptions {
  /**
   * Which runtime environment governs cache invalidation — `"production"`
   * makes the cache immutable per process lifetime; anything else
   * (`"development"`, `"test"`) re-checks the file on every {@link
   * TemplateCache.get} call. Defaults to `process.env.NODE_ENV`, falling
   * back to `"development"` — mirrors `api-gateway/src/error-handler.ts`'s
   * `resolveNodeEnv`, for the same reason: this module isn't handed the
   * kernel's resolved `CoreConfig` (plugin lifecycle hooks only carry
   * `manifest`/`capabilities`/`logger`, see `loader.ts`), so it reads the
   * ambient env directly, with an explicit override so tests never depend
   * on ambient process state.
   */
  readonly nodeEnv?: CoreConfig["NODE_ENV"];
  /**
   * Reads a template file's current source and mtime. Defaults to plain
   * synchronous `node:fs` (`readFileSync` + `statSync(path).mtimeMs`).
   * Overridable so a caller with its own virtual/in-memory template store
   * (or a test simulating a file changing on disk) never needs a real file.
   */
  readonly readTemplateFile?: (path: string) => TemplateFileSnapshot;
}

/** One cached path's last-known state: the signature it was compiled from, plus the result. */
interface CacheEntry {
  readonly mtimeMs: number;
  readonly hash: string;
  readonly compiled: CompiledTemplate;
}

export interface TemplateCache {
  /**
   * Return the compiled template for `path`, compiling (and caching) it on
   * first access. See the module doc's "Dev vs. production" section for
   * exactly when a cached entry is re-validated against the file on disk
   * versus handed back unconditionally. `options` (feature #50's raw-output
   * audit context, if the template needs one) is only consulted on an
   * actual compile — a cache hit never re-runs `compileTemplate`, so it
   * never observes a `options` passed to a later `get()` call for the same,
   * still-valid, path.
   *
   * Returns a {@link ValidationError} (never throws) both for a malformed
   * template — exactly `compileTemplate`'s own error — and for a
   * `readTemplateFile` failure (e.g. the file doesn't exist), matching this
   * codebase's "expected, recoverable failure is a typed Result" convention
   * (see template.ts, layout.ts).
   */
  get(path: string, options?: CompileOptions): Result<CompiledTemplate, ValidationError>;
  /** How many distinct template paths are currently cached. Exposed for tests/observability. */
  size(): number;
  /** Drop every cached entry, forcing the next `get()` for any path to recompile. */
  clear(): void;
}

function resolveCacheMode(nodeEnv: CoreConfig["NODE_ENV"] | undefined): CoreConfig["NODE_ENV"] {
  if (nodeEnv !== undefined) {
    return nodeEnv;
  }
  const fromEnv = process.env["NODE_ENV"];
  return fromEnv === "production" || fromEnv === "test" || fromEnv === "development"
    ? fromEnv
    : "development";
}

function hashSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function defaultReadTemplateFile(path: string): TemplateFileSnapshot {
  const source = readFileSync(path, "utf8");
  const mtimeMs = statSync(path).mtimeMs;
  return { source, mtimeMs };
}

/**
 * Construct a fresh, empty {@link TemplateCache}. One instance is an
 * independent store with its own `Map` — like `assets.ts`'s
 * `createAssetRegistry` and `broker.ts`/`events.ts`, this is a factory
 * rather than a module-level singleton, so multiple callers (or tests
 * running in the same process) never share cache state unless they
 * explicitly share one instance.
 */
export function createTemplateCache(options: TemplateCacheOptions = {}): TemplateCache {
  const mode = resolveCacheMode(options.nodeEnv);
  const readTemplateFile = options.readTemplateFile ?? defaultReadTemplateFile;
  const entries = new Map<string, CacheEntry>();

  function compileAndStore(
    path: string,
    snapshot: TemplateFileSnapshot,
    compileOptions: CompileOptions | undefined,
  ): Result<CompiledTemplate, ValidationError> {
    const compiledResult = compileTemplate(snapshot.source, compileOptions);
    if (!compiledResult.ok) {
      return compiledResult;
    }
    entries.set(path, {
      mtimeMs: snapshot.mtimeMs,
      hash: hashSource(snapshot.source),
      compiled: compiledResult.value,
    });
    return compiledResult;
  }

  return {
    get(path, compileOptions) {
      const cached = entries.get(path);

      // Production: once compiled, a path's entry is never re-validated against the file on disk
      // again — see the module doc's "Dev vs. production" section. This is the only branch that
      // avoids calling `readTemplateFile` entirely.
      if (cached !== undefined && mode === "production") {
        return ok(cached.compiled);
      }

      let snapshot: TemplateFileSnapshot;
      try {
        snapshot = readTemplateFile(path);
      } catch (cause) {
        return err(
          new ValidationError(
            `Failed to read template file "${path}": ${(cause as Error).message}`,
            { details: { path }, cause },
          ),
        );
      }

      if (cached === undefined) {
        return compileAndStore(path, snapshot, compileOptions);
      }

      if (cached.mtimeMs === snapshot.mtimeMs) {
        // Fast path: mtime hasn't moved since this entry was compiled, so trust it without
        // hashing the (potentially large) source on every single get() call.
        return ok(cached.compiled);
      }

      const hash = hashSource(snapshot.source);
      if (hash === cached.hash) {
        // mtime moved (e.g. a `touch`, or a save that round-tripped identical content) but the
        // actual bytes didn't change — refresh the recorded mtime so the fast path above hits on
        // the next call, without recompiling.
        entries.set(path, { ...cached, mtimeMs: snapshot.mtimeMs });
        return ok(cached.compiled);
      }

      // Content actually changed — recompile and replace the cached entry.
      return compileAndStore(path, snapshot, compileOptions);
    },

    size() {
      return entries.size;
    },

    clear() {
      entries.clear();
    },
  };
}

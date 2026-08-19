/**
 * Static conventions linter for plugin directories (feature #77).
 *
 * `docs/plugin-conventions.md` is the normative, human/AI-agent-facing
 * description of what a spec-compliant plugin looks like — naming, the
 * manifest shape, the capability grammar, and (section 5) the "no plugin
 * imports another plugin's internals directly" rule. That document
 * explicitly defers *automated enforcement* of the naming/capability/import
 * rules to this module (see its section 5: "automated static enforcement
 * ... is the plugin-builder plugin's job"), matching spec.md's description
 * of `plugin-builder` as shipping "a static validator/linter that checks an
 * existing plugin directory against kernel conventions (naming, capability
 * declarations, no forbidden imports)".
 *
 * This is a *static* check — it never imports or executes a plugin's code
 * (unlike the kernel loader, `core/loader.ts`, which enforces some of the
 * same invariants dynamically, at plugin-load time, against whichever
 * capabilities/imports an actual run happens to exercise). Running both
 * matters: the loader only ever sees what the current process's control
 * flow touches; this linter reads every source file up front, so a
 * violation on a rarely-hit code path is still caught before it ships.
 *
 * ## The three checks
 *
 * 1. **Naming** — `plugin.json` must parse as JSON and pass the kernel's
 *    own {@link validateManifest} (id/version/capability-grammar/entry_point
 *    patterns — `core/manifest.ts`), AND its `id` must equal the plugin's
 *    directory name (`docs/plugin-conventions.md` section 2.1). The first
 *    half is already covered elsewhere (`tests/core/manifest.test.ts`); the
 *    directory-match half is *not* enforced by `validateManifest()` itself
 *    (a manifest can be perfectly schema-valid while claiming a different
 *    plugin's id) or by the kernel loader (which keys plugins by the id
 *    inside the manifest, not the directory name) — this is the one gap
 *    only a directory-aware static check can close.
 *
 * 2. **Capability declaration completeness** — every capability id a
 *    plugin's own code actually *obtains* from the broker
 *    (`capabilities.obtain(...)` / `.obtain<T>(...)`) must appear in that
 *    plugin's `capabilities.requires`, and every capability id its
 *    `provides` module export actually implements must appear in
 *    `capabilities.provides`. The loader already enforces the mirror image
 *    of the second half at load time (a declared `provides` entry with no
 *    matching `module.provides[...]` implementation throws — see
 *    `core/loader.ts`); this closes the two gaps the loader does *not*
 *    check: an `obtain()` call for an undeclared capability (which the
 *    broker only refuses the moment that exact code path actually runs —
 *    see `core/broker.ts`'s `not_declared` denial), and a `provides` export
 *    key the manifest never mentions (silently never registered, per
 *    `core/loader.ts` — no error, just a dead extension point).
 *
 * 3. **Forbidden cross-plugin imports** — no source file under a plugin's
 *    own directory may resolve a relative *value* import into another
 *    plugin's directory (`docs/plugin-conventions.md` section 5) or into
 *    `src/server/**` (the kernel bootstrap). This is a static check with no
 *    dynamic counterpart at all — nothing in the kernel prevents a plugin
 *    from `import`-ing another plugin's internals at the module level; the
 *    "only via kernel-brokered capabilities" rule is a source-level
 *    convention this linter is the sole enforcement of.
 *
 *    One deliberate carve-out: a **type-only** import (`import type { X }
 *    from "../../other-plugin/index.js"`, or `export type { X } from
 *    "..."`) is not flagged. This is not a loophole added to make an
 *    inconvenient real violation disappear — it is the actual, established,
 *    shipped convention this repo already uses twice
 *    (`api-gateway/src/rbac-protection.ts` imports `RbacCheckCapability`'s
 *    *type* from `rbac/index.ts`; `api-gateway/src/error-handler.ts`
 *    imports `ErrorPagesCapability`'s type from `html-renderer/index.ts`)
 *    to type a capability handle's shape for `capabilities.obtain<T>(...)`
 *    without hand-duplicating the interface. `import type` carries zero
 *    runtime footprint — `tsc` erases it completely — so it creates no
 *    "global singleton reached via a bare import" (spec.md's actual
 *    concern); the real handle still only ever arrives through
 *    `capabilities.obtain()`. Any *value* import of another plugin's
 *    module — even one that imports only types at heart but isn't spelled
 *    with the `type` keyword — is still flagged, deliberately: this linter
 *    trusts the explicit `type` marker, not an inference about what a given
 *    import "really" needs.
 *
 * ## Comment-blind matching, deliberately
 *
 * Checks 2 and 3 both work by regex over each source file's text — this
 * module is not a full TypeScript parser (no `typescript` compiler
 * dependency here; see below) — but *first* strip comments
 * ({@link stripComments}). Every capability-usage docstring in this actual
 * codebase (e.g. `rbac/index.ts`'s doc comment naming
 * `../api-gateway/index.ts`, or `api-gateway/index.ts`'s doc comments
 * spelling out `capabilities.obtain("rbac:check")` in prose) would
 * otherwise register as a real import/obtain call and produce a false
 * positive against the very code that documents these rules. Every shipped
 * plugin's real `.obtain(...)` call site in this codebase assigns the
 * capability id to a local `const` first and passes the identifier (e.g.
 * `api-gateway/src/rbac-protection.ts`'s `RBAC_CHECK_CAPABILITY_ID`), so
 * {@link extractObtainedCapabilityIds} resolves same-file local
 * `const NAME = "literal"` bindings; an `obtain()` argument that is neither
 * a string literal nor a locally-resolvable identifier (e.g. a value
 * computed at runtime, or imported from elsewhere) cannot be verified
 * statically and is silently skipped rather than guessed at — this is a
 * deliberate, documented scope boundary (a false negative is a missed
 * lint; a false positive is a linter that cries wolf on legitimate code),
 * the same tradeoff `manifest-json-schema.ts` documents for `depends_on`
 * semver *ranges*.
 *
 * ## Check 4: capability cross-check (feature #81)
 *
 * Checks 1–3 above look at one plugin directory in isolation. This fourth
 * check is the one exception: it can only be evaluated across the *whole*
 * set of plugins being linted together, so it only ever runs from
 * {@link lintAllPlugins} (a bare {@link lintPlugin} call has no sibling
 * plugins to compare against, and deliberately does not attempt this check).
 *
 * For every capability id in a plugin's `capabilities.requires`, this checks
 * whether *any* plugin among the ones just linted declares that same id in
 * its own `capabilities.provides`. If none do, that requirement can never
 * actually be satisfied by `capabilities.obtain()` against the plugin set as
 * it currently stands, and an `unsatisfied_capability_requirement` issue is
 * reported. Unlike checks 1–3, this is reported with `severity: "warning"`,
 * not left as an implicit hard error: `docs/plugin-conventions.md`'s own
 * description of `capabilities.requires` calls it "a ceiling, not a
 * guarantee — obtaining still requires an operator grant and a live
 * provider," so a plugin whose provider simply hasn't been written/loaded
 * *yet* (mid-development, or intentionally supplied by a plugin outside this
 * particular scan) is not necessarily broken — it is flagged so the drift is
 * visible, not blocked outright.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { validateManifest, type PluginManifest } from "../../../core/manifest.js";
import { isOk } from "../../../core/types.js";

/** Name of the manifest file every plugin directory is expected to contain. */
export const MANIFEST_FILENAME = "plugin.json";

/** File extensions this linter treats as plugin source, scanned recursively under a plugin's directory. */
const SOURCE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"];

/** Machine-readable code for every kind of violation this linter can report. */
export type ConventionsLintIssueCode =
  | "missing_manifest"
  | "malformed_manifest"
  | "invalid_manifest"
  | "id_directory_mismatch"
  | "undeclared_capability_use"
  | "undeclared_capability_provide"
  | "forbidden_import"
  | "unsatisfied_capability_requirement";

/**
 * How serious a violation is. Omitted (`undefined`) means the historical
 * default of every check this linter shipped before feature #81 — a hard
 * convention violation. `"warning"` is used only by the capability
 * cross-check (`unsatisfied_capability_requirement`, see this module's
 * docs), which flags something that is not necessarily wrong (a capability
 * requirement whose provider hasn't been written/loaded yet is "a ceiling,
 * not a guarantee" per `docs/plugin-conventions.md`) rather than a definite
 * defect in the plugin being linted.
 */
export type ConventionsLintIssueSeverity = "error" | "warning";

/** One violation found in a plugin directory. */
export interface ConventionsLintIssue {
  /** Machine-readable violation kind — stable, safe to branch/assert on. */
  readonly code: ConventionsLintIssueCode;
  /** Human-readable description, including enough context to fix it without re-reading this module. */
  readonly message: string;
  /** Path (relative to the plugin's own directory) of the file the issue was found in, when file-specific. */
  readonly file?: string;
  /** Defaults to `"error"` when omitted — see {@link ConventionsLintIssueSeverity}. */
  readonly severity?: ConventionsLintIssueSeverity;
}

/** The result of linting a single plugin directory. */
export interface ConventionsLintResult {
  /** The directory name under the plugins root — the plugin's expected id. */
  readonly pluginName: string;
  /** Absolute path to the plugin's directory. */
  readonly directoryPath: string;
  /** Every violation found. Empty means the plugin is fully convention-compliant. */
  readonly issues: readonly ConventionsLintIssue[];
}

/** `true` if a lint result found nothing to complain about. */
export function isClean(result: ConventionsLintResult): boolean {
  return result.issues.length === 0;
}

/**
 * Lint one plugin directory (`<pluginsRoot>/<pluginName>`) against all three
 * checks. `pluginsRoot` is expected to be a `.../src/plugins`-shaped
 * directory (real or a test fixture mirroring that shape) — the forbidden-
 * import check resolves relative imports against `path.dirname(pluginsRoot)`
 * as the plugin's "src root", exactly like the real
 * `src/plugins/<id>/**` / `src/server/**` layout this repo actually uses.
 */
export async function lintPlugin(
  pluginsRoot: string,
  pluginName: string,
): Promise<ConventionsLintResult> {
  const resolvedPluginsRoot = path.resolve(pluginsRoot);
  const srcRoot = path.dirname(resolvedPluginsRoot);
  const directoryPath = path.join(resolvedPluginsRoot, pluginName);

  const issues: ConventionsLintIssue[] = [];

  const manifest = await lintNaming(directoryPath, pluginName, issues);
  const files = await collectSourceFiles(directoryPath);

  await lintForbiddenImports(files, resolvedPluginsRoot, srcRoot, pluginName, issues);

  if (manifest) {
    await lintCapabilityCompleteness(files, directoryPath, manifest, issues);
  }

  return { pluginName, directoryPath, issues };
}

/**
 * Lint every immediate subdirectory of `pluginsRoot` (real plugins root, or
 * a fixture mirroring that shape). Directory names, not `scanPluginDirectories`'s
 * skip/entry split (`core/registry.ts`), drive discovery here: this linter
 * wants to report a missing manifest as its own {@link ConventionsLintIssue}
 * (`missing_manifest`), not silently omit that directory the way the
 * kernel's own boot-time scan does — the whole point of a "run against
 * every shipped plugin" CI check is that nothing shipped can quietly stop
 * being scanned.
 */
export async function lintAllPlugins(pluginsRoot: string): Promise<ConventionsLintResult[]> {
  const resolvedPluginsRoot = path.resolve(pluginsRoot);
  const dirents = await readdir(resolvedPluginsRoot, { withFileTypes: true });
  const pluginNames = dirents
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .sort((a, b) => a.localeCompare(b));

  const results: ConventionsLintResult[] = [];
  for (const pluginName of pluginNames) {
    results.push(await lintPlugin(resolvedPluginsRoot, pluginName));
  }
  return addCapabilityCrossCheckIssues(resolvedPluginsRoot, pluginNames, results);
}

// ---------------------------------------------------------------------------
// Check 4: capability cross-check (feature #81) — the one check that spans
// every plugin in the set, so it lives here (driven by lintAllPlugins)
// rather than inside lintPlugin/lintNaming above.
// ---------------------------------------------------------------------------

/**
 * Parse and validate `<directoryPath>/plugin.json`, returning `undefined` on
 * any failure (missing file, malformed JSON, schema-invalid) instead of
 * throwing or recording an issue. Deliberately silent: a plugin with a
 * broken manifest already gets `missing_manifest`/`malformed_manifest`/
 * `invalid_manifest` from {@link lintNaming}'s own pass over the same
 * directory — this helper exists purely so the capability cross-check can
 * *skip* such a plugin's `requires`/`provides` without double-reporting the
 * manifest problem itself.
 */
async function loadManifestQuietly(directoryPath: string): Promise<PluginManifest | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(directoryPath, MANIFEST_FILENAME), "utf-8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const validated = validateManifest(parsed);
  return isOk(validated) ? validated.value : undefined;
}

/**
 * Given every plugin just linted (`pluginNames`, under `pluginsRoot`), add
 * an `unsatisfied_capability_requirement` (severity `"warning"`) issue to
 * any plugin whose `capabilities.requires` names a capability id that no
 * plugin in this same set — including itself — declares under
 * `capabilities.provides`. See this module's docs ("Check 4") for why this
 * only runs here, across the whole set, rather than inside {@link lintPlugin}.
 *
 * `results` is not mutated — {@link ConventionsLintResult} and its `issues`
 * are both `readonly`, by design (every other check builds up `issues`
 * before a result is ever constructed); this returns a new array, replacing
 * only the entries that gain a cross-check issue.
 */
async function addCapabilityCrossCheckIssues(
  pluginsRoot: string,
  pluginNames: string[],
  results: readonly ConventionsLintResult[],
): Promise<ConventionsLintResult[]> {
  const manifestsByPluginName = new Map<string, PluginManifest>();
  for (const pluginName of pluginNames) {
    const manifest = await loadManifestQuietly(path.join(pluginsRoot, pluginName));
    if (manifest) {
      manifestsByPluginName.set(pluginName, manifest);
    }
  }

  const providedCapabilityIds = new Set<string>();
  for (const manifest of manifestsByPluginName.values()) {
    for (const capabilityId of manifest.capabilities.provides) {
      providedCapabilityIds.add(capabilityId);
    }
  }

  return results.map((result) => {
    const manifest = manifestsByPluginName.get(result.pluginName);
    if (!manifest) {
      // Manifest didn't parse/validate — lintNaming already reported why;
      // there is nothing meaningful to cross-check `requires` against.
      return result;
    }

    const crossCheckIssues: ConventionsLintIssue[] = [];
    for (const capabilityId of manifest.capabilities.requires) {
      if (!providedCapabilityIds.has(capabilityId)) {
        crossCheckIssues.push({
          code: "unsatisfied_capability_requirement",
          severity: "warning",
          message:
            `capability "${capabilityId}" is listed in this plugin's capabilities.requires, but no ` +
            `plugin loaded from "${pluginsRoot}" declares it in capabilities.provides — it cannot ` +
            `currently be obtained from the broker.`,
        });
      }
    }

    if (crossCheckIssues.length === 0) {
      return result;
    }
    return { ...result, issues: [...result.issues, ...crossCheckIssues] };
  });
}

// ---------------------------------------------------------------------------
// Check 1: naming
// ---------------------------------------------------------------------------

async function lintNaming(
  directoryPath: string,
  pluginName: string,
  issues: ConventionsLintIssue[],
): Promise<PluginManifest | undefined> {
  const manifestPath = path.join(directoryPath, MANIFEST_FILENAME);

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    issues.push({
      code: "missing_manifest",
      message: `No ${MANIFEST_FILENAME} found in plugin directory "${pluginName}".`,
    });
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    issues.push({
      code: "malformed_manifest",
      message:
        `"${pluginName}"'s ${MANIFEST_FILENAME} is not valid JSON: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    });
    return undefined;
  }

  const validated = validateManifest(parsed);
  if (!isOk(validated)) {
    issues.push({ code: "invalid_manifest", message: validated.error.message });
    return undefined;
  }

  const manifest = validated.value;
  if (manifest.id !== pluginName) {
    issues.push({
      code: "id_directory_mismatch",
      message:
        `plugin.json "id" ("${manifest.id}") must match its directory name ` +
        `("${pluginName}") — see docs/plugin-conventions.md section 2.1.`,
    });
  }

  return manifest;
}

// ---------------------------------------------------------------------------
// Source file collection, shared by checks 2 and 3
// ---------------------------------------------------------------------------

async function collectSourceFiles(directoryPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directoryPath, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      continue;
    }
    files.push(path.join(entry.parentPath, entry.name));
  }
  return files.sort();
}

/**
 * Strip `//` and `/* *\/` comments from `source`, while leaving string/
 * template literals untouched — see this module's docs for *why* (avoiding
 * false positives from doc comments that mention capability ids or
 * relative paths in prose). Not a full lexer: a regex literal containing a
 * `/` (e.g. `/\/\//`) could in principle confuse this, but no plugin source
 * in this codebase currently contains one; this is the same documented,
 * deliberately-heuristic tradeoff this module's docs describe for
 * capability-identifier resolution.
 */
function stripComments(source: string): string {
  return source.replace(
    /"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (match) => (match.startsWith("/") ? "" : match),
  );
}

// ---------------------------------------------------------------------------
// Check 3: forbidden cross-plugin imports
// ---------------------------------------------------------------------------

const IMPORT_SPECIFIER_PATTERNS = [
  // import("...") / import ("...") — dynamic import
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  // require("...")
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  // import ... from "..."; export ... from "...";
  /\bfrom\s+["']([^"']+)["']/g,
  // bare side-effect import "...";
  /^\s*import\s+["']([^"']+)["']/gm,
];

/**
 * `import type { ... } from "spec"` / `export type { ... } from "spec"` —
 * fully erased at compile time, so exempt from the forbidden-import check
 * (see this module's docs for why). Deliberately narrow: only the explicit
 * `type` keyword right after `import`/`export` counts, not an inference
 * about what a given import "really" contains.
 */
const TYPE_ONLY_IMPORT_PATTERN =
  /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g;

function extractImportSpecifiers(cleanedSource: string): string[] {
  const typeOnlySpecifiers = new Set<string>();
  for (const match of cleanedSource.matchAll(TYPE_ONLY_IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier) {
      typeOnlySpecifiers.add(specifier);
    }
  }

  const specifiers: string[] = [];
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    for (const match of cleanedSource.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier && !typeOnlySpecifiers.has(specifier)) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

/**
 * Classify a resolved (relative-import-target) absolute path as a forbidden
 * cross-plugin/bootstrap reach, or `undefined` if it's fine. `pluginsRoot`
 * and `srcRoot` are both already-resolved absolute paths.
 */
function classifyImportViolation(
  resolvedTarget: string,
  pluginsRoot: string,
  srcRoot: string,
  pluginName: string,
): string | undefined {
  const relativeToPlugins = path.relative(pluginsRoot, resolvedTarget);
  const reachesIntoAnotherPluginsDir =
    relativeToPlugins !== "" &&
    !relativeToPlugins.startsWith(`..${path.sep}`) &&
    relativeToPlugins !== "..";

  if (reachesIntoAnotherPluginsDir) {
    const otherPluginId = relativeToPlugins.split(path.sep)[0];
    if (otherPluginId && otherPluginId !== pluginName) {
      return (
        `imports from another plugin's internals ("${otherPluginId}") — only ` +
        `kernel-brokered capabilities may cross a plugin boundary ` +
        `(see docs/plugin-conventions.md section 5).`
      );
    }
    return undefined;
  }

  const serverRoot = path.join(srcRoot, "server");
  const relativeToServer = path.relative(serverRoot, resolvedTarget);
  const reachesIntoServer =
    relativeToServer === "" ||
    (!relativeToServer.startsWith(`..${path.sep}`) && relativeToServer !== "..");

  if (reachesIntoServer) {
    return (
      `imports from src/server (the bootstrap) — a plugin must not reach into ` +
      `the bootstrap; the bootstrap composes plugins, not the other way around ` +
      `(see docs/plugin-conventions.md section 5).`
    );
  }

  return undefined;
}

async function lintForbiddenImports(
  files: string[],
  pluginsRoot: string,
  srcRoot: string,
  pluginName: string,
  issues: ConventionsLintIssue[],
): Promise<void> {
  for (const file of files) {
    const raw = await readFile(file, "utf-8");
    const cleaned = stripComments(raw);

    for (const specifier of extractImportSpecifiers(cleaned)) {
      if (!specifier.startsWith(".")) {
        // Not a relative import: an npm package, a "node:" builtin, or (this
        // repo has no path aliases configured — see tsconfig.json) some
        // other non-relative specifier. None of those can resolve into
        // another plugin's directory by accident.
        continue;
      }

      const resolvedTarget = path.resolve(path.dirname(file), specifier);
      const violation = classifyImportViolation(resolvedTarget, pluginsRoot, srcRoot, pluginName);
      if (violation) {
        issues.push({
          code: "forbidden_import",
          message: `"${specifier}" ${violation}`,
          file: path.relative(path.join(pluginsRoot, pluginName), file),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Check 2: capability declaration completeness
// ---------------------------------------------------------------------------

/** `NAME = "namespace:action"` local const bindings, keyed by identifier name. */
const CONST_STRING_BINDING_PATTERN =
  /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=]+)?=\s*["']([^"']+)["']/g;

function extractLocalStringConstants(cleanedSource: string): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const match of cleanedSource.matchAll(CONST_STRING_BINDING_PATTERN)) {
    const [, name, value] = match;
    if (name && value !== undefined) {
      bindings.set(name, value);
    }
  }
  return bindings;
}

/** Matches `.obtain(...)` / `.obtain<Type>(...)` calls, capturing the raw (unparsed) argument text. */
const OBTAIN_CALL_PATTERN = /\.obtain\s*(?:<[^>]*>)?\s*\(\s*([^)]*?)\s*\)/g;

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function extractObtainedCapabilityIds(
  cleanedSource: string,
  localConstants: Map<string, string>,
): string[] {
  const capabilityIds: string[] = [];

  for (const match of cleanedSource.matchAll(OBTAIN_CALL_PATTERN)) {
    const argument = (match[1] ?? "").trim();

    const stringLiteralMatch = /^["']([^"']+)["']$/.exec(argument);
    if (stringLiteralMatch?.[1] !== undefined) {
      capabilityIds.push(stringLiteralMatch[1]);
      continue;
    }

    if (IDENTIFIER_PATTERN.test(argument)) {
      const resolved = localConstants.get(argument);
      if (resolved !== undefined) {
        capabilityIds.push(resolved);
      }
      // An identifier this file doesn't bind to a string literal itself
      // (imported from elsewhere, a function parameter, computed at
      // runtime, ...) cannot be statically resolved — see this module's
      // docs on why that is skipped rather than guessed at.
    }
  }

  return capabilityIds;
}

/**
 * Find the balanced `{ ... }` object literal `export const provides = { ... }`
 * (optionally type-annotated, e.g. `: Readonly<Record<string, unknown>>`)
 * assigns to, or `undefined` if this file has no such export.
 */
function extractProvidesObjectBody(cleanedSource: string): string | undefined {
  const declarationMatch = /\bexport\s+const\s+provides\b[^=]*=\s*/.exec(cleanedSource);
  if (!declarationMatch) {
    return undefined;
  }

  const searchFrom = declarationMatch.index + declarationMatch[0].length;
  const openBraceIndex = cleanedSource.indexOf("{", searchFrom);
  if (openBraceIndex === -1) {
    return undefined;
  }

  let depth = 0;
  for (let i = openBraceIndex; i < cleanedSource.length; i++) {
    if (cleanedSource[i] === "{") {
      depth++;
    } else if (cleanedSource[i] === "}") {
      depth--;
      if (depth === 0) {
        return cleanedSource.slice(openBraceIndex, i + 1);
      }
    }
  }
  return undefined;
}

/** Top-level `"namespace:action": ...` string-literal keys of a `provides` object body. */
const PROVIDES_KEY_PATTERN = /["'`]([A-Za-z][A-Za-z0-9-]*:[A-Za-z][A-Za-z0-9-]*)["'`]\s*:/g;

function extractProvidedCapabilityIds(cleanedSource: string): string[] {
  const body = extractProvidesObjectBody(cleanedSource);
  if (!body) {
    return [];
  }

  const capabilityIds: string[] = [];
  for (const match of body.matchAll(PROVIDES_KEY_PATTERN)) {
    const capabilityId = match[1];
    if (capabilityId) {
      capabilityIds.push(capabilityId);
    }
  }
  return capabilityIds;
}

async function lintCapabilityCompleteness(
  files: string[],
  directoryPath: string,
  manifest: PluginManifest,
  issues: ConventionsLintIssue[],
): Promise<void> {
  const declaredRequires = new Set(manifest.capabilities.requires);
  const declaredProvides = new Set(manifest.capabilities.provides);

  for (const file of files) {
    const raw = await readFile(file, "utf-8");
    const cleaned = stripComments(raw);
    const relativeFile = path.relative(directoryPath, file);
    const localConstants = extractLocalStringConstants(cleaned);

    const seenUndeclaredUse = new Set<string>();
    for (const capabilityId of extractObtainedCapabilityIds(cleaned, localConstants)) {
      if (!declaredRequires.has(capabilityId) && !seenUndeclaredUse.has(capabilityId)) {
        seenUndeclaredUse.add(capabilityId);
        issues.push({
          code: "undeclared_capability_use",
          message:
            `capability "${capabilityId}" is obtained from the broker but is not listed in ` +
            `this plugin's capabilities.requires.`,
          file: relativeFile,
        });
      }
    }

    const seenUndeclaredProvide = new Set<string>();
    for (const capabilityId of extractProvidedCapabilityIds(cleaned)) {
      if (!declaredProvides.has(capabilityId) && !seenUndeclaredProvide.has(capabilityId)) {
        seenUndeclaredProvide.add(capabilityId);
        issues.push({
          code: "undeclared_capability_provide",
          message:
            `capability "${capabilityId}" is exported from this plugin's \`provides\` object but ` +
            `is not listed in this plugin's capabilities.provides.`,
          file: relativeFile,
        });
      }
    }
  }
}

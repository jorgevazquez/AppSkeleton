/**
 * Dependency graph resolution for the plugin kernel.
 *
 * Builds a dependency graph from a set of already-*validated*
 * {@link PluginManifest} values (see manifest.ts's `validateManifest()` —
 * this module never sees raw/unknown manifest data, that's the registry's
 * and manifest validator's job), resolves each `depends_on` semver *range*
 * against the discovered dependency's actual version, detects circular
 * dependencies, and produces a deterministic topological load order.
 *
 * This module does NOT scan the filesystem (registry.ts) and does NOT
 * instantiate plugins or run lifecycle hooks (loader.ts, feature #8) — it
 * is a pure, synchronous function of the manifest set. `resolveLoadOrder()`
 * is the single entry point the loader calls to get the order in which to
 * instantiate plugins.
 */
import semver from "semver";
import { PluginLoadError } from "./errors.js";
import type { PluginManifest } from "./manifest.js";
import { err, ok, type Result } from "./types.js";

/** One node in the dependency graph: a plugin's id, version, and declared dependency ranges. */
export interface DependencyGraphNode {
  readonly id: string;
  readonly version: string;
  /** Map of depended-upon plugin id -> the semver range required of it. */
  readonly dependsOn: Readonly<Record<string, string>>;
}

/** The dependency graph built from a set of discovered manifests, keyed by plugin id. */
export interface DependencyGraph {
  readonly nodes: ReadonlyMap<string, DependencyGraphNode>;
}

/** Why an edge (or the graph as a whole) could not be resolved into a valid load order. */
export type DependencyIssueReason =
  "duplicate_plugin_id" | "missing_dependency" | "version_range_mismatch";

/** A single structural problem found while resolving the dependency graph. */
export interface DependencyIssue {
  reason: DependencyIssueReason;
  /** The plugin whose manifest declared the problematic dependency (or duplicate id). */
  pluginId: string;
  /** The depended-upon plugin id — present for missing_dependency / version_range_mismatch. */
  dependencyId?: string;
  /** The declared semver range — present for missing_dependency / version_range_mismatch. */
  range?: string;
  /** The dependency's actual discovered version — present for version_range_mismatch only. */
  installedVersion?: string;
  message: string;
}

/**
 * Index a set of validated manifests into a {@link DependencyGraph} keyed by
 * plugin id. Pure data transformation: does not validate edges (missing
 * dependencies, unsatisfied ranges) or detect cycles — see
 * {@link resolveLoadOrder} for that. If more than one manifest declares the
 * same `id`, the first one (in input order) wins the graph slot; the
 * duplicate is surfaced as a `duplicate_plugin_id` issue by
 * {@link resolveLoadOrder}, not by this function.
 */
export function buildDependencyGraph(manifests: readonly PluginManifest[]): DependencyGraph {
  const nodes = new Map<string, DependencyGraphNode>();
  for (const manifest of manifests) {
    if (!nodes.has(manifest.id)) {
      nodes.set(manifest.id, {
        id: manifest.id,
        version: manifest.version,
        dependsOn: manifest.depends_on,
      });
    }
  }
  return { nodes };
}

/** Find duplicate ids and edges that don't resolve: missing dependency or an unsatisfied range. */
function findEdgeIssues(
  manifests: readonly PluginManifest[],
  graph: DependencyGraph,
): DependencyIssue[] {
  const issues: DependencyIssue[] = [];
  const seenIds = new Set<string>();

  for (const manifest of manifests) {
    if (seenIds.has(manifest.id)) {
      issues.push({
        reason: "duplicate_plugin_id",
        pluginId: manifest.id,
        message: `Duplicate plugin id "${manifest.id}": more than one discovered manifest declares this id.`,
      });
      continue;
    }
    seenIds.add(manifest.id);

    for (const [dependencyId, range] of Object.entries(manifest.depends_on)) {
      const dependency = graph.nodes.get(dependencyId);
      if (!dependency) {
        issues.push({
          reason: "missing_dependency",
          pluginId: manifest.id,
          dependencyId,
          range,
          message: `Plugin "${manifest.id}" depends on "${dependencyId}@${range}", but no plugin with id "${dependencyId}" was discovered.`,
        });
        continue;
      }

      if (!semver.satisfies(dependency.version, range)) {
        issues.push({
          reason: "version_range_mismatch",
          pluginId: manifest.id,
          dependencyId,
          range,
          installedVersion: dependency.version,
          message: `Plugin "${manifest.id}" requires "${dependencyId}@${range}", but the discovered "${dependencyId}" is version ${dependency.version}, which does not satisfy that range.`,
        });
      }
    }
  }

  return issues;
}

/**
 * Depth-first cycle detection. Returns the cycle as an ordered list of
 * plugin ids (first id repeated at the end, e.g. `["a", "b", "c", "a"]`)
 * naming exactly the loop found, or `null` if the graph is acyclic.
 * Traversal order is deterministic (ids visited in lexicographic order) so
 * the reported cycle is stable across runs regardless of input order.
 */
function findCycle(graph: DependencyGraph): string[] | null {
  const UNVISITED = 0;
  const IN_PROGRESS = 1;
  const DONE = 2;
  const state = new Map<string, 0 | 1 | 2>();
  const sortedIds = [...graph.nodes.keys()].sort((a, b) => a.localeCompare(b));
  for (const id of sortedIds) {
    state.set(id, UNVISITED);
  }

  function visit(id: string, stack: string[]): string[] | null {
    state.set(id, IN_PROGRESS);
    stack.push(id);

    const node = graph.nodes.get(id);
    const dependencyIds = node
      ? Object.keys(node.dependsOn).sort((a, b) => a.localeCompare(b))
      : [];

    for (const dependencyId of dependencyIds) {
      if (!graph.nodes.has(dependencyId)) {
        // Unresolvable edges are reported separately (missing_dependency) and
        // never form part of a cycle.
        continue;
      }
      const dependencyState = state.get(dependencyId);
      if (dependencyState === IN_PROGRESS) {
        const cycleStart = stack.indexOf(dependencyId);
        return [...stack.slice(cycleStart), dependencyId];
      }
      if (dependencyState === UNVISITED) {
        const found = visit(dependencyId, stack);
        if (found) {
          return found;
        }
      }
    }

    stack.pop();
    state.set(id, DONE);
    return null;
  }

  for (const id of sortedIds) {
    if (state.get(id) === UNVISITED) {
      const cycle = visit(id, []);
      if (cycle) {
        return cycle;
      }
    }
  }

  return null;
}

/**
 * Kahn's algorithm, with candidates broken lexicographically by id so the
 * result is deterministic even when the graph admits multiple valid
 * topological orders (e.g. a diamond, or independent plugins with no
 * relationship to each other). Assumes the graph is already known to be
 * acyclic and every edge already resolved — call after
 * {@link findEdgeIssues} and {@link findCycle} both report no problems.
 */
function topologicalSort(graph: DependencyGraph): string[] {
  const ids = [...graph.nodes.keys()].sort((a, b) => a.localeCompare(b));

  // inDegree[id] = number of not-yet-loaded dependencies id still has.
  const inDegree = new Map<string, number>();
  // dependents[id] = the ids that declare id as a dependency (edge id -> dependent).
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    inDegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const id of ids) {
    const node = graph.nodes.get(id);
    const dependencyIds = node ? Object.keys(node.dependsOn) : [];
    for (const dependencyId of dependencyIds) {
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      dependents.get(dependencyId)?.push(id);
    }
  }
  for (const list of dependents.values()) {
    list.sort((a, b) => a.localeCompare(b));
  }

  const ready = ids.filter((id) => inDegree.get(id) === 0);
  ready.sort((a, b) => a.localeCompare(b));

  const order: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) {
      break;
    }
    order.push(next);

    for (const dependent of dependents.get(next) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) {
        // Insert keeping `ready` sorted, so the next shift() stays deterministic.
        const insertAt = ready.findIndex((id) => id.localeCompare(dependent) > 0);
        if (insertAt === -1) {
          ready.push(dependent);
        } else {
          ready.splice(insertAt, 0, dependent);
        }
      }
    }
  }

  return order;
}

/**
 * Resolve a set of validated manifests into a deterministic plugin load
 * order: dependencies always appear before the plugins that depend on them.
 *
 * Never throws — returns `Err(PluginLoadError)` for any of:
 *   - a duplicate plugin id across the discovered manifests,
 *   - a `depends_on` entry naming a plugin id that was not discovered,
 *   - a `depends_on` range the discovered dependency's version does not
 *     satisfy,
 *   - a circular dependency anywhere in the graph — the error names the
 *     exact cycle (e.g. `"a -> b -> c -> a"`).
 *
 * Edge issues (missing dependency / version mismatch / duplicate id) are
 * checked first and *all* of them are collected into one error (mirroring
 * `validateManifest()`'s "collect every violation" behavior), since a graph
 * with unresolvable edges can't meaningfully be checked for cycles. Only
 * once every edge resolves is the graph checked for cycles, and only once
 * it's confirmed acyclic is the topological order computed.
 */
export function resolveLoadOrder(
  manifests: readonly PluginManifest[],
): Result<string[], PluginLoadError> {
  const graph = buildDependencyGraph(manifests);

  const edgeIssues = findEdgeIssues(manifests, graph);
  if (edgeIssues.length > 0) {
    const summary = edgeIssues.map((issue) => issue.message).join("; ");
    return err(
      new PluginLoadError(`Cannot resolve plugin dependency graph: ${summary}`, {
        details: { issues: edgeIssues },
      }),
    );
  }

  const cycle = findCycle(graph);
  if (cycle) {
    const cycleDescription = cycle.join(" -> ");
    return err(
      new PluginLoadError(`Circular dependency detected among plugins: ${cycleDescription}`, {
        details: { cycle },
      }),
    );
  }

  return ok(topologicalSort(graph));
}

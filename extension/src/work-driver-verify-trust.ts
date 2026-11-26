/**
 * #1647 / #2649 — why a walk over the import graph cannot be trusted.
 *
 * The selector's soundness rests on the graph having seen every edge that could
 * reach a test. Two shapes break that: a module whose `import()` takes a computed
 * name may load anything, and a module whose relative specifier resolves to no node
 * may reach one the walk never built. Both are reasons to run the full suite rather
 * than trust a subset — and both have exemptions, because the doubt is only real
 * where something else in the graph depends on the doubtful node.
 *
 * Split out of `work-driver-verify-select.ts`, which owns the walk and the fallback
 * vocabulary; this is the whole of that module's trust judgement over a built graph.
 */

/** The walk's edges, as `buildGraph` computed them. */
export interface Graph {
  nodes: Set<string>;
  /** target → the files that reference it. */
  importers: Map<string, Set<string>>;
  /** Nodes with a non-literal dynamic import or require. */
  dynamic: Set<string>;
  /** Nodes with a relative specifier that names no graph node. */
  unresolved: Set<string>;
  /** Nodes that sit under `smoke-tests/lib/` — the helper half of the walk. */
  lib: Set<string>;
}

/** A test at the top of `smoke-tests/` — the shape a selection is allowed to name. */
export const TEST_NODE_RE = /^smoke-tests\/test-[^/]+\.ts$/;

/** A module beside the tests that exists to serve them (`verify-loop-lib.ts` etc). */
export const TEST_SUPPORT_RE = /^smoke-tests\/[^/]+\.ts$/;

/**
 * The reason a walk over `reached` cannot be trusted, or undefined. A
 * non-literal dynamic import or an unresolved relative specifier on the walk
 * path may import something the graph cannot see. A test is exempt: nothing
 * imports it, so its own unseen edges cannot hide another test's dependency. A
 * test-support module is exempt from the UNRESOLVED half for the same reason, and
 * only that half — a non-literal dynamic import in one of them really can load a
 * test the graph never saw, so it still falls back. A `smoke-tests/lib/` helper is
 * exempt from BOTH halves for the same reason a test is: nothing in the graph
 * reaches a helper except the tests that name it, so a helper's own dead specifier
 * or variable `import()` cannot hide another test's dependency — the tests that
 * import this helper are exactly the ones the walk already found.
 */
export function untrustedNode(
  graph: Graph,
  reached: ReadonlySet<string>,
  start: string,
): string | undefined {
  const helperStart = graph.lib.has(start);
  for (const node of reached) {
    if (TEST_NODE_RE.test(node)) continue;
    if (helperStart && graph.lib.has(node)) continue;
    if (graph.dynamic.has(node)) return `non-literal-specifier:${node}`;
    if (graph.unresolved.has(node) && !TEST_SUPPORT_RE.test(node) && !graph.lib.has(node)) {
      return `unresolved-specifier:${node}`;
    }
  }
  return undefined;
}

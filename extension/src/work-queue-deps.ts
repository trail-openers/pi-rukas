/**
 * work-queue-deps — #1101: cross-group ordering edges for the `/work` queue.
 *
 * `groupIssues()` R1 unions issues that *declare* a dependency into ONE group
 * (`Depends-on: #N`, closing keywords, …). That is right for issues that ship
 * together and wrong for issues that ship in sequence: the merge makes the
 * dependency invisible to the queue, which then dispatches the dependent
 * group while its dependency is still unstarted. And when the declared
 * dependency lands in a *different* group, nothing at all enforces the order —
 * the queue's only pre-dispatch gate is the #676 path-overlap check, which
 * keys on extracted paths, not on intent.
 *
 * This module is the pure discovery half; `work-queue.ts` is the executor.
 * Three rules, all at queue level, none of them touching R1's union
 * semantics:
 *
 *  - **Edges come from the declared statements, not from R1.** R1's
 *    `linkRe` also matches `fixes #N` / `related to #N`, which are not
 *    ordering at all — treating them as ordering would serialise every pair
 *    that happens to cite each other. So a narrow statement regex runs
 *    beside it. It deliberately overlaps R1's vocabulary (an R1-eligible
 *    statement is recorded as an edge too, so R1's own union decisions
 *    cannot silently disable ordering), and it deliberately does NOT read
 *    the prose form `this depends on the API` — an unnumbered reference
 *    names no group, and guessing one is how a queue invents edges.
 *  - **Out-of-invocation dependencies are advisory.** `/work 12 13` where 13
 *    says `Depends-on: #7` (an issue in a different invocation, a PR
 *    already merged, anything outside the group set) must not block: the
 *    queue cannot dispatch what it was not given. The edge is dropped and
 *    noted once per issue so the operator sees that the queue saw it.
 *  - **A cycle parks before it dispatches.** An A→B→A loop has no valid
 *    order, so no group in it runs and every one of them parks with
 *    `dependency-cycle`. Waiting for a dependency that will never merge is
 *    the same dead end reached more slowly.
 *
 * Edges collapse across groups: `A → B` means "every group holding a
 * dependency of `A`'s issues must reach merged before `A`'s group is
 * dispatched". Both endpoints are group ids, so a same-group edge is a
 * self-edge and disappears — R1 merged those issues deliberately, and the
 * queue is not the layer that re-litigates a merge.
 */

/** Where an ordering statement came from. Only `body` today; the kind keeps
 * the trace able to answer "why is this group waiting" without a re-read. */
export type OrderingSource = "body";

/** The statements that mean "do not build this before that one". */
const ORDERING_RE =
  /\b(?:depends?[-\s]?on|blocked?[-\s]?by|blocked?[-\s]?on|predecessor(?:s)?(?:\s+are)?|requires?)\s*:?\s*#(\d+)/gi;

export interface OrderingEdge {
  /** The issue carrying the statement — the dependent. */
  issue: number;
  /** The issue it must not precede — the dependency. */
  dependsOn: number;
  /** Where the statement was found. */
  source: OrderingSource;
}

/**
 * The statements an issue body declares that make it a FOLLOWER of another
 * issue — issue numbers only.
 *
 * Returns `number[]` rather than edge records because the caller already knows
 * who the dependent is (`groupIssues()` is iterating the issues when it calls
 * this), and an edge object whose `issue` field the caller must overwrite is a
 * field that lies until someone remembers to fill it in.
 */
export function orderingDependencies(body: string | undefined): number[] {
  return findOrderingStatements(body).map((e) => e.dependsOn);
}

/**
 * The ordering statements an issue body declares.
 *
 * Pure text scan, no dispatch, no fs. Callers decide what an edge *means*
 * (see `planOrderingEdges` for the group-level collapse). The `issue` field is
 * left 0 — the scan has no view of which issue the body belongs to; the caller
 * that does (see `orderingDependencies`) fills it in.
 */
export function findOrderingStatements(body: string | undefined): OrderingEdge[] {
  if (!body) return [];
  const found: OrderingEdge[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  ORDERING_RE.lastIndex = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration idiom
  while ((m = ORDERING_RE.exec(body))) {
    const dep = Number.parseInt(m[1] ?? "", 10);
    if (!Number.isFinite(dep)) continue;
    const key = `${m.index}:${dep}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ issue: 0, dependsOn: dep, source: "body" });
  }
  ORDERING_RE.lastIndex = 0;
  return found;
}

/** The queue-level view of one group's unmet dependencies. */
export interface GroupDependency {
  /** Group ids that must reach `merged` before this group dispatches. */
  blockingGroupIds: string[];
  /** Issues whose declared dependency is not part of this invocation. */
  ignored: number[];
  /** Issues whose declared dependency is this group's own issue set (R1 merged them). */
  sameGroup: number[];
}

export interface OrderingPlan {
  /** group id → the groups that must merge first, plus the diagnostics. */
  byGroup: Record<string, GroupDependency>;
  /** Group ids that sit inside a dependency cycle. Deterministically ordered. */
  cyclic: string[];
  /** `group-a → group-b (via #101 → #100)` notes for the grouping report. */
  notes: string[];
}

/**
 * Collapse per-issue ordering statements into cross-group edges.
 *
 * `depsByIssue` maps an issue to the issue numbers it declared. Anything
 * outside `groups` is an ignored edge, not a blocker; anything inside the
 * same group is a same-group edge, not a blocker either. What is left is a
 * real ordering obligation between two groups of this invocation.
 */
export function planOrderingEdges(
  groups: Array<{ id: string; issues: number[] }>,
  depsByIssue: Record<number, number[]>,
): OrderingPlan {
  const byGroup: Record<string, GroupDependency> = {};
  for (const g of groups) byGroup[g.id] = { blockingGroupIds: [], ignored: [], sameGroup: [] };
  const ownerId = new Map<number, string>();
  for (const g of groups) for (const n of g.issues) ownerId.set(n, g.id);

  const notes: string[] = [];
  const edges = new Set<string>(); // `${from}>${to}` group edges, deduped
  const ignoredOnce = new Set<number>();

  for (const [issueStr, deps] of Object.entries(depsByIssue)) {
    const issue = Number.parseInt(issueStr, 10);
    if (!Number.isFinite(issue)) continue;
    const owner = ownerId.get(issue);
    if (!owner) continue; // not an issue of this invocation
    for (const dep of deps) {
      if (dep === issue) {
        if (!ignoredOnce.has(issue)) {
          ignoredOnce.add(issue);
          notes.push(`ordering ignored: #${issue} declares a dependency on itself`);
        }
        continue;
      }
      const target = ownerId.get(dep);
      if (!target) {
        if (!ignoredOnce.has(issue)) {
          ignoredOnce.add(issue);
          notes.push(`ordering ignored: #${issue} depends on #${dep}, not in this invocation`);
        }
        continue;
      }
      if (target === owner) {
        if (!byGroup[owner]?.sameGroup.includes(issue)) byGroup[owner]?.sameGroup.push(issue);
        continue;
      }
      const key = `${owner}>${target}`;
      if (edges.has(key)) continue;
      edges.add(key);
      if (byGroup[owner] && !byGroup[owner].blockingGroupIds.includes(target)) {
        byGroup[owner].blockingGroupIds.push(target);
      }
      notes.push(`ordering edge: ${owner} waits for ${target} (via #${issue} → #${dep})`);
    }
  }
  for (const g of groups) {
    const entry = byGroup[g.id];
    if (entry) {
      entry.blockingGroupIds.sort();
      entry.ignored = [...ignoredOnce].filter((n) => ownerId.get(n) === g.id).sort((a, b) => a - b);
      entry.sameGroup.sort((a, b) => a - b);
    }
  }
  return {
    byGroup,
    cyclic: findCyclicGroups(
      groups.map((g) => g.id),
      byGroup,
    ),
    notes,
  };
}

/**
 * Every group id that participates in a dependency cycle (Kahn's algorithm).
 *
 * A group whose in-degree never reaches zero is either in a cycle or
 * downstream of one. Both have to park: a group whose dependency is
 * unreachable in the graph has no dispatch order either, and letting it run
 * would build a dependent before the thing it depends on.
 */
export function findCyclicGroups(
  ids: string[],
  byGroup: Record<string, GroupDependency>,
): string[] {
  const known = new Set(ids);
  const inDegree = new Map<string, number>();
  const out = new Map<string, string[]>();
  // A group that waits on itself has no valid dispatch order either — it can
  // only ever be released by itself. It is filtered out of the degree
  // calculation below (a self-edge would leave in-degree at 1 with nothing to
  // decrement it), so it is named here rather than being silently acyclic.
  // `planOrderingEdges` collapses same-group edges and never produces one,
  // but `findCyclicGroups` is exported and takes a hand-built graph, and a
  // self-loop reaching the queue must park rather than hang on itself.
  const selfEdges = new Set<string>();
  for (const id of ids) {
    if ((byGroup[id]?.blockingGroupIds ?? []).includes(id)) selfEdges.add(id);
  }
  for (const id of ids) {
    inDegree.set(id, 0);
    out.set(id, []);
  }
  for (const id of ids) {
    const deps = (byGroup[id]?.blockingGroupIds ?? []).filter((d) => known.has(d) && d !== id);
    inDegree.set(id, deps.length);
    for (const d of deps) out.get(d)?.push(id);
  }
  const queue = ids.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const settled = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || settled.has(id)) continue;
    settled.add(id);
    for (const dependent of out.get(id) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }
  return ids.filter((id) => !settled.has(id) || selfEdges.has(id));
}

/**
 * The cycle's edges, in `A → B` form — what the operator has to reorder.
 *
 * "There is a cycle" names the symptom; "A waits for B and B waits for A"
 * names the edit. Restricted to groups that are themselves cyclic, so the
 * list is the loop, not everything adjacent to it.
 */
export function cycleEdgeLabels(
  cyclic: string[],
  byGroup: Record<string, GroupDependency>,
): string[] {
  const inCycle = new Set(cyclic);
  const labels: string[] = [];
  for (const id of cyclic) {
    for (const dep of byGroup[id]?.blockingGroupIds ?? []) {
      if (inCycle.has(dep)) labels.push(`${id} → ${dep}`);
    }
  }
  return labels;
}

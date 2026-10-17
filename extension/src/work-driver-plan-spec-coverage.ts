/**
 * work-driver-plan-spec-coverage — the plan-to-spec gate (#819).
 *
 * The gap this closes: nothing between the plan step and `develop` asked
 * whether the declared workstreams were ABOUT the issue. `planQualityReason`
 * checks shape only (under-decomposed / empty-paths / overlapping-paths /
 * test-subject-split / invalid-dependency / circular-dependency /
 * interdependent-no-integration-test / invalid-path); none of the eight
 * compares a workstream's declared paths to the spec's deliverables. The
 * first check that could notice was the converge gate — after the whole
 * develop and adversarial spend, and only if consolidated verify passed
 * first.
 *
 * The incident this is built on (#818, 2026-09-22): a correct one-workstream
 * plan was rejected as `under-decomposed`, the corrective reply came back with
 * THREE concatenated `## Workstreams` blocks — the first a fabricated
 * supply-chain decomposition matching no deliverable, no issue, and no
 * coherent view of the base commit — and the parser took the first. Four
 * developers then built a 2,239-line `package-lock.json`, a new
 * `install-preflight.sh` and a no-op docs rewrite for 45 minutes.
 *
 * Two halves, both deterministic and dispatch-free:
 *
 * 1. `findUncoveredDeliverables` — the coverage predicate, an adjacent pure
 *    function to `planQualityReason` (which is deliberately left alone: this
 *    gate needs the spec, which `planQualityReason` does not take, and the
 *    existing reasons keep their exact precedence). Coverage semantics are
 *    the converge gate's, copied rather than paraphrased: a deliverable is
 *    COVERED when EVERY one of its normalised paths is contained in the
 *    union of all workstream paths — exact match, or containment either way
 *    with a `/` boundary (`extension/src` covers
 *    `extension/src/work-driver-integrate.ts`). Pathless deliverables are
 *    excluded entirely (a prose deliverable or a #792 no-diff deliverable
 *    cannot be judged by path presence — `classifyDeliverables` calls them
 *    `unmeasurable` and `no-diff` for the same reason), so a spec whose
 *    deliverables all lack paths is not checkable and is not rejected.
 *
 * 2. `countWorkstreamBlocks` + the ambiguous-reply branch of
 *    `planSpecMismatchReason` — a reply carrying more than one `##
 *    Workstreams` heading is REJECTED. Last-wins was considered and refused:
 *    the #818 reply's three blocks were emitted in no semantic order, so the
 *    "last" block is as likely to be fabricated as the first, and either
 *    pick is a guess the driver cannot defend. Silence is not permission
 *    (#378) and neither is a coin flip.
 *
 * `normaliseDeclaredPath` runs on BOTH sides. Declared paths are prose from
 * a planner, not `git` output — `"src/a.ts (new)"`, `` "`src/a.ts`" ``,
 * `"extension/smoke-tests/"` are all real shapes seen in state files, and
 * comparing un-normalised strings on one side reintroduces false mismatches
 * (the #875 lesson).
 */

import { normaliseDeclaredPath } from "./work-driver-verify.ts";

/** The deliverable shape the gate reads (structural subset of SpecDeliverable). */
export interface SpecCoverageDeliverable {
  id: string;
  paths: string[];
  /** #792 — plan-time no-diff marker; only honoured together with evidence. */
  noDiff?: boolean;
  /** #792 — the evidence string that makes the no-diff marker honoured. */
  noDiffEvidence?: string;
}

/** The workstream shape the gate reads (structural subset of Workstream). */
export interface SpecCoverageWorkstream {
  paths: string[];
}

/** The spec shape the gate reads. */
export interface SpecCoverageSpec {
  deliverables: SpecCoverageDeliverable[];
}

/** One deliverable the plan covers none of. */
export interface UncoveredDeliverable {
  id: string;
  /** The deliverable's normalised declared paths (what the plan should cover). */
  paths: string[];
}

/** Normalise a declared-path list: dedupe, drop blanks. */
function normalisedPaths(paths: string[] | undefined): string[] {
  return [...new Set((paths ?? []).map(normaliseDeclaredPath).filter((p) => p.length > 0))];
}

/**
 * Does the workstream path union contain `p`?
 *
 * Exact match, or containment either way with a separator — the same rule
 * `findPathCollisions` and `classifyDeliverables` use. Containment goes BOTH
 * ways deliberately: the converge gate only needs "a diff file sits under the
 * declared directory", but at plan time a workstream may legitimately declare
 * the FILE (`extension/src/foo.ts`) while the deliverable declares the
 * DIRECTORY it lives in (`extension/src`), which is the same ownership claim
 * seen from the other side. The separator is what keeps `src/foo` from
 * "covering" `src/foobar`.
 */
function coveredBy(path: string, workstreamPaths: string[]): boolean {
  return workstreamPaths.some(
    (wp) => wp === path || path.startsWith(`${wp}/`) || wp.startsWith(`${path}/`),
  );
}

/**
 * A deliverable participates in the comparison only when it carries concrete
 * paths to point at. Empty paths (prose-only) and an HONORED no-diff marker
 * (#792: `noDiff` AND non-empty evidence AND no code paths — a contradictory
 * marker with paths lets the paths win, exactly as `classifyDeliverables`
 * does) both mean "nothing to measure", so neither can make a plan look wrong.
 */
function measurable(d: SpecCoverageDeliverable, paths: string[]): boolean {
  if (paths.length === 0) return false;
  // The contradictory case (a marker AND real paths) is judged by its PATHS,
  // byte-for-byte the rule in `classifyDeliverables` — which honours the
  // marker only when `paths.length === 0`. An earlier draft of this gate
  // exempted a marker regardless of paths, which is how a fabricated
  // `noDiff: true` on a deliverable that names four files would have walked
  // the fabricated work straight past the gate.
  if (d.noDiff === true && (d.noDiffEvidence ?? "").trim().length > 0 && paths.length === 0) {
    return false;
  }
  return true;
}

/**
 * Which deliverables does this plan not cover, and which deliverables were
 * even checkable?
 *
 * EVERY-path semantics (the gap gate's stated policy, mirroring #540's
 * full-set rule in `verifyConsolidation`): a deliverable with two declared
 * paths is uncovered when the plan covers one of them. A partial sibling
 * cannot stand in for the missing half.
 *
 * Returns `checkedCount: 0` when no deliverable carries a path — the caller
 * must read that as "this gate has nothing to say", NOT as a pass it earned
 * and certainly not as a rejection.
 */
export function findUncoveredDeliverables(
  workstreams: Record<string, SpecCoverageWorkstream>,
  spec: SpecCoverageSpec | undefined,
): { uncovered: UncoveredDeliverable[]; checkedCount: number } {
  const deliverables = spec?.deliverables ?? [];
  const workstreamPaths = normalisedPaths(
    Object.values(workstreams).flatMap((ws) => ws?.paths ?? []),
  );
  const uncovered: UncoveredDeliverable[] = [];
  let checkedCount = 0;
  for (const d of deliverables) {
    const paths = normalisedPaths(d.paths);
    if (!measurable(d, paths)) continue;
    checkedCount += 1;
    if (paths.every((p) => coveredBy(p, workstreamPaths))) continue;
    uncovered.push({ id: d.id, paths });
  }
  return { uncovered, checkedCount };
}

/** How many `## <name>` headings a reply carries. */
export function countMarkdownSections(text: string, name: string): number {
  const re = new RegExp(`^##\\s+${name}\\s*$`, "gim");
  let n = 0;
  for (const _match of text.matchAll(re)) n += 1;
  return n;
}

/** The two ways a plan reply can fail the plan-to-spec gate. */
export type PlanSpecMismatchKind = "multiple-workstream-blocks" | "uncovered-deliverables";

/** The verdict of the plan-to-spec gate. */
export interface PlanSpecMismatch {
  kind: PlanSpecMismatchKind;
  /** Operator-facing detail: what was found, and what is missing. */
  evidence: string;
  /** `multiple-workstream-blocks` only. */
  blockCount?: number;
  /** `uncovered-deliverables` only. */
  uncovered?: UncoveredDeliverable[];
}

/**
 * The plan-to-spec gate, one pure synchronous call over (text, workstreams,
 * spec). Order is load-bearing: an ambiguous reply's workstreams are the
 * FIRST block's parsed result, so coverage over them says nothing — the
 * ambiguity is the actionable finding and it is reported first.
 *
 * `undefined` means the gate is satisfied OR has nothing to judge (no spec,
 * no deliverables, no measurable deliverable). Silence from this function is
 * never evidence a plan is right; it is evidence it could not be judged, and
 * only the ambiguity branch and the uncovered branch assert anything.
 */
export function planSpecMismatchReason(
  text: string,
  workstreams: Record<string, SpecCoverageWorkstream>,
  spec: SpecCoverageSpec | undefined,
): PlanSpecMismatch | undefined {
  const blocks = countMarkdownSections(text, "Workstreams");
  if (blocks > 1) {
    return {
      kind: "multiple-workstream-blocks",
      blockCount: blocks,
      evidence: `the plan reply contains ${blocks} '## Workstreams' sections; the driver read the first and would have built only that one. Emit exactly one '## Workstreams' section.`,
    };
  }
  // A reply with NO `## Workstreams` section at all is not a plan the gate can
  // judge: `runPlan` synthesises the single `default` workstream downstream and
  // the cycle proceeds as a single-task build (long-standing, tested behaviour
  // — test-work-driver-skeleton.ts). Rejecting it here would turn every
  // no-block plan into a halt, and it would do so on evidence the planner never
  // gave: an absent block is silence, and silence is not a wrong plan.
  if (blocks === 0) return undefined;
  const { uncovered, checkedCount } = findUncoveredDeliverables(workstreams, spec);
  if (checkedCount === 0 || uncovered.length === 0) return undefined;
  return {
    kind: "uncovered-deliverables",
    uncovered,
    evidence: `no workstream in this plan declares any path of ${uncovered.length} deliverable(s) the spec requires: ${uncovered
      .map((u) => `${u.id} (${u.paths.join(", ")})`)
      .join("; ")}. Every declared path belongs to this issue's deliverables.`,
  };
}

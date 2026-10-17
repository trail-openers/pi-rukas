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
 * 2. The multi-block branch of `planSpecMismatchReason` — which reads its
 *    `## Workstreams` count through `countMarkdownSections` (work-driver-plan-parse.ts,
 *    the ONE definition of that counter; an earlier draft of this module grew
 *    a second copy and the two drifted silently) — rejects a reply carrying
 *    more than one `##
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
 *
 * #819 round-2 — this module no longer re-exports `countMarkdownSections`.
 * It used to carry a SECOND copy of that counter (byte-identical to the parse
 * module's, but a second copy is exactly the drift hazard the round removed)
 * and re-exported it, so importers of *this* module got the coverage copy.
 * Anything that wants the counter now imports it from
 * `work-driver-plan-parse.ts` directly — or from `work-driver-plan.ts`, which
 * re-exports the one definition.
 */

import { countMarkdownSections } from "./work-driver-plan-parse.ts";
import { isPlainRepoRelativePath } from "./work-driver-plan-paths.ts";
import { PLAN_SINGLE_BLOCK_RULE } from "./work-driver-prompts-plan.ts";
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
 * paths to point at. Three shapes mean "nothing to measure", so none of them
 * can make a plan look wrong:
 *
 * 1. EMPTY paths after normalisation — a prose deliverable, or one whose only
 *    `paths:` slot was blank/whitespace. `classifyDeliverables` calls this
 *    `unmeasurable` for the same reason.
 * 2. A path that is not a plain repo-relative path at all (`"tbd"`, `"TBD"`,
 *    `"N/A"`, `"none"`, or a whole sentence). `isPlainRepoRelativePath` is
 *    deliberately a DANGEROUS-CHARACTER check (its job is the shell-injection
 *    surface in the coupling merge's grep), so it alone lets `"n/a"` through as
 *    a syntactically fine relative path — which is exactly the slot shape real
 *    specs carry. The placeholder list below is the second, complementary
 *    check: a slot that is a known filler word is not an ownership claim
 *    either. Between the two, `"n/a"` and `"will land somewhere sensible"` are
 *    both excluded, and a genuine filename is not. Measured against a
 *    workstream union either shape would be UNCOVERED by construction, which is
 *    a rejection the planner cannot act on — the defect is in the spec's slot,
 *    not in the plan. The shape gate calls the same `isPlainRepoRelativePath`
 *    predicate `invalid-path` on the workstream side, so the dangerous half of
 *    the rule is shared verbatim.
 * 3. An HONORED no-diff marker (#792: `noDiff` AND non-empty evidence AND no
 *    code paths). A contradictory marker with paths lets the paths win, exactly
 *    as `classifyDeliverables` does.
 *
 * #819 round-2 — the `noDiff` + real-paths case is handled by clause 3 NOT
 * firing (its `paths.length === 0` guard) and the paths then winning, so there
 * is no separate "no diff" branch here to keep in sync; the earlier draft of
 * this function had an unreachable one that duplicated clause 3's condition.
 */
function measurable(d: SpecCoverageDeliverable, paths: string[]): boolean {
  if (paths.length === 0) return false;
  // Not a path → not measurable. Any non-path slot disqualifies the whole
  // deliverable: a partial list cannot be honestly judged either, since the
  // EVERY-path rule would reject the plan for the prose half anyway.
  if (!paths.every((p) => isPlainRepoRelativePath(p) && !isPlaceholderPath(p))) return false;
  if (d.noDiff === true && (d.noDiffEvidence ?? "").trim().length > 0 && paths.length === 0) {
    return false;
  }
  return true;
}

/**
 * Placeholder `paths:` slots a real spec has been seen to carry when the
 * resolver had no file to name. Compared case-insensitively and after
 * stripping punctuation, because the same intent arrives as `n/a`, `N/A`,
 * `n.a.` and `"—"`.
 *
 * Why a list and not a heuristic: the dangerous-character check alone is not
 * enough ("n/a" has no metacharacters and is a legal relative path), and a
 * heuristic like "no dot → not a file" would drop `extension/smoke-tests/`,
 * which is a legitimate DIRECTORY and one of the #818 fixture's deliverables.
 * A short explicit set cannot misfire on a filename, and a slot that is not in
 * the set is judged by the rules the converge gate already uses.
 */
const PLACEHOLDER_PATHS = new Set([
  "n/a",
  "na",
  "none",
  "null",
  "nil",
  "tbd",
  "todo",
  "tentative",
  "unknown",
  "unspecified",
  "placeholder",
  "prose",
  "-",
  "—",
  ".",
  "…",
]);

function isPlaceholderPath(p: string): boolean {
  return PLACEHOLDER_PATHS.has(p.trim().toLowerCase().replace(/[.]+$/, ""));
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
  // #819 round-2 — an HONORED no-diff deliverable (#792) is excluded from the
  // comparison so it neither produces an uncovered row nor counts as judged.
  // `measurable` already decides that, with the SAME three clauses
  // `classifyDeliverables` uses: empty paths, a non-path slot, and the
  // honoured marker (which requires `paths.length === 0`, so a CONTRADICTORY
  // marker + real paths falls through and the paths win — deterministic, and
  // byte-for-byte the converge gate's rule).
  const measurableDeliverables = deliverables.filter((d) =>
    measurable(d, normalisedPaths(d.paths)),
  );
  const uncovered: UncoveredDeliverable[] = [];
  let checkedCount = 0;
  for (const d of measurableDeliverables) {
    const paths = normalisedPaths(d.paths);
    if (!measurable(d, paths)) continue;
    checkedCount += 1;
    if (paths.every((p) => coveredBy(p, workstreamPaths))) continue;
    uncovered.push({ id: d.id, paths });
  }
  return { uncovered, checkedCount };
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
      evidence: `the plan reply contains ${blocks} '## Workstreams' sections; the driver read the first and would have built only that one. ${PLAN_SINGLE_BLOCK_RULE}`,
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

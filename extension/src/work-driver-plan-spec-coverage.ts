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

import {
  declaredPathMatches,
  declaredPathsCoveredBy,
  isPlaceholderPath,
  measurableAlternative,
  splitDeclaredSlots,
  splitDeliverablePaths,
  toAlternative,
} from "./work-driver-deliverable-paths.ts";
import { countMarkdownSections } from "./work-driver-plan-parse.ts";
import { isPlainRepoRelativePath } from "./work-driver-plan-paths.ts";
import { PLAN_SINGLE_BLOCK_RULE } from "./work-driver-prompts-plan.ts";

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

/**
 * The deliverable's declared SLOTS, deduped by text. Slot-level, not
 * alternative-level: #1155 makes the alternatives of one slot an EITHER/OR
 * (any one satisfies it) while a comma-separated slot stays a separate piece
 * of declared work (every one must land). Flattening the two — which is what
 * an earlier draft of this gate did — reads
 * `[paths: src/a.ts or src/b.ts]` as two paths that both need a workstream,
 * so a plan declaring only `src/b.ts` was rejected for work the develop gate
 * would have passed. `findUncoveredDeliverables` compares slot-to-slot with
 * `coveredBy`, which is the converge gate's own slot matcher, so "covered" and
 * "delivered" are one decision made once (#1155).
 */
function declaredSlots(paths: string[] | undefined): string[] {
  return [...new Set(splitDeclaredSlots(paths))];
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
 *
 * #1155 — the implementation is `declaredPathsCoveredBy`, the converge gate's
 * own slot matcher run against declarations instead of a diff set. That is the
 * point: this gate and the converge gate must agree about what a `[paths:]`
 * slot means, so an either/or is covered by a workstream that declared ONE
 * alternative of it, exactly as develop counts it delivered when one
 * alternative lands.
 */
function coveredBy(path: string, workstreamPaths: string[]): boolean {
  return declaredPathsCoveredBy(path, workstreamPaths);
}

/**
 * A deliverable participates in the comparison only when it carries concrete
 * paths to point at. Three shapes mean "nothing to measure", so none of them
 * can make a plan look wrong:
 *
 * 1. EMPTY paths after normalisation — a prose deliverable, or one whose only
 *    `paths:` slot was blank/whitespace. `classifyDeliverables` calls this
 *    `unmeasurable` for the same reason.
 * 2. Not a path at all, once its alternatives are split: a slot whose every
 *    alternative is a filler word (`"tbd"`, `"N/A"`, `"none"`) or fails the
 *    shell-metacharacter shape gate. `deliverablePathAlternatives` +
 *    `measurableAlternative` ARE the converge gate's predicates — same
 *    placeholder list, same `isPlainRepoRelativePath` shape gate, same
 *    alternatives split — so the two gates cannot disagree about whether a
 *    slot is judgeable. `isPlainRepoRelativePath` alone is a DANGEROUS-
 *    CHARACTER check (its job is the shell-injection surface in the coupling
 *    merge's grep), so it alone lets `"n/a"` through as a syntactically fine
 *    relative path — which is exactly the slot shape real specs carry. Measured
 *    against a workstream union either shape would be UNCOVERED by construction,
 *    which is a rejection the planner cannot act on — the defect is in the
 *    spec's slot, not in the plan.
 *    #1155 — the alternatives split is what makes this clause honest. The
 *    pre-#1155 check ran `paths.every(...)` over UNSPLIT slots, so an either/or
 *    like `"src/a.ts or see the issue"` was one non-path slot and the whole
 *    deliverable was excluded; now the measurable half still counts, and a
 *    deliverable is excluded only when NOTHING in it is measurable.
 * 3. An HONORED no-diff marker (#792: `noDiff` AND non-empty evidence AND no
 *    code paths). A contradictory marker with paths lets the paths win, exactly
 *    as `classifyDeliverables` does.
 *
 * #819 round-3 — the marker clause is GONE, along with the third branch that
 * used to spell it out. It tested `noDiff && evidence && paths.length === 0`
 * two lines after line 1 had already returned for `paths.length === 0`, so it
 * could not fire: the earlier draft carried it as a separate "no diff" branch
 * duplicating clause 3's condition, and a branch that cannot be entered is not
 * a rule, it is a reader's burden. What the behaviour needs is exactly two
 * tests — "no paths at all" and "a slot that is not a path" — because
 * `noDiff` (the plan-time #792 marker) is only ever honoured when the
 * deliverable declares no code paths, and that is the first test. The docblock
 * above describes the code that is here: a deliverable with REAL paths is
 * measurable whatever its marker claims, and the paths win.
 */
function measurable(d: SpecCoverageDeliverable, paths: string[]): boolean {
  // Clause 1 — nothing to point at. This is also what makes an honoured no-diff
  // marker (clause 3) unmeasurable: the marker is only honoured when the
  // deliverable declares no paths, so it never needs its own branch.
  if (paths.length === 0) return false;
  // Clause 2 — EVERY unit (comma-separated slot, with alternatives split out)
  // is measurable. #819 round-2 wrote this as "every path", and #1155 keeps
  // it: a mixed list (`src/a.ts`, `n/a`) is excluded wholesale because the
  // every-path rule would reject the plan for the prose half regardless, so
  // judging the measurable half would only produce a rejection nobody can fix.
  // What #1155 changes is the UNIT the rule reads — an either/or is one unit
  // with alternatives, not two units, so `src/a.ts or src/b.ts` stays
  // measurable while a literal `n/a` slot still disqualifies.
  return splitDeliverablePaths(paths.join(",")).every((unit) => {
    // Judgeable means the diff could ever answer: a placeholder word (`n/a`,
    // `tbd`) never can, and neither can anything that is neither a plain
    // repo-relative path nor a template whose SEGMENTS are plain. The template
    // case cannot go through `isPlainRepoRelativePath` directly — it rejects
    // `<` and `>` as shell metacharacters, so a whole-directory template would
    // read as prose and every deliverable with one would silently leave the
    // #819 gate. `measurableAlternative` is the converge gate's own answer to
    // the same question, so plan time and develop time agree (#1155).
    if (isPlaceholderPath(unit)) return false;
    // `measurableAlternative` IS the converge gate's predicate (shared grammar,
    // shared placeholder list, shared shape gate) — plan time and develop time
    // cannot disagree about whether a unit is judgeable (#1155).
    return measurableAlternative(toAlternative(unit));
  });
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
 * #1155 — "two declared paths" now counts ALTERNATIVES, so
 * `[paths: src/a.ts or src/b.ts]` is ONE unit that either workstream half can
 * cover, not two units that both must. That is the converge gate's ANY-
 * alternative rule; keeping EVERY-over-alternatives here would make the
 * coverage gate reject a plan the develop gate would pass, which is the drift
 * this module exists to prevent.
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
  // Workstream paths stay a flat list: they are the comparison POOL, and a
  // slot counts as covered when ANY declared path in the pool covers it.
  const workstreamPaths = splitDeclaredSlots(
    Object.values(workstreams).flatMap((ws) => ws?.paths ?? []),
  );
  // #819 round-2 — an HONORED no-diff deliverable (#792) is excluded from the
  // comparison so it neither produces an uncovered row nor counts as judged.
  // `measurable` already decides that, with the SAME three clauses
  // `classifyDeliverables` uses: empty paths, a non-path slot, and the
  // honoured marker (which requires `paths.length === 0`, so a CONTRADICTORY
  // marker + real paths falls through and the paths win — deterministic, and
  // byte-for-byte the converge gate's rule).
  const measurableDeliverables = deliverables.filter((d) => measurable(d, declaredSlots(d.paths)));
  const uncovered: UncoveredDeliverable[] = [];
  let checkedCount = 0;
  for (const d of measurableDeliverables) {
    const paths = declaredSlots(d.paths);
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

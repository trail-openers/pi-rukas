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
 * 2. (#1652) The multi-block branch that read a markdown `## Workstreams`
 *    count is gone: workstreams arrive as tool calls, so a reply can no longer
 *    carry an ambiguous block. What the gate still refuses is a plan with no
 *    accepted calls at all, which the plan step's corrective handles before
 *    this gate runs.
 *
 * `normaliseDeclaredPath` runs on BOTH sides, through `splitDeclaredSlots`.
 * Declared paths are prose from a planner, not `git` output — `"src/a.ts (new)"`,
 * `` "`src/a.ts`" ``, `"**src/a.ts**"`, `"extension/smoke-tests/"` are all real
 * shapes seen in state files, and comparing un-normalised strings on one side
 * reintroduces false mismatches (the #875 lesson). Since #1707 that pass strips
 * only PAIRED markup, so it is also the form the exemption judge reads: one
 * path, one representation, no raw/normalised pair that can disagree.
 *
 * #819 round-2 — this module no longer re-exports `countMarkdownSections`.
 * It used to carry a SECOND copy of that counter (byte-identical to the parse
 * module's, but a second copy is exactly the drift hazard the round removed)
 * and re-exported it, so importers of *this* module got the coverage copy.
 * Anything that wants the counter now imports it from
 * `work-driver-plan-parse.ts` directly — or from `work-driver-plan.ts`, which
 * re-exports the one definition.
 */

import { hasPathspecChar } from "./plan-path-shape.ts";
import {
  containsAnglePlaceholder,
  declaredPathMatches,
  declaredPathsCoveredBy,
  isPlaceholderPath,
  measurableAlternative,
  splitDeclaredSlots,
  splitDeliverablePaths,
  toAlternative,
} from "./work-driver-deliverable-paths.ts";
import { isProtectedPath } from "./work-driver-doctrine.ts";
import { isPlainRepoRelativePath } from "./work-driver-plan-paths.ts";
import { ungrantedProtectedPaths } from "./work-driver-protected-grant.ts";

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
  /**
   * The deliverable's normalised declared paths THAT A PLAN MAY BE ASKED FOR —
   * what the plan should cover: the slots left after the two exclusions
   * (`isDeferredProtectedSlot`, `planDeclarableSlot`), in the one form this
   * module reads (see `declaredSlots`). A glob or `<name>` template never
   * appears here, because naming one in a `paths` entry is refused by
   * `plannedPathProblem` and the operator would be told to declare something
   * the plan schema rejects. An annotated or emphasised slot
   * (`"src/a.ts (new)"`, `"**src/a.ts**"`) DOES appear here — normalised to
   * `src/a.ts` — because the markup is prose around a path the plan still
   * owes (#1707).
   */
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
 *
 * #1707 — this is the ONLY slot representation the gate reads. It is
 * normalised (so `**src/a.ts**` and `` `src/a.ts` `` and `src/a.ts (new)` all
 * reach the judge as `src/a.ts`) and it keeps every `*` the planner wrote
 * (so `src/foo/*` reaches the judge as a glob). One path, one form: the gate
 * never holds a raw text and a normalised text of the same slot, which is what
 * let the previous round's raw-form judge read markdown emphasis as a wildcard
 * while the coverage comparison used the concrete path beneath it.
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
 * A slot alternative the planner may not name: a glob/pathspec character
 * (`* ? !` — `hasPathspecChar`, the ONE clause `plannedPathProblem` refuses,
 * shared so the refusal and the exemption cannot drift) or a `<name>` template
 * (the grammar's placeholder form, asked of the module that owns it —
 * `containsAnglePlaceholder`, no third copy of that regex).
 *
 * Judged on the NORMALISED slot, which since #1707 is the form that still
 * carries the wildcard. The previous round judged the raw text instead, which
 * failed twice over: `normaliseDeclaredPath` had already eaten a trailing `*`
 * by the time a spec was parsed (so the raw text was never seen in production
 * at all), and a markdown-bold concrete path (`**extension/src/x.ts**`) read as
 * a pattern and was silently exempted — a concrete required slot dropped from
 * the gate, the opposite of the fail-safe this exemption is supposed to be.
 */
function isPatternAlternative(normalisedAlt: string): boolean {
  return hasPathspecChar(normalisedAlt) || containsAnglePlaceholder(normalisedAlt);
}

/**
 * Could a PLAN declare this slot at all? #1642 run 6b, measured on #1557.
 *
 * `measurableAlternative` answers the CONVERGE gate's question — could a diff
 * ever answer this slot — and a pattern answers it yes, because develop
 * creates real files a template matches. The plan-time question is different,
 * and the answer for a pattern is no: a `report_workstream` `paths` entry must
 * pass `plannedPathProblem`, whose glob clause refuses `* ? !` outright, so no
 * honest plan can ever name the slot. Requiring coverage of such a slot
 * rejects every plan for that deliverable, including the correct one: #1557's
 * d1 declared four concrete files plus `extension/src/review-ledger-*.ts`
 * (the split the 500-line ratchet forces), BOTH plan replies declared all four
 * concrete files, and the gate parked the cycle on d1 anyway — twice.
 *
 * The exemption is EXACTLY that clause, and nothing wider. `-dash.ts`,
 * `:magic.ts`, a NUL or a zero-width are refused by OTHER clauses of
 * `plannedPathProblem`; those slots STAY required — they are defects in the
 * spec's own slot that the repair and the operator must still be told about
 * (pinned by `test-plan-spec-mismatch-repair.ts` and
 * `test-plan-repair-invisible-path.ts`), and exempting them would silence a
 * guard written on purpose. A pattern is different in kind: it is a shape the
 * planner is never offered. And a slot with a concrete alternative among
 * several (`a.ts or new-b-*.ts`) stays required, because declaring `a.ts`
 * covers it.
 *
 * It lives here, beside its only reader, rather than in
 * `work-driver-deliverable-paths.ts`: that module owns what a slot MEANS, and
 * this asks what a PLAN MAY BE ASKED FOR — a fact about the planner's schema,
 * not the path grammar, with one caller.
 *
 * The caller passes the NORMALISED slot (`splitDeclaredSlots` already ran, so
 * a caller holding raw spec text — the artifact restore path, where
 * `validateSpec` keeps `d.paths` verbatim — must normalise before asking).
 * The agreement with `plannedPathProblem` is structural — both call
 * `hasPathspecChar` — and `test-plan-spec-glob-coverage.ts` additionally
 * asserts that every slot this exempts is a slot `plannedPathProblem` actually
 * refuses.
 *
 * What this does NOT do: it is not "the deliverable is covered". It removes a
 * requirement no plan can satisfy. The concrete half of a mixed deliverable is
 * still demanded slot by slot, and a workstream that declared only files
 * matching the pattern still covers nothing of it — the pattern stays measured
 * at converge, where a real diff CAN answer it.
 */
export function planDeclarableSlot(slot: string): boolean {
  const alternatives = splitDeliverablePaths(slot);
  return alternatives.length > 0 && alternatives.some((alt) => !isPatternAlternative(alt));
}

/**
 * #1642 — a declared slot the plan CANNOT cover because the cycle may not write
 * it: every alternative is a protected path (`isProtectedPath`) and none is
 * named by the operator's `--allow-protected` grant. The planner leaves such a
 * slot out on purpose (develop would park on it), so requiring coverage would
 * reject every plan for a deliverable the cycle was never allowed to build.
 * Deferred, not dropped: `protectedDeferralsOf` names it for the trace.
 *
 * Takes ONE form — the normalised slot every other predicate in this module
 * reads (#1707): `splitDeliverablePaths` is idempotent on it, so protected and
 * declarable are judged on the same text coverage is compared with.
 */
function isDeferredProtectedSlot(slot: string, grant: readonly string[]): boolean {
  const alternatives = splitDeliverablePaths(slot);
  return (
    alternatives.length > 0 &&
    alternatives.every(
      (alt) => isProtectedPath(alt) && ungrantedProtectedPaths([alt], grant).length > 0,
    )
  );
}

/**
 * #1642 — the slots of each measurable deliverable that are deferred as
 * protected (see `isDeferredProtectedSlot`). Pure; the plan step traces it so
 * the operator can see what the gate did not require. Empty when nothing was
 * deferred.
 */
export function protectedDeferralsOf(
  spec: SpecCoverageSpec | undefined,
  grant: readonly string[],
): Array<{ id: string; paths: string[] }> {
  const out: Array<{ id: string; paths: string[] }> = [];
  for (const d of spec?.deliverables ?? []) {
    const paths = declaredSlots(d.paths);
    if (!measurable(d, paths)) continue;
    const deferred = paths.filter((p) => isDeferredProtectedSlot(p, grant));
    if (deferred.length > 0) out.push({ id: d.id, paths: deferred });
  }
  return out;
}

/**
 * #1707 — the slots of each measurable deliverable that are exempted as
 * UNDECLARABLE (a glob/pathspec character or a `<name>` template — see
 * `planDeclarableSlot`). The plan step traces these so the operator can see
 * that the gate dropped a slot rather than judging it; without the trace, a
 * deliverable whose every slot is exempted vanishes from `checkedCount` and a
 * gate that judged nothing is indistinguishable from one that judged everything
 * and found no fault. Mirrors `protectedDeferralsOf`. Empty when nothing was
 * exempted.
 */
export function undeclarableSlotsOf(
  spec: SpecCoverageSpec | undefined,
): Array<{ id: string; paths: string[] }> {
  const out: Array<{ id: string; paths: string[] }> = [];
  for (const d of spec?.deliverables ?? []) {
    const paths = declaredSlots(d.paths);
    if (!measurable(d, paths)) continue;
    const exempt = paths.filter((slot) => !planDeclarableSlot(slot));
    if (exempt.length > 0) out.push({ id: d.id, paths: exempt });
  }
  return out;
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
 *
 * #1642 run 6b (#1557) — a SECOND class of slot is not the plan's to cover:
 * one no plan can NAME. `isDeferredProtectedSlot` exempts what the cycle may
 * not write; `planDeclarableSlot` exempts what the planner may not declare —
 * a glob or `<name>` template, which `plannedPathProblem` refuses in a
 * `report_workstream` `paths` entry. Measured on #1557: a deliverable of four
 * concrete files plus one glob, both replies declaring all four concrete
 * files, parked the cycle twice on "no workstream declares any path" of a
 * slot nobody is allowed to write. The exemption removes the impossible
 * demand only — every concrete slot of the same deliverable is still demanded
 * and the gate still bites (see the mixed-deliverable cases in
 * `test-plan-spec-glob-coverage.ts`), and the glob itself stays measured at
 * converge, where a real diff CAN answer it.
 */
export function findUncoveredDeliverables(
  workstreams: Record<string, SpecCoverageWorkstream>,
  spec: SpecCoverageSpec | undefined,
  grant: readonly string[],
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
    // #1642 — protected slots the cycle may not write are not the plan's to
    // cover, and a template slot is not the plan's to DECLARE (see
    // `planDeclarableSlot`); the rest (a mixed deliverable's concrete half)
    // still are. Both predicates read the SAME normalised slot coverage is
    // compared with (#1707) — there is no second, as-written form to judge,
    // so a markdown-bold concrete path cannot exempt itself by looking like a
    // glob and a written glob cannot hide behind a star-stripped name.
    const required = paths.filter(
      (slot) => !isDeferredProtectedSlot(slot, grant) && planDeclarableSlot(slot),
    );
    if (required.length === 0) continue;
    checkedCount += 1;
    if (required.every((p) => coveredBy(p, workstreamPaths))) continue;
    uncovered.push({ id: d.id, paths: required });
  }
  return { uncovered, checkedCount };
}

/**
 * The ways a plan can fail the plan-to-spec gate. Zero report_workstream calls
 * is NOT one of them (#1652): with no plan there is nothing to compare against
 * the spec, so that outcome has its own verdict (`planNoWorkstreamCallsCap`).
 */
export type PlanSpecMismatchKind = "uncovered-deliverables";

/** The verdict of the plan-to-spec gate. */
export interface PlanSpecMismatch {
  kind: PlanSpecMismatchKind;
  /** Operator-facing detail: what was found, and what is missing. */
  evidence: string;
  /** `uncovered-deliverables` only. */
  uncovered?: UncoveredDeliverable[];
}

/**
 * The plan-to-spec gate, one pure synchronous call over (workstreams, spec).
 *
 * `undefined` means the gate is satisfied OR has nothing to judge (no spec,
 * no deliverables, no measurable deliverable, no workstreams). A plan whose
 * every measurable deliverable is a protected path the grant does not admit is
 * a mismatch, not silence (#1642). Silence from
 * this function is never evidence a plan is right; it is evidence it could not
 * be judged. A plan with NO accepted workstream calls is not judged here at
 * all: the plan step's zero-call corrective owns that case (#1652).
 */
export function planSpecMismatchReason(
  workstreams: Record<string, SpecCoverageWorkstream>,
  spec: SpecCoverageSpec | undefined,
  grant: readonly string[],
): PlanSpecMismatch | undefined {
  if (Object.keys(workstreams).length === 0) return undefined;
  const { uncovered, checkedCount } = findUncoveredDeliverables(workstreams, spec, grant);
  if (checkedCount === 0) {
    // #1642 — every measurable deliverable is deferred as a protected path the
    // grant does not admit, so nothing was judged. That must not pass silently:
    // the operator has to grant the paths, or the cycle builds nothing.
    const deferred = protectedDeferralsOf(spec, grant);
    if (deferred.length === 0) return undefined;
    return {
      kind: "uncovered-deliverables",
      uncovered: deferred,
      evidence: `every deliverable the spec requires is a protected path this cycle may not write, so the plan covers none of them: ${deferred
        .map((d) => `${d.id} (${d.paths.join(", ")})`)
        .join("; ")}. Re-run with --allow-protected <path> for each path this issue must change.`,
    };
  }
  if (uncovered.length === 0) return undefined;
  return {
    kind: "uncovered-deliverables",
    uncovered,
    evidence: `no workstream in this plan declares any path of ${uncovered.length} deliverable(s) the spec requires: ${uncovered
      .map((u) => `${u.id} (${u.paths.join(", ")})`)
      .join("; ")}. Every declared path belongs to this issue's deliverables.`,
  };
}

/**
 * work-driver-converge-classify — the converge gate's PURE classification
 * (#741; #1155). Split out of `work-driver-converge.ts` under AGENTS.md §12's
 * 500-line cap: the gate grew the alternatives grammar and the file crossed
 * the limit, so the classification — the part with no git, no `DriverContext`
 * and no state — moved here. Behaviour is unchanged from the split; what lives
 * here is the whole reason the gate exists and the only part a smoke test can
 * exercise without a filesystem.
 *
 * The gate itself (`runConvergeGate`, `readEndOfDevelopDiff`,
 * `buildConvergeCorrectivePrompt`, ownership attribution) stays in
 * `work-driver-converge.ts` and re-exports these types, so importers do not
 * change.
 *
 * Classification is DETERMINISTIC path presence — zero LLM calls. A diff file
 * "satisfies" a declared path when it equals the normalised path, sits beneath
 * it (a directory declaration covers its contents), or matches one of its
 * template alternatives. Paths are normalised with `normaliseDeclaredPath` for
 * the same reason the verify gate does: they are planner prose, not `git`
 * output, and `"src/a.ts (new)"` must read as `src/a.ts`.
 *
 * #1155 — a declared path is a LIST OF ALTERNATIVES, not a literal. The plan
 * writes prose, so `[paths: extension/src/verify.ts or new work-driver-<name>.ts]`
 * is one slot meaning two paths, and `<name>` is a template the planner left
 * rather than a filename. Before this, both read as one literal string no
 * `git diff --name-only` could contain, so the developers' real file
 * (`work-driver-acceptance-coverage.ts`) classified `absent`, the corrective
 * re-dispatch spent 76 min trying to create `work-driver-<name>.ts`, and a
 * 154-min cycle parked. The rule the operator decided: a deliverable counts as
 * delivered when ANY alternative matches the diff (segment-anchored glob for
 * templates); `partial` uses the same matching; a deliverable with NO concrete
 * or glob alternative at all is `unmeasurable` — a warning, never a cap — and
 * only a deliverable that has at least one measurable alternative and matches
 * none of them is `absent`. The grammar lives in
 * `work-driver-deliverable-paths.ts`, which the #819 plan-to-spec coverage gate
 * calls too, so the two gates cannot disagree about what a `[paths:]` slot
 * means.
 */

import {
  declaredPathMatches,
  declaresNoMeasurablePath,
  deliverablePathAlternatives,
  isPlaceholderPath,
  splitDeclaredSlots,
} from "./work-driver-deliverable-paths.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";

export type DeliverableStatus = "implemented" | "partial" | "absent" | "unmeasurable" | "no-diff";

export interface ConvergeDeliverableResult {
  id: string;
  status: DeliverableStatus;
  /** The normalised declared paths this deliverable declared. */
  paths: string[];
  /** Of those, which are present in the diff. */
  present: string[];
  /** Of those, which are missing from the diff (absent/partial only). */
  missing: string[];
  /** One-line, operator-readable reason (rendered in handoff + PR body). */
  reason: string;
  /**
   * The evidence string recorded at plan time for a `no-diff` deliverable
   * (a command to run, an API endpoint, or a settings URL). Surfaced verbatim
   * in the operator-actions render. `undefined` for all other statuses.
   */
  noDiffEvidence?: string;
  /**
   * #1137 d2 — the workstream id(s) that delivered this deliverable's paths
   * (the workstream(s) whose declared paths overlap this deliverable's paths
   * AND whose paths are present in the consolidated diff). `undefined` when
   * no workstream claim can be resolved (N=1 default workstream, or no
   * workstream declared the paths). Present on `implemented` results to make
   * the "sibling-delivered" behavior explicit: a deliverable is `implemented`
   * when ANY workstream delivered its paths, not just the "owning" one.
   */
  deliveredBy?: string[];
}

export interface ConvergeVerdict {
  /**
   * Reserved for a future readable-but-incomplete diff reading (e.g. a
   * per-worktree partial failure the gate wants to surface). Today the
   * only unreadable path returns `null` before classification, so this is
   * always `false` — the gate degrades to pass rather than emitting a
   * half-classified verdict.
   */
  diffUnreadable: boolean;
  deliverables: ConvergeDeliverableResult[];
  absent: ConvergeDeliverableResult[];
  partial: ConvergeDeliverableResult[];
  /**
   * Deliverables classified `no-diff` — the gate checked and the absence
   * is correct by design (settings toggle, operator action, etc.). These
   * are NOT blockers; they are surfaced as operator actions in the
   * completion report and PR body. Distinct from `unmeasurable` (the gate
   * cannot check this) and from `absent` (the gate checked and the work
   * is missing).
   */
  noDiff: ConvergeDeliverableResult[];
  /**
   * #1155 — deliverables the gate could NOT judge: no declared paths, or paths
   * that parse to no concrete or glob alternative. Never a blocker (the issue's
   * decided rule: a warning, never a cap), and the reason string says so. The
   * `partial` list has no equivalent because the gate never had a channel for
   * it on the verdict object at all — this list is what the warning-not-park
   * path needs to be findable, so it is on the verdict rather than only in
   * `convergeEvidence`.
   */
  unmeasurable: ConvergeDeliverableResult[];
}

/**
 * The deliverable shape accepted by `classifyDeliverables`. Extends the
 * inline shape with the optional plan-time no-diff marker (issue #792):
 * `noDiff` flags a deliverable that produces no diff by design, and
 * `noDiffEvidence` carries the evidence string (command, API endpoint, or
 * settings URL) that makes the marker actionable. When `noDiff` is true but
 * `noDiffEvidence` is absent or empty, the marker is NOT honoured — the
 * deliverable classifies as it would without the marker (absent if it has
 * paths, unmeasurable if it does not). A contradictory case (both valid code
 * paths AND a no-diff marker) lets the code paths win: the marker is ignored
 * and the deliverable is classified by path presence.
 */
export interface ClassifyDeliverableInput {
  id: string;
  description: string;
  paths: string[];
  /** Plan-time marker: this deliverable produces no diff by design. */
  noDiff?: boolean;
  /** Evidence string required for the no-diff marker to be honoured. */
  noDiffEvidence?: string;
}

/**
 * #1137 d2 — the workstream ownership map passed to `classifyDeliverables`
 * for the `deliveredBy` field. Maps workstream id → its declared (normalised)
 * paths. When absent, `deliveredBy` is not populated (the gate degrades to
 * the pre-#1137 shape: status + reason only, no attribution).
 */
export interface WorkstreamPathsMap {
  [workstreamId: string]: string[];
}

/**
 * #1155 — the slots that carry a PATH SHAPE, i.e. everything the parser was
 * given except a bare filler word. A deliverable whose only `paths:` entry is
 * the token `n/a` declared nothing at all (that is the #792 pathless case, and
 * the existing test asserts it still reaches `absent` when a no-diff marker
 * without evidence is present); a slot that reads like a path but parses to no
 * measurable alternative (`n/a — repo settings`, a sentence) is the case #1155
 * turns from a park into a warning. Splitting the two on "did the author write
 * a path-shaped thing" keeps the #792 assertion true while the new rule lands.
 */
function pathShapedSlots(paths: readonly string[] | undefined): string[] {
  return splitDeclaredSlots(paths).filter((s) => !isPlaceholderPath(s));
}

/**
 * The `unmeasurable` reason for a deliverable that DID declare paths but none
 * the gate can measure (#1155). Wording matters: this row is the warning the
 * issue asks for in the handoff/PR body, and an operator reading it must see
 * that the gate gave up judging, not that the work is missing.
 */
function unmeasurablePathsReason(paths: string[]): string {
  return `declared path(s) parse to no concrete or glob path (${paths.join(", ")}) — warning, not a cap`;
}

/**
 * The core classification. Pure over (deliverables, diff-file-set) so the
 * smoke test exercises the exact production predicate with no git at all.
 */
export function classifyDeliverables(
  deliverables: ClassifyDeliverableInput[],
  diffFiles: Set<string>,
  workstreamPaths?: WorkstreamPathsMap,
): ConvergeVerdict {
  const results: ConvergeDeliverableResult[] = deliverables.map((d) => {
    // #1155 — the slot is the unit of accounting; the ALTERNATIVE is the unit
    // of matching. Flattening alternatives across slots would turn
    // `[paths: a.ts or b.ts, c.ts]` into three paths that all have to land,
    // which contradicts the decided rule ("a deliverable counts as delivered
    // when ANY alternative matches") and would make an either/or a two-item
    // partial. So: one entry per declared slot, each carrying its alternatives.
    // Deduped by slot text, which keeps the `"(new)"` annotation case
    // byte-identical to before (a slot with no separator is one alternative).
    const slots = deliverablePathAlternatives(d.paths);
    const slotTexts = [...new Set(slots.map((s) => s.raw))];

    // No-diff marker: honoured only when it carries a non-empty evidence
    // string AND the deliverable has no valid code paths (a contradictory
    // marker + paths lets the code paths win — deterministic, documented).
    // The `slotTexts.length === 0` test is the pre-#1155 `paths.length === 0`
    // test and must not move: it is what decides no-diff vs unmeasurable.
    if (
      d.noDiff &&
      d.noDiffEvidence &&
      d.noDiffEvidence.trim().length > 0 &&
      slotTexts.length === 0
    ) {
      return {
        id: d.id,
        status: "no-diff",
        paths: slotTexts,
        present: [],
        missing: [],
        reason: `no diff by design — evidence: ${d.noDiffEvidence.trim()}`,
        noDiffEvidence: d.noDiffEvidence.trim(),
      };
    }

    if (slotTexts.length === 0) {
      return {
        id: d.id,
        status: "unmeasurable",
        paths: slotTexts,
        present: [],
        missing: [],
        reason: "no declared paths (prose deliverable)",
      };
    }
    // #1155 — a deliverable whose slots parse to alternatives but to NO
    // MEASURABLE one (`n/a — repo settings`, a sentence) is the same judgement
    // as no paths at all: the gate has nothing to hold the diff to. It warns
    // (via `convergeEvidence` → handoff/PR body) and never joins `absent`, so
    // it cannot park a cycle. One alternative being measurable is enough —
    // `src/gone.ts or nonsense` still has a concrete path to be held to.
    // #792 (pre-#1155, unchanged): a marker WITHOUT evidence is not honoured,
    // and a slot holding a concrete path classifies by path presence — here
    // `n/a` survives `normaliseDeclaredPath` as a literal string the diff
    // cannot contain, so the deliverable is `absent` and the gate fires. #1155
    // does NOT relax this: the filler-word list is what makes a slot
    // unmeasurable, and a bare `n/a` with no path shape at all is the
    // pathless-marker case, which the `slotTexts.length === 0` branch above
    // already routes to `unmeasurable`. A path-shaped-but-unmeasurable slot
    // (`n/a — repo settings`) is the warning-not-cap case below.
    // #1155 — a deliverable whose slots parse to alternatives but to NO
    // MEASURABLE one (`n/a — repo settings`, a sentence) is the same judgement
    // as no paths at all: the gate has nothing to hold the diff to. It warns
    // (via `convergeEvidence` → handoff/PR body) and never joins `absent`, so
    // it cannot park a cycle — UNLESS a no-diff marker without evidence is
    // attached, which is the #792 contradiction the developer is asserting
    // ("no diff by design") while still declaring a path: that stays `absent`
    // so the gate fires. One measurable alternative is enough to judge —
    // `src/gone.ts or nonsense` still has a concrete path to be held to.
    if (
      declaresNoMeasurablePath(pathShapedSlots(d.paths)) &&
      !(d.noDiff === true && !(d.noDiffEvidence ?? "").trim())
    ) {
      return {
        id: d.id,
        status: "unmeasurable",
        paths: slotTexts,
        present: [],
        missing: [],
        reason: unmeasurablePathsReason(slotTexts),
      };
    }
    // #1155 — a slot that parses only to filler words (`n/a`, `tbd`) is not an
    // ownership claim and the diff cannot be held to it. This supersedes the
    // pre-#1155 `absent` reading for such a slot; a concrete path that is
    // missing from the diff is still `absent` (the control case), which is what
    // the #792 "contradictory marker + real paths" test asserts below.
    //
    // WHY `every`, not `some`: one measurable alternative is enough to judge a
    // deliverable (a real gap must stay a gap), but NO measurable alternative
    // means there is nothing to judge. Requiring every alternative to be
    // measurable would make `src/gone.ts or nonsense` unmeasurable and let a
    // genuine gap escape the gate — the false-negative this clause guards.
    // ANY-alternative semantics: a slot is satisfied when one of its
    // alternatives matches, and the deliverable is `implemented` when EVERY
    // slot is satisfied (each comma-separated slot is a separate piece of
    // declared work). `present`/`missing` name the alternatives that did/did
    // not land, so a partial warning shows exactly which half of an either/or
    // is outstanding.
    // ANY-alternative semantics, over UNITS. A "unit" is one piece of
    // declared work: each comma-separated slot contributes exactly one unit,
    // and a unit is satisfied when ANY of its alternatives matches. Counting
    // units (not alternatives, not slots-with-any-match) is what keeps the two
    // decided rules from contradicting each other:
    //   `[paths: a.ts or b.ts]` with b.ts landed  → 1/1 units → implemented
    //   `[paths: a.ts, b.ts]`      with a.ts landed → 1/2 units → partial
    // An earlier draft counted `slots.length` as the total and "slot matched"
    // as the numerator, which made the second case read 1/1 = implemented and
    // silently passed a half-built deliverable.
    // ANY-alternative semantics, over UNITS. A "unit" is one piece of
    // declared work: each comma-separated slot contributes exactly one unit
    // (its `alternatives` are the either/or inside it), and a unit is satisfied
    // when ANY of its alternatives matches. Counting units — not alternatives,
    // not "slots with any match" against a `slots.length` denominator — is
    // what keeps the two decided rules from contradicting each other:
    //   `[paths: a.ts or b.ts]` with b.ts landed   → 1/1 units → implemented
    //   `[paths: a.ts, b.ts]`     with a.ts landed → 1/2 units → partial
    // An earlier draft used `slots.length` as the total and incremented the
    // numerator for the first matched slot, so the second case read 1/1 and
    // silently passed a half-built deliverable.
    const units = slots;
    const present: string[] = [];
    const missing: string[] = [];
    let satisfied = 0;
    for (const slot of units) {
      let slotMatched = false;
      for (const alt of slot.alternatives) {
        const hit = declaredPathMatches(alt.raw, diffFiles);
        if (hit && !present.includes(alt.raw)) present.push(alt.raw);
        if (!hit && !missing.includes(alt.raw)) missing.push(alt.raw);
        if (hit) slotMatched = true;
      }
      if (slotMatched) satisfied += 1;
    }
    const total = units.length;
    let status: DeliverableStatus;
    let reason: string;
    if (satisfied === total) {
      status = "implemented";
      reason = `all ${total} declared path(s) in the diff`;
    } else if (satisfied === 0) {
      status = "absent";
      reason = `none of ${total} declared path(s) in the diff (${slotTexts.join(", ")})`;
    } else {
      status = "partial";
      reason = `only ${satisfied}/${total} declared path(s) in the diff — missing: ${missing.join(", ")}`;
    }
    // #1137 d2 — attribute the deliverable to the workstream(s) that delivered
    // its paths. A deliverable is `implemented` when ANY workstream's declared
    // paths overlap the deliverable's paths AND those workstream paths are in
    // the consolidated diff. This makes the "sibling-delivered" behavior
    // explicit: the gate does not flag a deliverable just because the
    // "owning" workstream didn't deliver it, as long as a sibling did.
    let deliveredBy: string[] | undefined;
    if (status === "implemented" && workstreamPaths) {
      const ids: string[] = [];
      const slotPaths = slots.map((s) => s.raw);
      for (const [wsId, wsPaths] of Object.entries(workstreamPaths)) {
        const normalised = wsPaths.map(normaliseDeclaredPath).filter((p) => p.length > 0);
        // Both reads use the SAME alternatives grammar as the deliverable side
        // (#1155): a workstream that declared `src/foo or src/bar` must not
        // read as owning nothing because no diff file is literally named
        // `src/foo or src/bar`.
        const overlaps = normalised.some((p) => declaredPathMatches(p, diffFiles));
        const coversDeliverable = slotPaths.some((dp) =>
          declaredPathMatches(dp, EMPTY_DIFF_SET, normalised),
        );
        if (overlaps && coversDeliverable) ids.push(wsId);
      }
      if (ids.length > 0) deliveredBy = ids;
    }
    return deliveredBy
      ? { id: d.id, status, paths: slotTexts, present, missing, reason, deliveredBy }
      : { id: d.id, status, paths: slotTexts, present, missing, reason };
  });
  return {
    diffUnreadable: false,
    deliverables: results,
    absent: results.filter((r) => r.status === "absent"),
    partial: results.filter((r) => r.status === "partial"),
    noDiff: results.filter((r) => r.status === "no-diff"),
    unmeasurable: results.filter((r) => r.status === "unmeasurable"),
  };
}

/** No diff files — the ownership reads compare declarations against declarations. */
const EMPTY_DIFF_SET: ReadonlySet<string> = new Set<string>();

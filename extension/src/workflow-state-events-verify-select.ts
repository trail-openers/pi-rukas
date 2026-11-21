/**
 * /work workflow state — the develop verify's test-selection verdict (#2450).
 *
 * The #1647 selector decides which smoke tests a develop round runs, but its
 * answer was never recorded: every `verify-started` in a state file showed the
 * full command and no operator could tell a selected run from a whole-graph
 * fallback. That is how the selector stayed dead for a month — the gate stayed
 * green while the feature did nothing, because the only evidence it had ever
 * produced was a gate note an operator would have to notice.
 *
 * So the verdict is recorded where the rest of the gate's verdicts are
 * recorded. One event per develop verify that resolved a verify command: the
 * selected run, and every fallback that produced a reason. Nothing is recorded
 * when selection was never attempted (`PI_ENSEMBLE_VERIFY_SELECT=0`, no
 * `.pi/verify-select`, or no `.pi/verify-cmd`) — those paths stay byte-identical
 * to the pre-#1647 develop round, and the absence of this event is what says so.
 *
 * Same fragment pattern as the sibling `workflow-state-events-*.ts` modules: a
 * pure type (types only, no value imports) composed into the closed `WorkEvent`
 * union in `workflow-state-events.ts` by name, so the union stays exhaustive and
 * additive — older readers ignore the kind, and the schema validator knows it.
 *
 * Deliberately NOT folded into `verify-started`: that event's five join fields
 * (`step`, `command`, `target`, `tier`, `retried`) are how its half-pair is
 * matched across a crash, and `NDJSON_STABLE_FIELDS` fixes some of them as a
 * host contract. A selection is a different fact about the same run, and a
 * fallback run has a `command` that is the project's whole suite — so the
 * verdict cannot live inside the pair it describes.
 */

/** What the selector decided for one develop verify. */
export type VerifySelectMode = "selected" | "full";

/**
 * Why a develop verify ran the whole suite instead of a selection. The
 * `docs/troubleshooting.md` entry names these to the operator, so the strings
 * the selector emits and the strings recorded here are the same vocabulary —
 * this is the selector's own `fallbackReason`, passed through, not a second
 * naming of it.
 */
export type VerifySelectEvent = {
  kind: "verify-select";
  at: number;
  /** The step whose develop gate resolved this verdict. Always develop today. */
  step: "develop";
  mode: VerifySelectMode;
  /**
   * The selector's reason, present only on a `full` verdict: `unlexable:<file>`,
   * `outside-graph:<path>`, `no-selected-tests:<path>`, `non-literal-specifier:<file>`,
   * `unresolved-specifier:<file>`, `smoke-test-helper:<path>`, `unsafe-test-name`,
   * `no-changed-files`, or one of the plan-level reasons (`no-pi-verify-cmd`,
   * `no-fast-tier`, `uncomputable-graph:…`, `PI_ENSEMBLE_VERIFY_SELECT=0`).
   */
  fallbackReason?: string;
  /** Tests the import graph selected. Zero on a fallback, which selected none. */
  selected: number;
  /** The always-run set computed for this tree, merged into every selection. */
  alwaysRun: number;
};

/** The arguments the verdict is built from, all four read off one `VerifySelection`. */
export type VerifySelectArgs = {
  mode: VerifySelectMode;
  fallbackReason?: string;
  selected: number;
  alwaysRun: number;
};

/**
 * Build the verdict event from the selector's own answer. A factory rather than a
 * literal at the emit site so `selected` and `alwaysRun` are counts of what the
 * selection actually contained, and so `fallbackReason` stays ABSENT on a
 * `selected` verdict instead of arriving as `undefined`-present — the same reason
 * `makeVerifyRunEvents` exists for the run pair.
 */
export function makeVerifySelectEvent(args: VerifySelectArgs): VerifySelectEvent {
  return {
    kind: "verify-select",
    at: Date.now(),
    step: "develop",
    mode: args.mode,
    ...(args.fallbackReason !== undefined ? { fallbackReason: args.fallbackReason } : {}),
    selected: args.selected,
    alwaysRun: args.alwaysRun,
  };
}

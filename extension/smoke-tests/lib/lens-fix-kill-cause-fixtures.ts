/**
 * #1798 — the shared fixtures for the lens-fix bound-kill cause tests, split
 * out of `test-work-driver-lens-fix-kill-cause.ts` for the AGENTS.md §12
 * 500-line cap.
 *
 * Two files read the same chain (sections 1–2 stay in the parent test,
 * section 3 — the classifier's window rule — lives in
 * `test-work-driver-lens-fix-kill-cause-window.ts`), and the shape they must
 * agree on is the shape of a REAL lens-fix step window: a `step-started`, one
 * `dispatch-started` and its completion event per dispatch, and the
 * `step-failed:lens-fix` cap the router appended. Hand-rolled event literals
 * were how the first draft of this chain got a `kind` wrong that the classifier
 * then preferred over the bound verdict, so every event here is written by a
 * production writer:
 *
 *  - `runSingleDispatch` for the FIRST dispatch of a step: its `step-started`,
 *    `beginDispatch`'s write-ahead `dispatch-started`, and the completion event
 *    `buildCompletionEvent` builds;
 *  - the same two writers for a RE-ENTRY in the same window (one `step-started`,
 *    two failures) so a multi-dispatch window differs from a single-dispatch
 *    one in the absence of a second boundary and in nothing else;
 *  - `dispatchFailCapHit` for the cap, and `failureOf` for the failure the
 *    classifier is handed.
 *
 * The cap carries `step: "lens-fix"` the way #1696 requires: a fixture whose
 * cap-hit omits it silently widens the classifier's window to the whole log.
 *
 * `assert` is injected by each caller rather than imported here, so every file
 * keeps its own pass/fail tally and exit code (the convention of
 * `lib/developer-test-scope.ts`).
 */

import type { DispatchResult } from "../../src/types.ts";
import { LENS_FIX_BOUND_ENV } from "../../src/review-budget.ts";
import { buildCompletionEvent } from "../../src/work-driver-completion-event.ts";
import { runSingleDispatch } from "../../src/work-driver-merged.ts";
import { dispatchFailCapHit } from "../../src/work-driver-provider-park.ts";
import { clearDispatch, markDispatchStarted, mintJobId } from "../../src/work-driver-resume.ts";
import { createEmitSink } from "../../src/work-state-emit.ts";
import {
  initialState,
  type WorkEvent,
  type WorkState,
  appendEvent,
} from "../../src/workflow-state.ts";
import type { CycleContext } from "../../src/work-driver-context.ts";
import { failureOf, type ResultFailure } from "../../src/headless/failure.ts";
import type { HeadlessCap } from "../../src/headless/caps.ts";

export const MIN = 60_000;
export const NOW = 1_700_000_000_000;
export const WALL = 90 * MIN;
export const FIXER_BOUND = 45 * MIN;

/**
 * The kill line `buildCompletionEvent` writes for a fixer killed at its own
 * ceiling. Reproduced (not re-derived) so an assertion can compare against the
 * exact clause the classifier's text fallback matches, without a fixture
 * becoming what defines the wording.
 */
export const boundKillTail = `[pi-rukas] killed after 2700000ms at pi-rukas's own fixer-bound bound of 45m (${LENS_FIX_BOUND_ENV})`;

/** A completed lens-fix round — the neighbour a killed dispatch must not lend
 *  its facts to, and the shape the fix loop writes between attempts. */
export function completedRound(): DispatchResult {
  return {
    ok: true,
    ms: 10 * MIN,
    exitCode: 0,
    finalAssistantText: "fixed three findings",
  } as unknown as DispatchResult;
}

/** The shape a scripted child returns when pi-rukas killed it: `killCause` +
 *  `killBudgetMs` are what make the completion event a kill rather than a
 *  plain non-zero exit. */
export function killed(over: Partial<DispatchResult> = {}): DispatchResult {
  return {
    ok: false,
    ms: FIXER_BOUND,
    exitCode: null,
    finalAssistantText: "",
    killCause: "timeout",
    killBudgetMs: FIXER_BOUND,
    ...over,
  } as unknown as DispatchResult;
}

/** A kill the driver ended for a reason that is NOT a time bound — the
 *  sourceless neighbour the bound verdict must abstain on. */
export function plainKill(): DispatchResult {
  return killed({ killCause: "no-progress", killBudgetMs: undefined, ms: 3 * MIN });
}

/** The cycle context the writers need: a scratch repo root, a no-op emit sink,
 *  and a scripted dispatch. `ctx.dispatchFn` is what `cycleDispatch` prefers,
 *  so nothing here reaches `dispatchCore` or a child process. */
export function lensFixCtx(result: DispatchResult): CycleContext {
  return {
    repoRoot: "/tmp/pi-rukas-1798",
    issue: 1798,
    issues: [1798],
    host: {} as unknown as CycleContext["host"],
    emitSink: createEmitSink(() => undefined),
    dispatchFn: async () => result,
  } as unknown as CycleContext;
}

/** The single-dispatch convenience the classifier canaries use: one lens-fix
 *  dispatch in its own step window, then the cap.
 *
 *  `over` goes on the result the scripted child returns, so a caller varies the
 *  kill cause and the kill clause without touching event literals — and the
 *  clause the caller supplies is what the builder prints verbatim. The builder
 *  owns the clause whenever the result carries no `errorTail` of its own: a
 *  caller pasting a clause in while leaving `fixerBoundSource` unset then gets
 *  the kill line pi-rukas would really have written for that cause, so a
 *  canary's text cannot disagree with its own cause. `source` is what the step
 *  recorded as the clock that armed the bound (the value `runLensFix` hands
 *  down); it fills the field only where the child itself named none. */
export async function lensFixCycle(
  over: Partial<DispatchResult> = {},
  source?: string,
): Promise<WorkState> {
  return lensFixWindow([killed(over)], [source]);
}

/**
 * A lens-fix step window with ONE dispatch per entry of `results`, then the
 * `step-failed:lens-fix` cap.
 *
 * With one entry this is exactly the log `runSingleDispatch` writes plus the
 * cap. With more, entries after the first are RE-ENTRIES of the same step: the
 * same writers (the write-ahead marker, `buildCompletionEvent`, the in-flight
 * clear) without a second `step-started`. One window holding several failures
 * is precisely the case this module's forward scan and `failureOf`'s backward
 * scan disagree on, so the fixture has to be able to write it.
 *
 * `sources[i]` is the clock the step recorded as having armed dispatch `i` (the
 * value `runLensFix` hands down as `fixerBoundSource`); `undefined` means the
 * dispatch carries no arming beyond what its own result said.
 *
 * `legacy[i]` REPLACES dispatch `i`'s kill line with text the current builder
 * would not print for that result. That is the only honest way to write the
 * shapes a state file from before #1798 has — a fixer clause in the tail with
 * no `fixerBoundSource` field on the event, or a clause whose minutes an older
 * builder omitted — because the current builder derives the whole line from the
 * result and refuses to print a fixer clause for a dispatch it did not see
 * armed, and it must keep refusing. A canary that wants an unreadable tail has
 * to write an unreadable tail.
 */
export async function lensFixWindow(
  results: readonly DispatchResult[],
  sources: readonly (string | undefined)[] = [],
  legacy: readonly (string | undefined)[] = [],
): Promise<WorkState> {
  let state = initialState(1798, 1);
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result === undefined) continue;
    state = await dispatchLensFix(state, result, sources[i], i === 0, legacy[i]);
  }
  return appendLensFixCap(state);
}

/** One lens-fix dispatch appended to `state`, by the same writers the step
 *  uses. `fresh` appends the step boundary (a first dispatch); without it the
 *  dispatch joins the window already open. */
async function dispatchLensFix(
  state: WorkState,
  result: DispatchResult,
  fixerBoundSource: string | undefined,
  fresh: boolean,
  legacyTail?: string,
): Promise<WorkState> {
  const ctx = lensFixCtx(result);
  if (fresh) {
    const next = await runSingleDispatch(
      ctx,
      state,
      "lens-fix",
      "developer",
      "lens-fix",
      NOW,
      () => "fix the findings",
      {
        ...(fixerBoundSource === undefined
          ? {}
          : { fixerBoundSource: fixerBoundSource as "fixer-bound" }),
      } as never,
    );
    return legacyTail === undefined ? next : appendLegacyTail(next, legacyTail);
  }
  // A RE-ENTRY: `runSingleDispatch` always opens a step, so this path repeats
  // its two writers by hand — the write-ahead marker (with the jobId it mints,
  // tagged onto the result so the completion event names THIS dispatch) and the
  // completion event — and nothing else. `beginDispatch` is not called because
  // it persists, and these fixtures never touch the filesystem.
  const at = Date.now();
  const jobId = mintJobId("lens-fix", "lens-fix", at);
  (result as { dispatchJobId?: string }).dispatchJobId = jobId;
  const begun = markDispatchStarted(state, "lens-fix", "developer", "lens-fix", jobId, at);
  const event = await buildCompletionEvent(ctx, "lens-fix", "developer", "lens-fix", result);
  const withEvent = appendEvent(clearDispatch(begun, jobId), event);
  return legacyTail === undefined ? withEvent : appendLegacyTail(withEvent, legacyTail);
}

/** Replace the kill line of the LAST `dispatch-failed` of a log. Only for the
 *  pre-#1798 shapes no production writer produces any more — `lensFixWindow`. */
function appendLegacyTail(state: WorkState, tail: string): WorkState {
  const log = [...state.eventLog];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e?.kind !== "dispatch-failed") continue;
    log[i] = { ...e, errorTail: tail } as WorkEvent;
    break;
  }
  return { ...state, eventLog: log };
}

/** Append the cap the HALT branch raises for a non-provider lens-fix failure,
 *  built by the ONE producer so a fixture cannot invent a cap the router never
 *  writes. */
export function appendLensFixCap(state: WorkState): WorkState {
  const tail = state.eventLog[state.eventLog.length - 1];
  const cap = dispatchFailCapHit(
    "lens-fix",
    state,
    tail?.kind === "dispatch-failed" || tail?.kind === "dispatch-failed-provider"
      ? tail
      : undefined,
  );
  return appendEvent(state, cap);
}

/**
 * The failure the driver itself would hand the classifier: `failureOf`'s own
 * projection of the same state, not a hand-rolled `ResultFailure`. A hand-built
 * failure is a second implementation of the read the classifier depends on, and
 * the first draft of this chain got its `kind` wrong — a `kind` the generic
 * entry then preferred over the bound verdict.
 */
export function failFor(state: WorkState): ResultFailure | undefined {
  return failureOf(state, "step-failed:lens-fix" as HeadlessCap, "lens-fix");
}

/** The `dispatch-failed` events of a log, in window order. */
export function failedDispatches(state: WorkState): WorkEvent[] {
  return state.eventLog.filter((e) => e.kind === "dispatch-failed");
}

/** Events by kind (and optional step) — a fixture self-check, so a canary
 *  cannot silently degrade into an empty window. */
export function byKind(state: WorkState, kind: string, step?: string): WorkEvent[] {
  return state.eventLog.filter(
    (e) => e.kind === kind && (step === undefined || (e as { step?: string }).step === step),
  );
}

/**
 * work-develop-unfinished-pass — the develop step's #1768 decision, extracted
 * from `work-develop-topological.ts` so that step handler keeps the size AGENTS.md
 * §12 asks for.
 *
 * Everything between "the independent fan-out settled" and "the dependent phase
 * starts" that concerns a pass which quit mid-step lives here: derive which
 * workstreams the driver could not certify, dispatch their ONE corrective round
 * through the fan-out's own closure (so it inherits the memory brief, the deck
 * row, the run bound, the write fence and — decisively — the classification that
 * judges it), settle the verdicts the round changed, and park the cycle on
 * `develop-incomplete-uncommitted` when the round did not finish either.
 *
 * Two invariants the call site depends on and this module owns:
 *
 *  - It runs AFTER the fan-out's one-shot retry and BEFORE the dependent phase.
 *    The retry's `resetWorktreeToBase` is correct for the failures it handles and
 *    destructive here — the uncommitted files ARE the work the round must finish
 *    — which is why an unfinished verdict also carries `noRetry`. And a dependent
 *    must never be built on a dependency whose work is still uncommitted.
 *  - On the park, the cap-hit is the event-log TAIL and the step short-circuits
 *    exactly as the dirty-leftover and budget parks do: the step router routes on
 *    the tail, so running a gate after the cap would displace it and invite a
 *    second, generic cap for the same failure.
 */

import { type DevelopRunState, makeRunOneWorkstream } from "./work-develop-run.ts";
import type { ClassifyArgs, CrashVerdict } from "./work-develop-crash.ts";
import type { ExecFn } from "./work-develop-git.ts";
import { flushParkedSiblings } from "./work-develop-parked-flush.ts";
import {
  type UnfinishedWorkstream,
  developUnfinished,
  parkOnDevelopUnfinished,
} from "./work-develop-unfinished.ts";
import { runUnfinishedCorrectiveRound } from "./work-develop-unfinished-round.ts";
import type { CycleContext } from "./work-driver-context.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";
import type { WorkstreamVerdict } from "./work-develop-verdict-source.ts";

/** What the step handler needs back: the state to continue from, and whether
 *  the step is over (parked) with the state to hand to `endStep`. */
export interface UnfinishedPassResult {
  state: WorkState;
  /** True when the cycle must NOT proceed: the cap-hit is the log tail and the
   *  caller returns `result` from its handler immediately. */
  parked: boolean;
  /** The state to hand to `endStep` when `parked`. Identical to `state`
   *  otherwise, so the caller never has to reason about the difference. */
  result: WorkState;
  recovered: string[];
  blocked: string[];
}

/**
 * The workstreams the step must run its ONE corrective round for, derived from
 * the unfinished records the classify seam wrote and the step's own worktree and
 * base maps. A workstream with no worktree entry cannot be corrected (there is
 * no tree to resume from) and keeps its failed verdict.
 *
 * `developUnfinished` already keeps only the LATEST record per workstream and
 * clears a workstream a later pass certified, so a finished workstream is never
 * re-dispatched because an earlier attempt quit.
 */
export function unfinishedWorkstreams(
  state: WorkState,
  worktrees: Record<string, string>,
  workstreamBaseShas: Record<string, string>,
  globalBaseSha: string | undefined,
): UnfinishedWorkstream[] {
  const out: UnfinishedWorkstream[] = [];
  for (const r of developUnfinished(state.eventLog)) {
    const cwd = worktrees[r.id];
    if (typeof cwd !== "string") continue;
    out.push({
      id: r.id,
      cwd,
      base: workstreamBaseShas[r.id] ?? globalBaseSha,
      paths: r.paths,
      reason: r.reason,
    });
  }
  return out;
}

/**
 * Run the step's unfinished pass: the round, the verdict settle, and the park.
 *
 * `endStep` is not called here (it belongs to the step handler and owns the
 * step-completed event); the parked state is returned ready for it, with the
 * sibling flush and the persist notes already applied in the order the other
 * develop parks use.
 */
export async function developUnfinishedPass(args: {
  ctx: CycleContext;
  stateRef: { current: WorkState };
  state: WorkState;
  worktrees: Record<string, string>;
  workstreamBaseShas: Record<string, string>;
  globalBaseSha: string | undefined;
  workstreams: DevelopRunState["workstreams"];
  activeIssues: number[];
  scratchAbs: string;
  dispatch: NonNullable<CycleContext["dispatchFn"]>;
  execFn: ExecFn;
  basesFor: (id: string) => string | undefined;
  sharedClassify?: (a: ClassifyArgs) => Promise<CrashVerdict>;
  persister: { emit: (ev: WorkEvent) => void };
  branchEvents: WorkEvent[];
  verdicts: WorkstreamVerdict[];
  ids: string[];
  budgetPark: { at?: number };
  persistNotes: string[];
  /** The step handler's `endStep`, applied to the parked state so the caller
   *  can `return` it directly. */
  finish?: (state: WorkState) => WorkState;
  /** The write-ahead marker to clear on the park (the fan-out's jobId). */
  begunJobId?: string;
}): Promise<UnfinishedPassResult> {
  const noop: UnfinishedPassResult = {
    state: args.state,
    parked: false,
    result: args.state,
    recovered: [],
    blocked: [],
  };
  // A budget park already owns the tail; adding a round would spend a dispatch
  // the budget refused and bury the cap the router must route on.
  if (args.budgetPark.at !== undefined) return noop;
  const unfinished = unfinishedWorkstreams(
    args.state,
    args.worktrees,
    args.workstreamBaseShas,
    args.globalBaseSha,
  );
  if (unfinished.length === 0) return noop;

  const {
    ctx,
    stateRef,
    activeIssues,
    scratchAbs,
    dispatch,
    execFn,
    basesFor,
    sharedClassify,
    persister,
    branchEvents,
    verdicts,
    ids,
    budgetPark,
    workstreams,
  } = args;

  const round = await runUnfinishedCorrectiveRound({
    ctx,
    stateRef,
    unfinished,
    multi: ids.length > 1,
    scopeFor: (id) => workstreams[id]?.scope,
    pathsFor: (id) => workstreams[id]?.paths ?? [],
    runPass: (id, cwd, corrective) => {
      const run = makeRunOneWorkstream({
        ctx,
        activeIssues,
        scratchAbs,
        workstreams,
        emitBranchCompleted: persister.emit,
        ids,
        dispatch,
        execFn,
        baseFor: basesFor,
        // The deck row says what the dispatch is: the same workstream, its
        // corrective round — not a fresh attempt the operator has to infer.
        deckTagFor: (wid) => (ids.length > 1 ? `${wid}:corrective` : "corrective"),
        corrective,
        classifyPass: sharedClassify,
        get verdicts() {
          return verdicts;
        },
        branchEvents,
        stateRef,
        budgetPark,
      });
      return run(id, cwd);
    },
  });

  let state = stateRef.current;
  if (!round.parked) {
    return {
      state,
      parked: false,
      result: state,
      recovered: round.recovered,
      blocked: round.blocked,
    };
  }
  // Sibling / skip-cascade completions first, then the cap: the cap must end up
  // the tail (see the module header). `begunJobId` is the step's write-ahead
  // marker, which the park path must clear like every other park does; the
  // corrective dispatches recorded their own under their own job ids.
  if (args.begunJobId !== undefined) {
    state = flushParkedSiblings(
      state,
      args.begunJobId,
      // `[]`: the corrective closures appended their own `branch-completed`
      // through the persister as they completed, so re-flushing `branchEvents`
      // here would duplicate the round's records.
      [],
      args.worktrees,
      args.workstreamBaseShas,
    );
  }
  const parked = parkOnDevelopUnfinished(state, ctx.issue) ?? state;
  return {
    state: parked,
    parked: true,
    result: parked,
    recovered: round.recovered,
    blocked: round.blocked,
  };
}

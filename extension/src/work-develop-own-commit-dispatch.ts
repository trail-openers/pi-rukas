/**
 * work-develop-unfinished — #1768: the corrective develop pass a workstream
 * gets when its child exited 0 with dirt and no commit of its own, and the
 * count that proves the corrective budget (ONE pass per workstream) held.
 *
 * Apart from `work-develop-run.ts` (at the §12 cap) but not from its rule:
 * `makeRunOneWorkstream` captures the ORIGINAL brief in
 * `DevelopRunState.lastPrompt` and this file dispatches that brief plus the
 * finish-and-commit paragraph, so a corrective round is never thinner than the
 * prompt that just failed — and a pass that never dispatched has no brief,
 * dispatches nobody, and the caller parks. Same workstream, SAME worktree, no
 * reset and no clean: the dirt IS the work. Same dispatch seam, deck header,
 * child bound and write fence as the first pass.
 */
import { developChildBoundMs } from "./spawn-child-bound.ts";
import type { DispatchResult } from "./types.ts";
import { unfinishedPromptSuffix } from "./work-develop-paths.ts";
import type { DevelopRunState } from "./work-develop-run.ts";
import { driverDeckOpts } from "./work-driver-deck-header.ts";

/** What this file needs from the run: the captured brief, the dispatch seam (a
 *  test overrides it through `correctiveDispatch`), and the cycle facts the
 *  dispatch opts carry. A subset of `DevelopRunState` so the dependent phase can
 *  hand it over without owning the whole run state. */
export type CorrectiveRunState = Pick<
  DevelopRunState,
  "lastPrompt" | "dispatch" | "ctx" | "ids" | "scratchAbs"
> & { correctiveDispatch?: DevelopRunState["dispatch"] };

/** How many CORRECTIVE develop passes the last step dispatched. A module-level
 *  holder because the corrective seam is installed on the cycle ctx, which a
 *  test builds before it can supply its own scripted child — so the seam counts
 *  at CALL time and the total is complete whenever the test reads it. The
 *  own-commit smoke test asserts the corrective budget through it; production
 *  never reads it. */
export const correctivePassCount: { n: number } = { n: 0 };

/** The corrective dispatch, labelled so the console and the deck say WHICH of
 *  the two passes a `developer done` line belongs to. `undefined` = no captured
 *  brief, so nobody was dispatched and the caller parks. Every dispatch through
 *  here is counted: the corrective budget is ONE pass per workstream, and the
 *  own-commit smoke test asserts it through `correctivePassCount`. */
export const correctiveFor = (s: CorrectiveRunState, id: string, cwd: string, paths: string[]) => {
  const prompt = s.lastPrompt?.(paths);
  if (prompt === undefined) return Promise.resolve(undefined);
  const label = s.ids.length > 1 ? `developer[${id}:unfinished]` : "developer[unfinished]";
  return s.dispatch(
    s.ctx.host,
    { role: "developer", prompt, cwd },
    {
      label,
      childBoundMs: developChildBoundMs(),
      deck: {
        ...driverDeckOpts(s.ctx.issue, "develop", s.ids.length > 1 ? id : "default"),
        label,
      },
      // The child writes only inside its own worktree, as the first pass did.
      writeFence: { root: cwd, repo: s.ctx.repoRoot, scratch: s.scratchAbs },
    },
  );
};

/** The corrective pass for one workstream, bound to the step's own dispatch
 *  seam and the test seam `ctx.correctiveDispatchFn`.
 *
 *  Both seams are resolved at CALL time, not at step start: the cycle ctx is
 *  built before a test installs its scripted child, and production leaves the
 *  test seam absent, so a corrective pass runs on exactly the seam the first
 *  pass used — same child bound, deck header and write fence. */
export const correctivePassFor = (
  s: CorrectiveRunState,
  dispatch: NonNullable<DevelopRunState["dispatch"]>,
  // Read when the pass RUNS, not when the step started: the cycle ctx is built
  // before a test installs its scripted child, so the seam is resolved late.
  ctx?: { correctiveDispatchFn?: DevelopRunState["dispatch"] },
) => {
  // `s.dispatch` first: the caller's run state carries the seam the first pass
  // used (deck header, child bound, write fence all come from the run), and a
  // test seam overrides it for the corrective pass alone.
  const seam = (): NonNullable<DevelopRunState["dispatch"]> =>
    ctx?.correctiveDispatchFn ?? s.dispatch ?? dispatch;
  // THE ONE place a corrective pass is counted: every corrective dispatch of a
  // develop step goes through this closure, so the count is the step's
  // corrective budget (ONE per workstream) and not a per-callsite side effect
  // that breaks when a second caller appears. `lastPrompt` is read at CALL
  // time, because the dispatch closure writes it as each pass runs.
  return (id: string, cwd: string, paths: string[]) => {
    if (s.lastPrompt?.(paths) === undefined) return Promise.resolve(undefined);
    correctivePassCount.n++;
    return correctiveFor({ ...s, dispatch: seam() }, id, cwd, paths);
  };
};

export { unfinishedPromptSuffix };

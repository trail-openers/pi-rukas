/**
 * work-develop-own-commit-dispatch — #1768: the corrective develop pass a
 * workstream gets when its child exited 0 with dirt and no commit of its own.
 *
 * Lives apart from work-develop-run.ts (at the §12 500-line cap) but not from
 * its rule: `makeRunOneWorkstream` captures the workstream's ORIGINAL brief in
 * `DevelopRunState.lastPrompt` and this file dispatches that brief plus the
 * finish-and-commit paragraph — a corrective round is never built from a
 * thinner prompt than the one that just failed, and a pass that never
 * dispatched has no brief, so it dispatches nobody and the caller parks.
 * Same workstream, SAME worktree, no reset and no clean: the dirt IS the work.
 * Same dispatch seam, deck header, child bound and write fence as the first pass.
 */
import { developChildBoundMs } from "./spawn-child-bound.ts";
import type { DispatchResult } from "./types.ts";
import { unfinishedPromptSuffix } from "./work-develop-paths.ts";
import type { DevelopRunState } from "./work-develop-run.ts";
import { driverDeckOpts } from "./work-driver-deck-header.ts";

/** What this file needs from the run: the captured brief, the dispatch seam
 *  (overridable by a test through `correctiveDispatch`), and the cycle facts the
 *  dispatch opts carry. A subset of `DevelopRunState` so the dependent phase can
 *  hand it over without owning the whole run state. */
export type CorrectiveRunState = Pick<
  DevelopRunState,
  "lastPrompt" | "dispatch" | "ctx" | "ids" | "scratchAbs"
> & { correctiveDispatch?: DevelopRunState["dispatch"] };

/** The corrective dispatch. Distinct deck label from the first pass, so the
 *  console says WHICH of the two passes a `developer done` line belongs to.
 *  `undefined` = no captured brief, so nobody was dispatched; the caller parks. */
export async function dispatchUnfinishedCorrective(
  s: CorrectiveRunState,
  id: string,
  cwd: string,
  paths: string[],
): Promise<DispatchResult | undefined> {
  const prompt = s.lastPrompt?.(paths);
  if (prompt === undefined) return undefined;
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
}

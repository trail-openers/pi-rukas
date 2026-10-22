/**
 * work-develop-unfinished-round — #1768: the ONE corrective round a develop
 * pass that quit mid-step earns, and the park when that round fails too.
 *
 * The rule this serves: a child that exited 0, reported itself done, made no
 * commit of its own ahead of base and left its work in the tree is NOT done
 * (orchard cycle-id / cycle-id: `safety net committed default
 * (d81ce007) — 6 file(s)` printed beside the child's own `… docs section +
 * test/review_test.sh remain, then the gate. Continuing.`, then `agent done:
 * developer`). PM's routing decision was ONE corrective round that RESUMES
 * FROM THE DISK STATE, and resuming from the disk state is the whole point of
 * the round — the child's uncommitted files ARE the work in progress:
 *
 *  - No `resetWorktreeToBase`, no `git clean`, no patch-then-discard. The
 *    #1016 fan-out retry saves a failed pass's partial work and then destroys
 *    it before re-dispatching; doing that here would destroy the very work the
 *    round exists to finish, and nothing would re-apply the patch. The
 *    corrective dispatch runs against the tree exactly as the quitting child
 *    left it, and the prompt says so in the same breath as it names the paths.
 *  - The classification is the SAME seam the first pass used
 *    (`classifyDevelopPass`, via the fan-out's `runOneWorkstream`), so the
 *    round's verdict comes from the tree and not from the corrective child's
 *    own claim. A second `agent done: developer` over a dirty tree is therefore
 *    observable instead of another green.
 *  - The round is bounded to ONE. A second unfinished pass parks on
 *    `develop-incomplete-uncommitted` naming the paths in `evidence`, because a
 *    mid-step quit must never reach the verify gate as a completed step —
 *    pre-fix it did, and surfaced two hours later as `verify-failed:develop`
 *    naming no assertion (orchard #507).
 */

import { trace } from "./trace.ts";
import {
  type UnfinishedWorkstream,
  developUnfinished,
  unfinishedCorrectivePrompt,
} from "./work-develop-unfinished.ts";
import type { CycleContext } from "./work-driver-context.ts";
import type { WorkState } from "./workflow-state.ts";

/** What the round decided, for the caller to route on. */
export interface UnfinishedRoundOutcome {
  /** True when the cycle must NOT proceed to the verify gate: the cap-hit is
   *  the event-log tail and the caller short-circuits exactly as the
   *  dirty-leftover and budget parks do. */
  parked: boolean;
  state: WorkState;
  /** Workstreams whose corrective pass committed its own work — green again. */
  recovered: string[];
  /** Workstreams still unfinished; named in the cap's evidence. */
  blocked: string[];
}

/**
 * Run the ONE corrective round for the unfinished workstreams, then park or
 * hand the caller back a settled state.
 *
 * `runPass` is the fan-out's own dispatch closure, so the corrective dispatch
 * inherits the memory brief, the verify-command grounding, the deck row, the
 * child run bound, the write fence, and — decisively — the classification that
 * judges it. The caller re-reads the verdicts from the event log afterwards:
 * one event is one finding, and the park and the record cannot disagree.
 */
export async function runUnfinishedCorrectiveRound(args: {
  ctx: CycleContext;
  /** The live state holder. The round reads its records back AFTER the
   *  dispatches from here, not from a snapshot taken before the round: the
   *  fan-out closures append the round's own `branch-completed` through this
   *  ref, so a snapshot would still show the quitting pass and park work that
   *  the round actually finished. */
  stateRef: { current: WorkState };
  unfinished: UnfinishedWorkstream[];
  /** The fan-out's per-workstream dispatch closure, invoked with the round's
   *  prompt and label (both absent on every ordinary pass). */
  runPass: (
    id: string,
    cwd: string,
    corrective: { prompt: string; label: string },
  ) => Promise<unknown>;
  /** Set for an N>1 cycle (the prompt's parallel framing). */
  multi: boolean;
  /** The workstream's scope, for the prompt. */
  scopeFor: (id: string) => string | undefined;
  /** The workstream's declared paths, for the prompt. */
  pathsFor: (id: string) => string[];
}): Promise<UnfinishedRoundOutcome> {
  const { ctx, multi, runPass, stateRef } = args;
  const recovered: string[] = [];
  const blocked: string[] = [];

  for (const u of args.unfinished) {
    // The console says what is happening while the driver still knows which
    // workstream quit: a corrective round that resumed from the child's own
    // uncommitted work, with no reset. Pre-fix the only line here was
    // `safety net firing`, and the pass was already being called done.
    trace(
      `work-driver: develop-incomplete-uncommitted — one corrective round for ${u.id}, resuming from its uncommitted work (${u.paths.length} path(s)); the worktree is NOT reset`,
    );
    const prompt = unfinishedCorrectivePrompt({
      issue: ctx.issue,
      workstreamId: u.id,
      parallel: multi,
      scope: args.scopeFor(u.id),
      paths: args.pathsFor(u.id),
      uncommitted: u.paths,
    });
    try {
      await runPass(u.id, u.cwd, { prompt, label: `developer[${u.id}] (unfinished-corrective)` });
    } catch (err) {
      // The closure records its own dispatch-failed event; the tree decides
      // below, so a throw here needs no second verdict of its own.
      trace(
        `work-driver: unfinished corrective dispatch for ${u.id} threw: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
      );
    }
  }

  // One round; the tree has the last word. A workstream whose LATEST
  // `branch-completed` still carries an `unfinished` fragment did not finish,
  // and is the park's evidence. Read from the LIVE state the closures write
  // through, and take the latest record per workstream: a corrective pass that
  // committed its own work replaces the quitting pass's record.
  const still = new Map<string, true>();
  for (const r of developUnfinished(stateRef.current.eventLog)) still.set(r.id, true);
  for (const u of args.unfinished) {
    if (still.has(u.id)) blocked.push(u.id);
    else recovered.push(u.id);
  }
  if (blocked.length === 0) return { parked: false, state: stateRef.current, recovered, blocked };
  return { parked: true, state: stateRef.current, recovered, blocked };
}

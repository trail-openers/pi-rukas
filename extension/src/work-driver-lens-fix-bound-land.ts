/**
 * work-driver-lens-fix-bound-land — a lens-fix killed AT its own bound is not
 * a failed step when it already committed: the failure event becomes a
 * completed one and the step routes as a completed fix.
 *
 * The field shape (seen on two field cycles, v0.14.5+): the #1742 review budget arms
 * every fixer with a bound (`PI_ENSEMBLE_LENS_FIX_BOUND_MS`, 45 min default,
 * shortened by what the loop budget leaves). When a fixer that had already
 * committed in the lens worktree ran to that bound, the kill produced
 * `dispatch-failed` with `killCause: timeout` (or `child-bound`). `lens-fix` is
 * a HALT step and a bound kill is not retryable, so the router synthesised a
 * cap-hit and `integrateLensFix` — which runs only from the adversarial step
 * after a lens-fix COMPLETED — never ran. The commits sat in the worktree; on
 * the next round (or a re-run) `repositionLensFixWorktree` found a tree holding
 * commits the branch did not, backed it up and parked `lens-fix-reposition`
 * (`unlanded` / `diverged`). The work was stranded in a backup ref.
 *
 *  The conversion: when the dispatch's tail is a `dispatch-failed` for
 *  `lens-fix` carrying a bound kill cause (`isFixerBoundKill` — exactly
 *  `timeout` and `child-bound`) AND the worktree holds commits the fixer made on
 *  top of the tip this round started from, the failure event is REPLACED by a
 *  `dispatch-completed` carrying `partialAfterKill`. Nothing else is touched: no
 *  `adversarial-approved` is appended, `lastCompletedStep` is not rewritten (the
 *  router sets it from the step it just ran), and the step lands nothing — the
 *  linear table sends `lens-fix` to `adversarial`, where the gate reviews the
 *  diff and `integrateLensFix` lands it through the ordinary gate. The gate
 *  stays in the path: nothing this conversion produces pushes unreviewed work.
 *
 * Why the tip is snapshotted at the dispatch boundary and compared after: the
 * worktree's HEAD at dispatch time IS the round's starting tip (the reposition
 * gate verified it) and the fixer is the tree's only writer. Counting against a
 * branch ref is what the reposition gate must do, and it is the measurement that
 * mis-classified this tree as "unlanded" before.
 *
 * A killed fixer with NO commits is left exactly as it is today — the tail
 * stays `dispatch-failed` and the step HALTs. Deleting a failure that produced
 * nothing would advance a cycle on nothing.
 *
 * Disclosure is not silent: one `plumbReports` entry names the kill cause and
 * the commit SHAs, so the handoff describes a converted partial fix rather than
 * a clean completion.
 *
 * Escape hatch: `PI_ENSEMBLE_LENS_FIX_LAND_AHEAD=0` — the same knob that turns
 * off the reposition gate's strictly-ahead landing — restores the HALT here too,
 * so one switch returns both halves of this fix to `step-failed:lens-fix` →
 * handoff.
 */

import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import { lensFixLandAheadEnabled } from "./work-driver-lens-fix-reposition-land.ts";
import { clearDispatch } from "./work-driver-resume.ts";
import { withUsage } from "./workflow-state-events-usage.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

/** Is this kill cause one a fixer's own bound produces (see
 *  `isFixerBoundKill` in this module)? Lives beside the conversion
 *  so the fix-loop callers cannot disagree about "killed at its bound". */
export function isFixerBoundKill(killCause: string | undefined): boolean {
  return killCause !== undefined && (killCause === "timeout" || killCause === "child-bound");
}

/** The worktree's HEAD, or undefined when git could not answer. Exported for the
 *  lens-fix step, which snapshots the round's starting tip before dispatch. */
export async function readTreeHead(execFn: ExecFn, tree: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFn("git rev-parse HEAD", { cwd: tree, maxBuffer: 64 * 1024 });
    const sha = stdout.trim();
    return sha.length >= 7 ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** The commits `head` holds beyond `tip` (oldest first). Empty when there are
 *  none or the range could not be read — both mean "do not convert". */
async function commitsAheadOfTip(
  execFn: ExecFn,
  tree: string,
  tip: string,
  head: string,
): Promise<string[]> {
  try {
    const { stdout } = await execFn(`git rev-list --reverse ${tip}..${head}`, {
      cwd: tree,
      maxBuffer: 256 * 1024,
    });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** What the classifier needs from the caller beyond the state: the tree the
 *  fixer worked in and the HEAD it started from, snapshotted before dispatch. */
export type LensFixBoundLandProbe = {
  tree: string;
  tipSha: string | undefined;
};

/**
 * Convert a bound-killed lens-fix into a completed one. Returns the state the
 * step ends on — the converted state when the kill produced commits, and the
 * state handed in (tail still `dispatch-failed`) for every case that must keep
 * today's HALT. The caller returns the result verbatim and never calls the
 * router itself, so the converted tail is what the router reads.
 */
export async function landLensFixAfterBoundKill(
  state: WorkState,
  probe: LensFixBoundLandProbe,
  execFn: ExecFn = execp,
): Promise<WorkState> {
  const tail = state.eventLog[state.eventLog.length - 1];
  if (tail?.kind !== "dispatch-failed" || tail.step !== "lens-fix") return state;
  const killCause = tail.killCause;
  // Narrowed here so the disclosure below carries a cause, never `undefined`:
  // `isFixerBoundKill` already refused the absent case.
  if (!isFixerBoundKill(killCause) || killCause === undefined) return state;
  // ONE knob for both halves of #1779: the same flag that turns off the
  // reposition gate's strictly-ahead landing turns this conversion off, so an
  // operator gets today's `step-failed:lens-fix` → handoff from a single export.
  if (!lensFixLandAheadEnabled()) {
    trace(
      `work-driver: lens-fix killed at ${killCause} at its bound — the partial-fix conversion is disabled by PI_ENSEMBLE_LENS_FIX_LAND_AHEAD=0, halting`,
    );
    return state;
  }
  if (probe.tipSha === undefined) {
    trace("work-driver: lens-fix killed at its bound with no recorded round tip — halting");
    return state;
  }
  const head = await readTreeHead(execFn, probe.tree);
  if (head === undefined || head === probe.tipSha) {
    trace("work-driver: lens-fix killed at its bound with no commits — halting as before");
    return state;
  }
  const ahead = await commitsAheadOfTip(execFn, probe.tree, probe.tipSha, head);
  if (ahead.length === 0) {
    trace("work-driver: lens-fix killed at its bound — no commits ahead of the round tip, halting");
    return state;
  }
  const summary = `lens-fix killed at its bound after committing ${ahead.length} commit(s); treated as a partial fix`;
  // One kill line, at the point of decision: the cause git-verified commits
  // exist, and where the work goes next. The bound itself was already traced,
  // once, when it was resolved (`reviewFixDispatchBoundMs`).
  trace(
    `work-driver: lens-fix killed at its bound (killCause=${killCause}) with ${ahead.length} commit(s) — ${summary}; routing to the adversarial gate (${ahead.join(", ")})`,
  );
  const converted: WorkEvent = withUsage(
    {
      kind: "dispatch-completed" as const,
      step: tail.step,
      role: tail.role,
      jobId: tail.jobId,
      label: tail.label,
      ok: true,
      ms: tail.ms,
      at: tail.at,
      summary,
      // The disclosure field: a reader of the event log can tell this dispatch
      // was converted from a kill, without parsing prose out of `summary`.
      partialAfterKill: { killCause, commitShas: ahead, at: tail.at },
    },
    tail.usage,
  );
  // The failure event is REPLACED, not followed: `routeStepOutcome` and
  // `failureEventOf` read the tail, and a `dispatch-failed` that survives
  // behind the completion is still the event the HALT policy routes on.
  //
  // The dispatch's write-ahead marker is cleared with it: `beginDispatch`
  // recorded the job as in flight when the dispatch started, and
  // `clearDispatch` normally runs on the path that builds the completion event.
  // Leaving the id behind would make the next resume read a clean boundary as a
  // crashed dispatch and re-run a step that has already moved on.
  const landed = appendEvent(
    clearDispatch({ ...state, eventLog: state.eventLog.slice(0, -1) }, tail.jobId),
    converted,
  );
  // (b) Disclosure. `plumbReports` is the field the handoff body renders (and
  // the comment-evidence dedupe reads), so the conversion is stated to the
  // operator with the kill cause and the SHAs, and it is deliberately NOT in
  // the event log: appending after the completion would move the tail the
  // router reads.
  const body = `lens-fix: the fixer was killed at its bound (killCause=${killCause}) after committing ${ahead.length} commit(s): ${ahead.join(", ")}. The failure was converted to a completed dispatch so the adversarial gate reviews the commits and integration lands them.`;
  return {
    ...landed,
    pipelineState: {
      ...landed.pipelineState,
      plumbReports: [
        ...(landed.pipelineState.plumbReports ?? []),
        { step: "lens-fix", role: "driver", body, at: tail.at },
      ],
    },
  };
}

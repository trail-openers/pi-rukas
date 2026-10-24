/**
 * work-driver-lens-fix-bound-land — a lens-fix killed AT its own bound is not
 * a failed step when it already committed: the failure keeps its record and a
 * completed one is appended, and the lens worktree is moved onto the landed
 * commit so the next round's gate sees a tree at the tip.
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
 *  `timeout` and `child-bound`) that belongs to THIS round's dispatch (its
 *  `jobId` is the one `beginDispatch` minted for the fixer) and that the fixer's
 *  own bound produced (not the caller's cycle deadline), AND the worktree holds
 *  commits the fixer made on top of the tip this round started from, a
 *  `dispatch-completed` carrying `partialAfterKill` is APPENDED after the
 *  failure event. The failure is NOT deleted: it is the record that a child was
 *  killed, with its exit code and the error tail that says which bound fired,
 *  and a reader of the log has to be able to see both halves of what happened.
 *  Nothing else is touched: no `adversarial-approved` is appended,
 *  `lastCompletedStep` is not rewritten (the router sets it from the step it
 *  just ran), and the step lands nothing — the linear table sends `lens-fix` to
 *  `adversarial`, where the gate reviews the diff and `integrateLensFix` lands
 *  it through the ordinary gate. The gate stays in the path: nothing this
 *  conversion produces pushes unreviewed work.
 *
 * Why the tail is the LAST event and a retained failure does not route: the
 * router reads `failureEventOf`, which answers from the final event alone for a
 * single-dispatch step (a fan-out's failure it finds behind
 * `branches-converged`), so a trailing `dispatch-completed` is the event the
 * step routes on and the failure behind it is evidence, not a verdict. The
 * resume classifier reads `inFlightJobIds`, not the tail, and the conversion
 * clears the id with `clearDispatch` exactly as the ordinary completion path
 * does — so a converted kill resumes as a completed step, not a crashed one.
 *
 * Why the tip is snapshotted at the dispatch boundary and compared after: the
 * worktree's HEAD at dispatch time IS the round's starting tip (the reposition
 * gate verified it) and the fixer is the tree's only writer. Counting against a
 * branch ref is what the reposition gate must do, and it is the measurement that
 * mis-classified this tree as "unlanded" before.
 *
 * A killed fixer with NO commits is left exactly as it is today — the tail
 * stays `dispatch-failed` and the step HALTs. Deleting a failure that produced
 * nothing would advance a cycle on nothing. The jobId requirement is the same
 * discipline applied to the tail itself: a `dispatch-failed` left at the end of
 * the log by some earlier dispatch is not this round's kill, and converting it
 * would delete a failure this fixer never caused.
 *
 * A kill the CALLER's clock produced never converts either
 * (`killedAtCycleDeadline`, #1593): when the cycle itself is out of time,
 * advancing to the next step is the one thing that bound forbids — the tail
 * parks and the handoff says so.
 *
 * Disclosure is not silent: one `plumbReports` entry names the kill cause and
 * the commit SHAs, so the handoff describes a converted partial fix rather than
 * a clean completion.
 *
 * The ROOT FIX — moving the tree. A converted kill leaves the fixer's commits
 * in the lens worktree, and the NEXT round's reposition gate reads that tree:
 * a tree still holding commits the branch lacks is `unlanded` and parks. So
 * when the conversion succeeds, the tree is moved onto the landed commit
 * (detached) the way `integrate()` resets the worktrees it applied and the
 * gate's own patch-equivalence path detaches. That is a bounded git call in the
 * tree itself — never the main checkout, which this module does not touch at
 * all. A move that fails is traced and NON-FATAL: the work is already on the
 * branch, and the next round's existing reposition logic handles a tree that
 * did not move exactly as it did before this change.
 *
 * Escape hatch: `PI_ENSEMBLE_LENS_FIX_LAND_AHEAD=0` turns this conversion off,
 * restoring `step-failed:lens-fix` → handoff for a bound kill that committed.
 */

import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { clearDispatch } from "./work-driver-resume.ts";
import { withUsage } from "./workflow-state-events-usage.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

/** The kill causes a fixer's OWN bound produces — the whole vocabulary in one
 *  place, so a reader can see that every other cause parks. Derived from the
 *  spawn's union so a new cause is a decision here, not a silent default. */
export const FIXER_BOUND_KILL_CAUSES = ["timeout", "child-bound"] as const;

/** One of those two causes. */
export type FixerBoundKillCause = (typeof FIXER_BOUND_KILL_CAUSES)[number];

/** Is this kill cause one a fixer's own bound produces? Type-guard form, so a
 *  caller that passes the guard gets the narrowed type as well as the verdict.
 *  Lives beside the conversion so the fix-loop callers cannot disagree about
 *  "killed at its bound", and refuses the absent case by construction — an
 *  unstructured failure is not a bound kill. */
export function isFixerBoundKill(
  killCause: DispatchResult["killCause"],
): killCause is FixerBoundKillCause {
  return (FIXER_BOUND_KILL_CAUSES as readonly string[]).includes(killCause ?? "");
}

/** Escape hatch for the conversion. Read per call so tests can flip it. */
export function lensFixLandAheadEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LENS_FIX_LAND_AHEAD !== "0";
}

/** A git object name, in the shape git itself prints. Anything else (a
 *  truncated capture, a multi-line error, a caller-supplied string) is refused
 *  rather than interpolated into a revision range. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

function isSha(candidate: string): boolean {
  return SHA_RE.test(candidate);
}

/** The worktree's HEAD, or undefined when git could not answer OR answered
 *  with something that is not a commit id. Exported for the lens-fix step,
 *  which snapshots the round's starting tip before dispatch.
 *
 *  A single line matching the SHA shape, strictly: `git rev-parse` prints one
 *  line on success, so anything else means the read did not do what it is
 *  supposed to and the caller must treat the tree as unreadable rather than
 *  carry a bogus id into a `tip..head` range. */
export async function readTreeHead(execFn: ExecFn, tree: string): Promise<string | undefined> {
  const lines = await gitRead(execFn, tree, ["rev-parse", "HEAD"]);
  if (lines === undefined) return undefined;
  if (lines.length !== 1) {
    trace(
      `work-driver: lens-fix — unexpected ${lines.length}-line answer for the tree HEAD — treating it as unreadable`,
    );
    return undefined;
  }
  const sha = lines[0];
  if (sha === undefined || !isSha(sha)) {
    trace(
      `work-driver: lens-fix — the tree HEAD is not a commit id (${(sha ?? "").slice(0, 40)}) — treating the tree head as unreadable`,
    );
    return undefined;
  }
  return sha;
}

/** One git read in the argv form, split into non-empty lines. `undefined` when
 *  git could not answer — distinct from the empty array git prints for a range
 *  with no commits, because "no commits" and "no answer" lead to different
 *  decisions and used to share one `[]`. */
async function gitRead(execFn: ExecFn, cwd: string, argv: string[]): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFn("git", { cwd, maxBuffer: 256 * 1024, argv });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    trace(
      `work-driver: lens-fix — could not read ${argv[0]} ${argv.slice(1).join(" ")}: ${(e as Error).message?.slice(0, 160) ?? "unknown error"}`,
    );
    return undefined;
  }
}

/** The commits `head` holds beyond `tip` (oldest first). `undefined` when git
 *  could not read the range; `[]` when the range genuinely has no commits.
 *  Both SHAs are validated before they reach the revision range. */
async function commitsAheadOfTip(
  execFn: ExecFn,
  tree: string,
  tip: string,
  head: string,
): Promise<string[] | undefined> {
  if (!isSha(tip) || !isSha(head)) {
    trace(
      `work-driver: lens-fix — refusing to read a commit range from malformed SHAs (tip ${tip.slice(0, 12)}, head ${head.slice(0, 12)})`,
    );
    return undefined;
  }
  return gitRead(execFn, tree, ["rev-list", "--reverse", `${tip}..${head}`]);
}

/** What the classifier needs from the caller beyond the state: the tree the
 *  fixer worked in, the HEAD it started from (snapshotted before dispatch), and
 *  the jobId `beginDispatch` minted for THIS round's fixer dispatch. */
export type LensFixBoundLandProbe = {
  tree: string;
  tipSha: string | undefined;
  /** The id of the lens-fix dispatch whose kill this conversion may consider.
   *  The tail must carry it, or the tail is somebody else's failure. */
  jobId: string;
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
  // #1789 (1) — THE TAIL MUST BE THIS ROUND'S DISPATCH. `runLensFix` mints the
  // jobId with `beginDispatch` before awaiting the fixer and hands it in; a tail
  // carrying any other id is a failure event some earlier dispatch left behind,
  // and converting it would delete a failure this fixer did not cause.
  if (tail.jobId !== probe.jobId) {
    trace(
      `work-driver: lens-fix bound-kill conversion refused — the dispatch-failed tail belongs to job ${tail.jobId}, not this round's ${probe.jobId} — halting`,
    );
    return state;
  }
  const killCause = tail.killCause;
  // Narrowed by the type guard, so the disclosure below carries a cause and
  // never `undefined`.
  if (!isFixerBoundKill(killCause)) return state;
  // #1789 (2) — a "timeout" the CALLER's cycle deadline armed is not the
  // fixer's own bound (#1593 stamps `killedAtCycleDeadline`): the cycle itself
  // is out of time, so the one answer that must not happen is advancing to the
  // next step. The tail stays and the cycle parks.
  if (tail.killedAtCycleDeadline === true) {
    trace(
      `work-driver: lens-fix killed at the caller's cycle deadline (killCause=${killCause}) — converting would advance a cycle that is out of time, halting`,
    );
    return state;
  }
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
  if (ahead === undefined) {
    // Git could not answer, which is not the same fact as "the tree holds
    // nothing". Converting on an unreadable range would advance a cycle on a
    // measurement nobody took; halting on it keeps the honest failure.
    trace(
      `work-driver: lens-fix killed at its bound — the commit range ${probe.tipSha.slice(0, 12)}..${head.slice(0, 12)} could not be read, halting`,
    );
    return state;
  }
  if (ahead.length === 0) {
    trace("work-driver: lens-fix killed at its bound — no commits ahead of the round tip, halting");
    return state;
  }
  const summary = `lens-fix killed at its bound (${killCause}) after committing ${ahead.length} commit(s); treated as a partial fix`;
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
      // was converted from a kill, without parsing prose out of `summary`. The
      // kill's own evidence rides here too — the exit code and the tail of the
      // error text say WHICH bound fired, so converting the verdict does not
      // erase the diagnosis.
      partialAfterKill: {
        killCause,
        commitShas: ahead,
        at: tail.at,
        ...(tail.exitCode === null || tail.exitCode === undefined
          ? {}
          : { exitCode: tail.exitCode }),
        ...(tail.errorTail ? { errorTail: tail.errorTail.slice(0, 200) } : {}),
      },
    },
    tail.usage,
  );
  // THE FAILURE IS KEPT, AND THE COMPLETION FOLLOWS IT. Deleting the
  // `dispatch-failed` would destroy the only record that a child was killed —
  // its exit code, the error tail naming the bound, and the fact a human
  // auditing the cycle can still see. What the router reads is the TAIL
  // (`failureEventOf` answers from the final event for a single-dispatch step),
  // so appending the completion after the failure is what routes the step as a
  // completed fix while both events stay in the log.
  //
  // The dispatch's write-ahead marker is cleared with the completion:
  // `beginDispatch` recorded the job as in flight when the dispatch started, and
  // `clearDispatch` normally runs on the path that builds the completion event.
  // Leaving the id behind would make the next resume read a clean boundary as a
  // crashed dispatch and re-run a step that has already moved on.
  const landed = appendEvent(clearDispatch(state, tail.jobId), converted);
  // (b) Disclosure. `plumbReports` is the field the handoff body renders (and
  // the comment-evidence dedupe reads), so the conversion is stated to the
  // operator with the kill cause and the SHAs, and it is deliberately NOT in
  // the event log: appending after the completion would move the tail the
  // router reads. `role: "driver"` is the discriminator that keeps this a
  // DISCLOSURE and never a question: `plumbQuestion`/`freshPlumbQuestion` skip
  // every driver report, so a driver's own note cannot come back as the
  // developer's `developer question (untrusted text)` line.
  const body = `lens-fix: the fixer was killed at its bound (killCause=${killCause}) after committing ${ahead.length} commit(s): ${ahead.join(", ")}. The failure was converted to a completed dispatch so the adversarial gate reviews the commits and integration lands them.`;
  const disclosed: WorkState = {
    ...landed,
    pipelineState: {
      ...landed.pipelineState,
      plumbReports: [
        ...(landed.pipelineState.plumbReports ?? []),
        { step: "lens-fix", role: "driver", body, at: tail.at },
      ],
    },
  };
  // The tree moves onto what the branch now carries, so the NEXT round's
  // reposition gate sees `already-at-tip` instead of a tree holding commits the
  // branch lacks (which parks). Detached, bounded, argv-form, and inside the
  // lens tree only.
  await moveTreeToTip(execFn, probe.tree, head);
  return disclosed;
}

/** Move the (detached) tree onto `tipSha` so the next dispatch builds on what
 *  the branch carries. A failed move is NOT fatal — the work is on the branch,
 *  and the next round's reposition gate handles a tree that did not move
 *  exactly as it did before this conversion existed — but it is traced. */
async function moveTreeToTip(execFn: ExecFn, tree: string, tipSha: string): Promise<void> {
  if (!isSha(tipSha)) {
    trace(
      `lens-fix-reposition: the tree was not moved — ${tipSha.slice(0, 12)} is not a commit id`,
    );
    return;
  }
  try {
    await execFn("git", {
      cwd: tree,
      maxBuffer: 64 * 1024,
      argv: ["checkout", "--detach", "--quiet", tipSha],
    });
    trace(
      `lens-fix-reposition: lens worktree moved to ${tipSha.slice(0, 12)} — the next reposition sees already-at-tip`,
    );
  } catch (e) {
    trace(
      `lens-fix-reposition: the worktree could not follow the tip (${(e as Error).message?.slice(0, 160) ?? "unknown error"}) — the next round's reposition gate handles it as before`,
    );
  }
}

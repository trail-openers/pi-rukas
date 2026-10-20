/**
 * work-driver-commit-helpers — the small shared helpers of the commit-pr
 * step (the structured fallback cause + the conflict-artifact seam).
 *
 * Split from work-driver-commit.ts for the AGENTS.md §12 500-line cap.
 * These helpers are shared between the mechanized path (work-driver-commit.ts)
 * and the ops-fallback dispatch (work-driver-commit-fallback.ts); a direct
 * import from either module into the other would create a circular import
 * (both import the other for the dispatch/audit seams), so the shared
 * helpers live here.
 */
import type { IntegrateResult } from "./work-driver-integrate.ts";
import type { CommitPrFallbackCause } from "./workflow-state-events.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/** #539 — the structured cause, or `undefined` when integrate() did not
 * fail. Reads `res.failure` (the discriminator), never re-parses `reason`. */
export function causeFromIntegrateFailure(res: IntegrateResult): CommitPrFallbackCause | undefined {
  if (res.ok) return undefined;
  switch (res.failure) {
    case "dirty-repoRoot":
      return "dirty-repoRoot";
    // #1439 — the forge refused the push. Terminal (see `IntegrateResult.failure`),
    // but the label still reaches the plumb-report the terminal halt writes.
    case "push-refused":
      return "push-refused";
    default:
      return "other";
  }
}

/**
 * #861 — the fallback's structural conflict-artifact source. The plumb
 * report the driver appends on a non-terminal mechanized failure carries
 * "(patch preferred at <path>)" in its body (mechanizedCommitPr's reason
 * does) — the ops prompt gets the path from this event, never re-parsed
 * out of a free-text reason at the prompt seam.
 *
 * #861 round 2 — the caller threads `res.conflictPatch` (the structured
 * field on the mechanized failure) into `dispatchCommitPrFallback` and
 * passes it to this helper; the helper now PREFERS the structural value
 * and only falls back to parsing the plumb's body when the caller had no
 * structured value (the "no-diff workstream" reason, which carries no
 * patch). One event indirection, gone.
 */
export function conflictArtifactFromPlumb(
  event: WorkEvent | undefined,
  structural: string | undefined,
): string | undefined {
  if (structural) return structural;
  if (event?.kind !== "plumb-report") return undefined;
  const m = event.body.match(/\(patch preserved at (\S+)\)/);
  return m?.[1];
}

/**
 * #861 — the shared reason-suffix both mechanizedCommitPr return sites used
 * to duplicate inline: the conflict-patch marker appended to a non-terminal
 * reason (or the reason unchanged when no patch was preserved).
 */
export function withPatchNote(reason: string, patch?: string): string {
  return patch ? `${reason} (patch preserved at ${patch})` : reason;
}

/** The terminal half of a mechanized commit-pr failure, as returned to `runCommitPr`. */
export interface TerminalCommitPrFailure {
  ok: false;
  reason: string;
  terminal: true;
  fallbackCause?: CommitPrFallbackCause;
  /** #1064 — the consolidated verify's own failure lines (failing test names, `✗` lines). */
  failures?: string[];
  /** #1064 / #841 — persisted raw-output logs behind the failure. */
  logPaths?: string[];
  /** #1324 — the terminal verify failure was a run killed at its bound. */
  timedOut?: boolean;
  /**
   * #861 — set when a TERMINAL failure already appended the plumb + cap events
   * (the worktree-creation halt): the caller returns this state instead of writing
   * a second cap of its own.
   */
  haltedAfter?: WorkState;
  conflictPatch?: undefined;
}

/** A recoverable mechanized failure: the ops fallback takes over. */
export interface RecoverableCommitPrFailure {
  ok: false;
  reason: string;
  terminal?: undefined;
  timedOut?: undefined;
  failures?: undefined;
  logPaths?: undefined;
  haltedAfter?: undefined;
  fallbackCause?: CommitPrFallbackCause;
  /**
   * #861 — the structured conflict-patch path preserved by integrate() (the "where
   * possible" of the ops-fallback conflict seam). The caller threads it as the
   * STRUCTURAL argument of `conflictArtifactFromPlumb`, so the ops prompt reads the
   * field rather than re-parsing the plumb's body.
   */
  conflictPatch?: string;
}

/** What `mechanizedCommitPr` returns: success, a terminal halt, or a recoverable failure. */
export type MechanizedCommitPrResult =
  | { ok: true; state: WorkState }
  | TerminalCommitPrFailure
  | RecoverableCommitPrFailure;

/**
 * The ONE shape of a terminal mechanized failure (a red consolidated verify, and
 * since #1439 a push the forge refused). Both were written out separately; one
 * builder keeps the evidence fields from being threaded into one and dropped from
 * the other, which is exactly how a park ends up with nothing to show.
 */
export function terminalCommitPrFailure(
  res: Extract<IntegrateResult, { ok: false }>,
  fallbackCause: CommitPrFallbackCause | undefined,
): TerminalCommitPrFailure {
  return {
    ok: false,
    reason: res.reason,
    terminal: true,
    fallbackCause,
    ...(res.failures !== undefined ? { failures: res.failures } : {}),
    ...(res.logPaths !== undefined ? { logPaths: res.logPaths } : {}),
    ...(res.timedOut ? { timedOut: true } : {}),
  };
}

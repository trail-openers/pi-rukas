/**
 * adversarial-ledger-capture — the #1360 ledger bindings, seen from the loop.
 *
 * `adversarial-ledger-binding.ts` decides whether a tool-path row may pass.
 * This module is the loop's half of that: when to capture, what to thread into
 * the writer, and the one thing the loop must not do — let a capture's failure
 * cost a review. Both are pure functions of the loop's own state, so the
 * binding lifecycle is testable without driving three dispatch rounds.
 *
 * Split from `adversarial.ts` (AGENTS.md §12, the 500-line gate).
 */

import { type LedgerBinding, captureBinding } from "./adversarial-ledger-binding.ts";
import {
  type AdversarialLedgerOutcome,
  writeAdversarialLedgerEntry,
} from "./adversarial-ledger.ts";
import { execp } from "./exec.ts";
import { traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

/** One round's capture and the head ref it was taken for, written together. */
export interface RoundCapture {
  /** The capture the NEXT ledger write must carry (the approving round's, since
   * the write runs on the same exit as the round that set it). */
  binding: LedgerBinding;
  /** The head ref `binding` describes. Threaded to the writer as `head`, so the
   * row's headSha and its reviewedHead resolve from the same ref — the writer
   * must never resolve a head the loop did not review. */
  headRef: string | undefined;
}

/** The loop's ledger-binding state: the last round's capture, as ONE value. */
export interface BindingState {
  /** The capture the NEXT ledger write must carry — together with the head ref
   * it was taken for. One field on purpose: both halves of a round's capture are
   * set in ONE assignment, so an interrupted round can never leave the writer
   * pairing round N's binding with round N+1's head ref. */
  captured?: RoundCapture;
}

/**
 * Take this round's capture.
 *
 * The capture is best-effort: `captureBinding` swallows its own git failures
 * into `bindingUnavailable`, and this call is wrapped so a throw cannot reach
 * the review either. A round whose capture could not run still reviews — the
 * fail-closed consequence lands on the LEDGER ROW (the writer refuses a
 * tool-path pass it cannot verify), not on the reviewer's dispatch.
 *
 * The capture and its head ref are stored as ONE object (`state.captured`),
 * never as two sibling fields: an abort or a throw between two assignments
 * would leave a fresh binding next to the previous round's ref, and the writer
 * would pair them into one row.
 *
 * Both capture failures are WARNINGS, not debug traces: a round whose capture
 * did not run is invisible otherwise, and its row is refused on the tool path —
 * an outcome change the operator should see without `PI_ENSEMBLE_DEBUG`.
 */
export async function captureRound(
  state: BindingState,
  cwd: string,
  baseRef: string | undefined,
  headRef: string | undefined,
  execFn: VerifyExecFn = execp,
): Promise<void> {
  try {
    const captured = await captureBinding(cwd, baseRef, headRef, execFn);
    if (captured.bindingUnavailable) {
      traceWarn(`adversarial: round capture unavailable — ${captured.bindingUnavailable}`);
    }
    state.captured = { binding: captured, headRef };
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 120);
    traceWarn(`adversarial: round capture threw — ${reason}`);
    state.captured = {
      binding: { bindingUnavailable: `the round capture failed (${reason})` },
      headRef,
    };
  }
}

/**
 * Whether a round's head is the branch tip rather than the ref the caller
 * named at entry.
 *
 * Rounds after the first re-read the diff, and on the tool path that re-read is
 * the SAME `base...head` range recomputed — which is only meaningful for the
 * round-2 diff if the fix round's commits are in it, i.e. if the head is the
 * branch tip. `fresh` is the re-read's output: a round that re-read nothing
 * (a failed re-read keeps the previous diff per #859) keeps the head the
 * previous round was bound to, because that is the material it is reviewing.
 */
export function roundHeadRef(
  previous: string | undefined,
  opts: { isRefRangeRound: boolean; freshDiff: string | undefined },
): string | undefined {
  if (!opts.isRefRangeRound) return previous;
  return opts.freshDiff?.trim() ? "HEAD" : previous;
}

/**
 * The loop's ledger writer: the single place a loop result becomes a durable
 * review-ledger row, and the place the #1360 provenance is threaded.
 *
 * Extracted from `adversarial.ts` for the file-size gate. The four arguments
 * the loop owns stay the loop's — the writer is handed them once — and each is
 * documented at the call site in the loop. `decorate` runs FIRST so the
 * durable row carries the same text the caller sees (#1104: fence findings),
 * and `note` runs LAST so the not-recorded warning reaches the result and not
 * the row (#980).
 *
 * #1449 — the write's outcome now reaches the operator through `onLedgerOutcome`,
 * the same side-channel shape `runLensReview` uses for its `onLedgerWrite`.
 * The row itself is unchanged by it (the promise is still fire-and-forget and
 * still never rejects: a ledger problem never costs a review), and the
 * synchronous return is preserved for the loop's seven exits — the note is
 * DELIVERED asynchronously via the optional callback, exactly as `lens-review.ts`
 * delivers its ledger outcome through the tool's note channel. A caller that
 * passes no callback gets today's behaviour byte-for-byte. The callback is
 * awaited, so a caller whose note is async (a dispatch that delivers a steer)
 * is not raced: the loop returns as soon as it did before, and the delivery
 * lands while the caller still owns the result.
 */
export function makeLedgerWrite(opts: {
  state: BindingState;
  workCwd?: string;
  branch?: string;
  /** #988 — the branch the note resolved, so the write does not re-resolve. */
  resolvedBranch?: string;
  callerSuppliedDiff?: boolean;
  /** #1360 — the tool path's provenance marker. Never inferred. */
  toolPath?: boolean;
  baseRef?: string;
  /** #1360 — the git executor threaded to BOTH the per-round capture and this
   * write (one seam, matching `commentExecFn`). */
  execFn?: VerifyExecFn;
  decorate: (raw: DispatchResult) => DispatchResult;
  note: (result: DispatchResult) => DispatchResult;
  /** #1449 — called with the resolved write outcome (the misdirection report).
   * Optional: a caller that does not want the report simply does not ask. */
  onLedgerOutcome?: (outcome: AdversarialLedgerOutcome) => void | Promise<void>;
}): (raw: DispatchResult) => DispatchResult {
  return (raw) => {
    const result = opts.decorate(raw);
    const ledgerWrite = writeAdversarialLedgerEntry(result, {
      workCwd: opts.workCwd,
      resolvedBranch: opts.resolvedBranch,
      branch: opts.branch,
      head: opts.state.captured?.headRef,
      callerSuppliedDiff: opts.callerSuppliedDiff === true,
      // #1360 — the tool path's provenance marker and its round capture.
      base: opts.baseRef,
      toolPath: opts.toolPath === true,
      binding: opts.state.captured?.binding,
      execFn: opts.execFn,
    });
    // The promise never rejects (the writer's own catch), so the only
    // bookkeeping here is delivering the report; a callback that throws must
    // not break the loop, hence the swallow. When no caller asked for the
    // report the promise is dropped exactly as before (fire-and-forget).
    if (opts.onLedgerOutcome) {
      const deliver = opts.onLedgerOutcome;
      void ledgerWrite.then((outcome) => deliver(outcome)).catch(() => undefined);
    }
    return opts.note(result);
  };
}

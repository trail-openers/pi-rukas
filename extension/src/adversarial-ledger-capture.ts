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
import { misdirectedLedgerNote } from "./adversarial-ledger-note.ts";
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
 * #1449 — the ledger writer behind a one-line mutable seam.
 *
 * `makeLedgerWrite` must not assume the writer's return is chainable or that it
 * cannot throw before returning, because "a ledger problem never costs a review"
 * is the CALL SITE's invariant, not one writer's implementation detail. But the
 * real writer ends in `write().catch(...)`, so neither failure mode is reachable
 * through it — and a guard for an unreachable failure is an untested guard. The
 * seam is how `test-adversarial-ledger-writer-shapes.ts` reaches both: it installs
 * a writer returning `undefined` (the shape `mock.module` gives a bare
 * `(r, p) => { push() }`), one throwing synchronously, and one rejecting, and
 * asserts none of them damages the loop's result. Deleting the `Promise.resolve`
 * or the `try`/`catch` turns an arm red (mutation-checked).
 *
 * A box (`.current`) rather than a setter, so the swap is one assignment the test
 * restores in a `finally`. Production never writes it: every non-test process
 * calls the real `writeAdversarialLedgerEntry`. Same precedent as the `execFn`
 * seam #1360 threads through this module — one injectable point per dependency.
 */
export const LEDGER_WRITER: {
  current: typeof writeAdversarialLedgerEntry;
} = { current: writeAdversarialLedgerEntry };

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
 * #1449 — the write's outcome reaches the operator through `onLedgerOutcome`,
 * and the DEFAULT reporter is the misdirection note: `runAdversarialLoop` calls
 * `makeLedgerWrite` with no callback and gets one, so the adversarial half of
 * #1449 is not a capability a caller has to opt into (the shape `writeAdversarialLedgerEntry`
 * documents, where every skip used to be trace-only). The row itself is
 * unchanged by it — the promise is still fire-and-forget and still never
 * rejects: a ledger problem never costs a review — and the synchronous return
 * is preserved for the loop's seven exits. The note is DELIVERED when the write
 * settles, into the held result, exactly as `lens-review.ts` delivers its ledger
 * outcome through the tool's note channel. A caller that wants the raw outcome
 * instead (a test) replaces the callback. The callback is awaited by the
 * delivery, not by the return: a caller whose note is async (a dispatch that
 * delivers a steer) is not raced, and the loop returns as soon as it did before.
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
  /** #1449 — called with the resolved write outcome. Defaults to the
   * misdirection-note reporter; a caller that wants the raw outcome (a test)
   * replaces it. */
  onLedgerOutcome?: (outcome: AdversarialLedgerOutcome | undefined) => void | Promise<void>;
}): (raw: DispatchResult) => DispatchResult {
  return (raw) => {
    const result = opts.decorate(raw);
    // #1449 — the result the loop returns is held here so the note can be
    // appended when the write reports a redirect. The ledger write stays
    // fire-and-forget: this reference is what the note is appended TO, never
    // something the return waits on.
    let live = result;
    const deliver =
      opts.onLedgerOutcome ??
      ((outcome: AdversarialLedgerOutcome | undefined) => {
        // Default reporter: append the misdirection note to the held result.
        // A no-op on every outcome but a row that landed outside the per-clone
        // ledger (see `misdirectedLedgerNote`), so the overwhelming majority of
        // writes change nothing — and nothing here is awaited by the return.
        const note = misdirectedLedgerNote(outcome);
        // `opts.note` re-runs on the held result because the loop's threader is
        // PURE (it appends a constant when the branch did not resolve), so
        // re-applying it to `live` is byte-identical to applying it once. It
        // must be applied here and not earlier: the loop's `note` runs on the
        // return, which happens BEFORE this promise settles, so a note applied
        // only on the synchronous path could never see a redirect.
        if (note) live = opts.note({ ...live, text: `${live.text}\n\n${note}` });
      });
    // #1449 — the writer is called through a SEAM (`LEDGER_WRITER`) rather than
    // by name, and the result is normalised before ANYTHING is chained onto it.
    // Two layers, both load-bearing, neither reachable through the real writer:
    // `writeAdversarialLedgerEntry` ends in `write().catch(...)`, so a fault in
    // its BODY can only ever be a rejection — an unreachable throw and an
    // unchainable return would make the `try`/`catch` and the `Promise.resolve`
    // decorative, and an unreachable guard is an untested one. The seam lets a
    // test install a writer that returns `undefined` (the shape `mock.module`
    // gives a bare `(r, p) => { push() }`, which took down
    // `test-adversarial-tool-guards` in CI with `TypeError: undefined is not an
    // object`) or throws synchronously, and prove neither reaches the loop's
    // exit. Production never sets the seam; it is the real writer throughout.
    let ledgerWrite: unknown;
    try {
      ledgerWrite = LEDGER_WRITER.current(result, {
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
    } catch {
      // A writer that throws synchronously is a ledger fault, not a review
      // fault: nothing is reported (there is no outcome to report) and the loop
      // returns its result exactly as it would have without the write.
      ledgerWrite = undefined;
    }
    // The promise never rejects (the writer's own catch), so the only
    // bookkeeping here is delivering the report; a callback that throws must
    // not break the loop, hence the swallow. The reporter always runs — the
    // default IS the misdirection note, so the adversarial half of #1449 is
    // never a capability a caller has to opt into (a caller that wants the raw
    // outcome instead, e.g. a test, replaces it). `Promise.resolve` is what
    // makes the chain safe when `ledgerWrite` is undefined / a non-promise / a
    // thenable that never settles — see the guard above. A non-`undefined`
    // non-promise return reaches the reporter as no outcome (normalised, so the
    // reporter's contract is one type whatever the writer returned);
    // `misdirectedLedgerNote` reads only `recorded` / `landedAtPath` / `reason`,
    // so a shape it has never seen yields no note rather than a crash or an
    // invented claim.
    void Promise.resolve(ledgerWrite)
      .then((outcome) =>
        deliver(
          outcome === undefined || outcome === null
            ? undefined
            : (outcome as AdversarialLedgerOutcome),
        ),
      )
      .catch(() => undefined);
    return opts.note(live);
  };
}

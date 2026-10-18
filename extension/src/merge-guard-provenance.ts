/**
 * merge-guard-provenance — the #912 guard's one write-side diagnostic, kept off
 * the guard's own decision path.
 *
 * The guard reads the ledger through the same resolver the writers write
 * through, so inside a process carrying an inherited
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` the guard and the writer agree on the
 * redirected file and the mismatch is invisible to any comparison made here.
 * What the guard CAN surface is the provenance the writer persisted at write
 * time: a row that noticed its own redirect carries `writtenTo`
 * (review-ledger.ts `LedgerEntry.writtenTo`). So this asks the one file the
 * override points at — the guard's own resolved path — whether any row for this
 * branch carries that stamp, and returns the first one it finds.
 *
 * ## Why this lives in its own module
 *
 * It is the only part of the guard that reads a file for EXPLANATION rather than
 * for the VERDICT, and the two have opposite failure contracts. The verdict read
 * (`readLedgerAt` in merge-guard.ts) decides the merge and fails closed. This
 * read is a diagnostic: it must be able to say nothing, and it must never be
 * able to change what the guard decides. Inlining it in the guard put a raw fs +
 * JSON read on the path every merge-guard evaluation takes, where a throw from
 * an unreadable or corrupt file escaped into the handler that owns the verdict.
 * Split out, the two contracts are one function apart and each is stated where
 * it is implemented — and the diagnostic is a synchronous call with no throw
 * site, so the guard's `async` handler has nothing new that can reject.
 *
 * ## The failure contract (every arm refuses; none may pass)
 *
 * - a row for this branch carrying `writtenTo` → that path, sanitised (the only
 *   arm that produces the distinguishing refusal text); a stamp that sanitises
 *   to nothing (control characters only) takes the no-row arm instead;
 * - no such row → undefined: the ordinary "never reviewed" refusal;
 * - an unreadable file (missing, a directory, an fs error) → undefined;
 * - a corrupt file (`readLedgerFileSafe` yielding nothing) → undefined.
 *
 * "No misdirection detected" is what a fault yields, which is the behaviour the
 * guard had before the diagnostic existed at all: the ordinary refusal stands. A
 * fault must never turn a refusal into an allow, and must never invent a second
 * refusal path — hence `catch (err: unknown)` and `String(err)` rather than a
 * cast, the same shape `analyseRefusal` in merge-guard.ts was given for the
 * identical reason (#955 lens round 6): `(err as Error).message` throws INSIDE
 * the catch on a thrown non-Error, which is how a diagnostic becomes a crash.
 *
 * The fault is traced at WARN, not swallowed into silence: the operator who
 * loses the distinguishing text should still be able to see, under
 * `PI_ENSEMBLE_DEBUG`, that the explanation could not be read — a silent
 * diagnostic is indistinguishable from a review that never ran, which is the
 * symptom #1449 exists to fix. `readLedgerFileSafe` already swallows the faults
 * it knows about; this catch is the outer belt for whatever the fs layer throws
 * that it does not, and BOTH layers are asserted no-throw separately in
 * test-merge-guard-provenance-fault.ts (a test that watched only the outer one
 * would stay green with either deleted).
 */

import { existsSync } from "node:fs";
import { sameResolvedPath, sanitiseLedgerProvenancePath } from "./review-ledger-path.ts";
import { readLedgerFileSafe } from "./review-ledger-read.ts";
import { trace, traceWarn } from "./trace.ts";

/**
 * The path a redirected review wrote to, when one did. Undefined means "no
 * misdirection detected" — the ordinary never-reviewed refusal — and a fault
 * inside the read takes that same arm after tracing why.
 *
 * The returned value is the row's `writtenTo` stamp **sanitised**
 * (`sanitiseLedgerProvenancePath`): the stamp is written by whatever process
 * made the write and read back out of a file the environment names, so by the
 * time it is rendered into the guard's refusal it is untrusted data. Control
 * characters are stripped and the length capped there, so the refusal cannot
 * be made to carry injected lines — and a stamp that sanitises to nothing
 * yields the plain never-reviewed refusal, which is the honest text for
 * "there is no path worth naming".
 */
export function misdirectedWriteOf(
  ledgerPath: string,
  branch: string,
  /** #1449 round 2 — the clone's OWN ledger path (the override-blind answer,
   * `cloneLedgerPathFor`). A stamp naming it is not a misdirection. The caller
   * resolves it once and passes it, so this diagnostic makes no git call; an
   * unresolvable path is passed as undefined, which reports rather than hides. */
  expectedClonePath?: string,
): string | undefined {
  try {
    if (!existsSync(ledgerPath)) return undefined;
    for (const e of readLedgerFileSafe(ledgerPath).entries) {
      if (e.branch === branch) {
        const stamped = sanitiseLedgerProvenancePath(e.writtenTo);
        // #1449 round 2 — a stamp naming the file this guard is reading is not
        // evidence of a misdirection, and neither is one naming the clone's OWN
        // ledger. The second case is what an override points at most of the time
        // a stale value lingers: a row written before the override existed, or
        // written by a process without it, sits in the clone's ledger with no
        // stamp at all — but a row that carries a stamp equal to the clone path
        // says plainly "this landed where the guard looks", so reporting it as
        // redirected would tell the operator a review went somewhere it
        // demonstrably did not.
        //
        // The comparison is against the CLONE path (`cloneLedgerPathFor`, the
        // override-blind answer) and not against `ledgerPath`: inside a
        // redirecting process `ledgerPath` IS the redirected file, so comparing
        // against it would compare a stamp to itself and never fire — and a
        // legitimate redirect's stamp always differs from the clone path, which
        // is what makes it a redirect.
        if (stamped && !sameResolvedPath(stamped, expectedClonePath)) return stamped;
      }
    }
    return undefined;
  } catch (err: unknown) {
    // `unknown` + `String(err)`, never a cast: a thrown non-Error would make
    // `(err as Error).message` throw INSIDE this catch — how a diagnostic
    // becomes a crash on the guard's path (#955 lens round 6, `analyseRefusal`).
    traceWarn(
      `merge-guard: could not read ledger provenance at ${ledgerPath}: ${String(err).slice(0, 120)} — the refusal will not name a redirect`,
    );
    trace(`merge-guard: provenance read failed for branch ${branch}`);
    return undefined;
  }
}

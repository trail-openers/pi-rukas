/**
 * lens-ledger — the lens-review's review-ledger write, split from
 * lens-review.ts (AGENTS.md §12 file-size limit).
 *
 * #912. A completed lens review records a `{ branch, patchId, passed }` entry
 * so the merge guard can refuse an agent-run merge with no passing lens
 * review on file. Failure isolation: every fault is swallowed and traced —
 * the caller's summary comes back byte-identical.
 *
 * The patchId comes from `workingTreePatchId` (review-ledger.ts) — the ONE
 * shared base/patchId computation both writers use (see the header there for
 * the merge-base / working-tree semantics). The `threshold` is the
 * RESOLVED threshold the driver already computed for this review, so the
 * stored `passed` boolean is scored with exactly the same bar the verdict
 * was decided with.
 */

import { resolveReviewBranch } from "./review-branch.ts";
import {
  type LedgerEntry,
  appendLedgerEntry,
  ledgerPathFor,
  lensPassed,
  misdirectedLedgerWrite,
  workingTreePatchId,
} from "./review-ledger.ts";
import { trace, traceWarn } from "./trace.ts";

import { execp } from "./exec.ts";

/**
 * Write a lens-review entry to the review ledger. Fire-and-forget in
 * PRODUCTION: callers (runLensReview's single finish path) may discard the
 * returned promise — the internal `catch(trace)` below swallows every
 * failure, so the promise cannot reject and an un-awaited caller is safe.
 * The promise is returned (not `void`) so a test can AWAIT the write
 * deterministically without changing the production contract (#984):
 * the await seam is a separate side-channel (returned promise), not the
 * summary's return path, so the "ledger write never gates the review
 * result" rule (#912) is preserved — the summary is still resolved at the
 * same wall-clock moment as the pre-#984 `void` form.
 *
 * #973 — the entry carries the round-cap rule's inputs: `hasCritical`
 * (whether the reviewed verdict carried a CRITICAL finding) and `headSha`
 * (the commit reviewed, resolved when a caller names the branch). The
 * `round` is added by `appendLedgerEntry` (`bumpLensRound`) against the
 * file's previous contents, so the writer does not read the ledger itself —
 * `bumpLensRound` in review-ledger.ts is the only read-and-write site of
 * the counter (the writer never touches it).
 */
/**
 * What the fire-and-forget write did. `recorded: false` means the round is NOT
 * on the ledger, so the budget must not treat it as consumed by a recorded
 * entry (lens-round-cap.ts counts it as an unrecorded round). The promise
 * still never rejects.
 *
 * #1449 — `landedAtPath` is the misdirection signal, and it is deliberately NOT
 * expressed as `recorded: false`. A write redirected by an inherited
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` genuinely succeeded — the file exists and is
 * writable — so `recorded` stays `true`, the #1127 not-recorded note never
 * fires, and the row is simply not where the #912 guard will look. A caller
 * gets FOUR distinguishable shapes, and a by-design no-write must never read as
 * a misdirection:
 *
 *   - `{ recorded: true }` — on the per-clone ledger (the normal case);
 *   - `{ recorded: true, landedAtPath }` — recorded, at a path outside the
 *     clone's own ledger (a redirect: the row exists, the guard cannot see it);
 *   - `{ recorded: false, reason }` — nothing written (no branch, no patch id,
 *     or the append itself failed — each names its own reason);
 *   - no outcome at all (`undefined`) — a by-design no-write the caller never
 *     asks about (`noReview`, carry; see lens-review.ts / lens-review-diff.ts).
 */
export type LensLedgerOutcome =
  | { recorded: true; landedAtPath?: string }
  | { recorded: false; reason: string };

export function writeLensLedgerEntry(
  verdict: string,
  threshold: string,
  cwd: string | undefined,
  branch?: string,
  hasCritical?: boolean,
  headSha?: string,
  head?: string,
  /** #988 — the branch ALREADY resolved by `runLensReview` (threaded by the
   * finish path) — the write skips its own re-resolution when present. */
  resolvedBranch?: string,
  /** #1127 — the operator passed `overrideCap: true`; recorded on the entry. */
  overrideCap?: boolean,
): Promise<LensLedgerOutcome> {
  const write = async (): Promise<LensLedgerOutcome> => {
    const c = cwd ?? process.cwd();
    // #980 — the branch comes from the SHARED resolver (review-branch.ts:
    // explicit `branch` → branch-named `head` → rev-parse) — the same one
    // the lens review and the residual poster use — so all three key on the
    // same branch string by construction.
    // #988 — the finish path threads in `runLensReview`'s ONE resolution
    // (same args + cwd, computed before the fan-out); self-resolution is
    // the fallback for direct callers that did not resolve.
    const b = resolvedBranch ?? (await resolveReviewBranch({ branch, head, cwd: c }, execp)).branch;
    if (!b) {
      trace("lens-review: ledger write skipped — no branch (detached head, no caller branch)");
      return { recorded: false, reason: "no branch to key the ledger entry on" };
    }
    // The shared working-tree patch id (review-ledger.ts). When untracked
    // files exist the entry is still written for the tracked content, but the
    // gap is traced — see the warning's wording in workingTreePatchId.
    const computed = await workingTreePatchId(execp, c, { digest: true });
    if (computed.warning) trace(`lens-review: ${computed.warning}`);
    if (!computed.patchId) {
      traceWarn(
        `lens-review: ledger write skipped for ${b} — no patch id (${computed.warning ?? "unknown"}); the round is not recorded`,
      );
      return { recorded: false, reason: computed.warning ?? "no patch id for the working tree" };
    }
    const entry: LedgerEntry = {
      branch: b,
      kind: "lens",
      patchId: computed.patchId,
      passed: lensPassed(verdict, threshold),
      at: Date.now(),
      detail: verdict,
      ...(hasCritical !== undefined ? { hasCritical } : {}),
      ...(headSha ? { headSha } : {}),
      ...(overrideCap ? { overrideCap: true } : {}),
      ...(computed.diffSha256 ? { diffSha256: computed.diffSha256 } : {}),
    };
    // #1449 — the row carries where it landed when that is not the clone's own
    // ledger, so a LATER process that reads the real ledger and finds nothing
    // can still be told a review ran elsewhere (see `LedgerEntry.writtenTo`).
    // ONE predicate with the adversarial writer, so the two cannot disagree
    // about what a misdirection is; no override set means no git call, no cost.
    const landedAtPath = await misdirectedLedgerWrite(execp, c, await appendTargetFor(execp, c));
    if (landedAtPath) entry.writtenTo = landedAtPath;
    const failure = await appendLedgerEntry(entry, execp, c);
    if (failure) return { recorded: false, reason: failure };
    return landedAtPath ? { recorded: true, landedAtPath } : { recorded: true };
  };
  // The catch is load-bearing for the fire-and-forget contract: the
  // returned promise MUST resolve (never reject) so an un-awaited caller
  // cannot leak an unhandled rejection. Tests that await it can rely on
  // the same guarantee.
  return write().catch((err: unknown): LensLedgerOutcome => {
    const reason = (err as Error).message;
    trace(`lens-review: ledger write failed: ${reason}`);
    return { recorded: false, reason };
  });
}

/**
 * #1449 — the path `appendLedgerEntry` resolved for this write.
 *
 * The writer does not return it (its contract is a failure reason, shared with
 * the adversarial writer and the driver), so the caller re-resolves it here —
 * the same function, same env, same cwd, microseconds later, after the append
 * released the ledger lock. When it cannot resolve there is no path to compare
 * and no misdirection is reported: a path this module cannot name is not
 * evidence that a row went astray.
 */
async function appendTargetFor(execFn: typeof execp, cwd: string): Promise<string | undefined> {
  try {
    return await ledgerPathFor(execFn, cwd);
  } catch {
    return undefined;
  }
}

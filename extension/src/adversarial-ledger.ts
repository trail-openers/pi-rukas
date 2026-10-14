/**
 * adversarial-ledger — the adversarial loop's review-ledger write, split
 * from adversarial.ts (AGENTS.md §12 file-size limit).
 *
 * #912. A completed adversarial review records a `{ branch, patchId, passed }`
 * entry so the merge guard (merge-guard.ts) can refuse an agent-run merge
 * with no passing review on file. Failure isolation: every fault here is
 * swallowed and traced — the loop's DispatchResult comes back byte-identical
 * whether the write ran or threw.
 *
 * The patchId comes from `workingTreePatchId` (review-ledger.ts) — the ONE
 * shared base/patchId computation both writers use. It diffs the working tree
 * against the merge-base of HEAD and `<remote>/<mainline>` (resolved via
 * detectMainline + the forge remote, never a hardcoded `origin/main`), so
 * the entry covers the uncommitted fixes the loop made; when those fixes are
 * committed unchanged, the id the guard recomputes at merge time matches.
 */

import { resolveReviewBranch } from "./review-branch.ts";
import { resolveHeadSha } from "./review-head-sha.ts";
import {
  type LedgerEntry,
  adversarialPassed,
  appendLedgerEntry,
  workingTreePatchId,
} from "./review-ledger.ts";
import { rangePatchId } from "./review-patch-id.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

import { execp } from "./lens-exec.ts";

/**
 * #1161 — where the diff the review judged came from. Derived by the loop
 * (adversarial.ts), never supplied by a caller:
 *   - `pasted`: a diff string was pasted. Recorded as passed:false.
 *   - `range`: the loop resolved base+head to these commit SHAs and reviewed
 *     `base...head`. The row's patch id is that range's own patch id.
 *   - `tree`: no diff was reviewed (an early exit). The row carries the
 *     working-tree patch id; it cannot pass, because nothing was approved.
 */
export type ReviewProvenance =
  | { kind: "pasted" }
  | { kind: "range"; base: string; head: string }
  | { kind: "tree" };

/**
 * Write an adversarial-review entry to the review ledger. Fire-and-forget:
 * the caller does not await this; the function is safe to call on every
 * exit path of `runAdversarialLoop`.
 * #1161 — the promise resolves to true when a row was written, false otherwise;
 * the loop awaits it so a miss can be surfaced to the tool caller.
 *
 * #1161 — a `pasted` review is recorded as `passed: false` with detail
 * "<outcome> (caller-supplied diff)", so the merge guard refuses it; the same
 * review via base+head is recorded normally.
 *
 * #1161 — a `range` review: the patchId is the range's own patch id
 * (rangePatchId), not the working tree's, so the row covers the diff the loop
 * reviewed and nothing else. `base` and `head` are the loop's pinned SHAs.
 */
export function writeAdversarialLedgerEntry(
  result: DispatchResult,
  params: {
    workCwd?: string;
    branch?: string;
    head?: string;
    resolvedBranch?: string;
    provenance?: ReviewProvenance;
  },
): Promise<boolean> {
  const write = async (): Promise<boolean> => {
    const c = params.workCwd ?? process.cwd();
    const provenance: ReviewProvenance = params.provenance ?? { kind: "tree" };
    // #980 — the branch comes from the SHARED resolver (review-branch.ts:
    // explicit `branch` → branch-named `head` → rev-parse) — the same one
    // the lens review and the residual poster use — so all three key on the
    // same branch string by construction. `head` is threaded in (the tool
    // path's diff ref may name the branch even when `branch` is absent) so
    // the write resolves identically to the note built in `buildLedgerNote`.
    // #988 — the loop threads in the branch its note resolved (buildLedgerNote
    // resolves ONCE, up front, with the same args + cwd); self-resolution is
    // the fallback for direct callers that did not resolve.
    const branch =
      params.resolvedBranch ??
      (await resolveReviewBranch({ branch: params.branch, head: params.head, cwd: c }, execp))
        .branch;
    if (!branch) {
      trace("adversarial: ledger write skipped — no branch (detached head, no caller branch)");
      return false;
    }
    // #1161 — a range review is bound to the diff the loop reviewed: its own
    // range id, never the working tree's. A narrowed range (base = tip~1) then
    // records an id that never matches the whole branch at merge time, so the
    // guard refuses it. Only the other provenances use the working-tree id.
    // The shared working-tree patch id (review-ledger.ts). When untracked
    // files exist the entry is still written for the tracked content, but the
    // gap is traced — see the warning's wording in workingTreePatchId.
    const computed = provenance.kind === "range" ? undefined : await workingTreePatchId(execp, c);
    if (computed?.warning) trace(`adversarial: ${computed.warning}`);
    const patchId =
      provenance.kind === "range"
        ? await rangePatchId(execp, c, provenance.base, provenance.head)
        : computed?.patchId;
    if (!patchId) return false;
    // #1039 — resolve the head to a full 40-char SHA via the shared
    // resolver (review-head-sha.ts — the same one the lens writer and the
    // diff resolvers use). The adversarial writer takes `head` for branch
    // resolution; now it also uses it (or HEAD) for the headSha field. An
    // unresolvable head leaves headSha undefined (omitted from the entry) —
    // the write succeeds without the field, matching the lens writer's
    // behaviour. A range review already holds the SHA the loop pinned.
    const headSha =
      provenance.kind === "range"
        ? provenance.head
        : await resolveHeadSha(c, params.head ?? "HEAD", execp);
    const pasted = provenance.kind === "pasted";
    const entry: LedgerEntry = {
      branch,
      kind: "adversarial",
      patchId,
      passed: adversarialPassed(result) && !pasted,
      at: Date.now(),
      detail: pasted
        ? `${result.loopOutcome ?? "completed"} (caller-supplied diff)`
        : (result.loopOutcome ?? "completed"),
      ...(headSha ? { headSha } : {}),
    };
    await appendLedgerEntry(entry, execp, c);
    return true;
  };
  return write().catch((err) => {
    trace(`adversarial: ledger write failed: ${(err as Error).message}`);
    return false;
  });
}

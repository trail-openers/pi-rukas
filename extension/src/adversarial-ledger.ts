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
 * `detectMainline` — mainline.ts since #1387 — plus the forge remote, never a
 * hardcoded `origin/main`), so
 * the entry covers the uncommitted fixes the loop made; when those fixes are
 * committed unchanged, the id the guard recomputes at merge time matches.
 *
 * #1360 — on the TOOL path (`toolPath: true`, set by `adversarial-tool.ts` and
 * nothing else) that working-tree identity alone is not enough evidence that
 * the review covered the branch: a narrowed `base` produced a full-branch row.
 * A tool-path row now passes the range/head/tree bindings in
 * `adversarial-ledger-binding.ts` or it is written NON-PASSING with a named
 * detail. The `/work` driver path never sets `toolPath` and is unchanged.
 */

import {
  type LedgerBinding,
  decideToolPathRow,
  toolPathFields,
} from "./adversarial-ledger-binding.ts";
import { execp } from "./exec.ts";
import { resolveReviewBranch } from "./review-branch.ts";
import { resolveHeadSha } from "./review-head-sha.ts";
import {
  type LedgerEntry,
  adversarialPassed,
  appendLedgerEntry,
  workingTreePatchId,
} from "./review-ledger.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

/**
 * Write an adversarial-review entry to the review ledger. Fire-and-forget:
 * the caller does not await this; the function is safe to call on every
 * exit path of `runAdversarialLoop`.
 *
 * #1161 — the returned promise never rejects (the caller may ignore it).
 *
 * #1161 — `callerSuppliedDiff`: the review judged a diff string the caller
 * pasted, not one the tool computed from base+head. Such a review is recorded
 * as `passed: false` with detail "<outcome> (caller-supplied diff)", so the
 * merge guard refuses it; the same review via base+head is recorded normally.
 *
 * #1360 — `toolPath` + `binding` + `base`: the tool path's provenance marker
 * and the range/content the approving round actually judged. `toolPath` is set
 * ONLY by `adversarial-tool.ts` after the raw params spread, so a caller cannot
 * set it; the driver's rows carry none and keep their pre-#1360 semantics.
 */
export function writeAdversarialLedgerEntry(
  result: DispatchResult,
  params: {
    workCwd?: string;
    branch?: string;
    head?: string;
    resolvedBranch?: string;
    callerSuppliedDiff?: boolean;
    /** #1360 — the reviewed base ref, and whether this row came from the
     * `adversarial_loop` tool rather than the /work driver. */
    base?: string;
    toolPath?: boolean;
    /** #1360 — what the approving round captured (range SHAs + the working-tree
     * identity at the time its diff was read). Absent = nothing was captured,
     * which a tool-path row reads as unverifiable, never as a pass. */
    binding?: LedgerBinding;
  },
): Promise<void> {
  const write = async () => {
    const c = params.workCwd ?? process.cwd();
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
      return;
    }
    // The shared working-tree patch id (review-ledger.ts). When untracked
    // files exist the entry is still written for the tracked content, but the
    // gap is traced — see the warning's wording in workingTreePatchId.
    const computed = await workingTreePatchId(execp, c);
    if (computed.warning) trace(`adversarial: ${computed.warning}`);
    if (!computed.patchId) return;
    // #1039 — resolve the head to a full 40-char SHA via the shared
    // resolver (review-head-sha.ts — the same one the lens writer and the
    // diff resolvers use). The adversarial writer takes `head` for branch
    // resolution; now it also uses it (or HEAD) for the headSha field. An
    // unresolvable head leaves headSha undefined (omitted from the entry) —
    // the write succeeds without the field, matching the lens writer's
    // behaviour.
    const headRef = params.head ?? "HEAD";
    const headSha = await resolveHeadSha(c, headRef, execp);
    const callerSupplied = params.callerSuppliedDiff === true;
    const outcome = result.loopOutcome ?? "completed";
    const verdictPassed = adversarialPassed(result);
    const toolPath = params.toolPath === true;
    // #1360 — the tool path's bindings. A row that was never going to pass
    // keeps its own verdict detail: a rejection is not relabelled as a binding
    // failure, and the guard's refusal for it is the ordinary one.
    const binding =
      toolPath && verdictPassed && !callerSupplied
        ? await decideToolPathRow({
            workCwd: c,
            baseRef: params.base,
            headRef,
            binding: params.binding ?? {
              bindingUnavailable: "no round capture reached the writer",
            },
            currentTreePatchId: computed.patchId,
            currentHeadSha: headSha ?? "",
          })
        : undefined;
    const refusedByBinding = binding !== undefined && !binding.ok;
    const detail = callerSupplied
      ? `${outcome} (caller-supplied diff)`
      : refusedByBinding
        ? (binding.detail ?? `${outcome} (review range unverifiable)`)
        : outcome;
    const entry: LedgerEntry = {
      branch,
      kind: "adversarial",
      patchId: computed.patchId,
      passed: verdictPassed && !callerSupplied && !refusedByBinding,
      at: Date.now(),
      detail,
      ...(headSha ? { headSha } : {}),
      ...toolPathFields(params.binding ?? {}, toolPath),
    };
    await appendLedgerEntry(entry, execp, c);
  };
  return write().catch((err) =>
    trace(`adversarial: ledger write failed: ${(err as Error).message}`),
  );
}

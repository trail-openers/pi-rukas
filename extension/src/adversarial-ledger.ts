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

import { shq } from "./forge-commands.ts";
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

import { execp } from "./lens-exec.ts";

/**
 * #1161 — the patch id of a tool-computed range: `git diff base...head |
 * git patch-id --stable`, the same three-dot diff the reviewer judged. The refs
 * come from LLM-supplied tool params, so a leading `-` is refused (argument
 * injection) and both refs are shell-quoted (the exec seam is a shell string).
 * Undefined on any failure; the caller then writes no row, which the guard
 * reads as "no passing review".
 */
async function rangePatchId(cwd: string, base: string, head: string): Promise<string | undefined> {
  if (base.startsWith("-") || head.startsWith("-")) return undefined;
  try {
    const { stdout } = await execp(`git diff ${shq(base)}...${shq(head)} | git patch-id --stable`, {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    const id = stdout.trim().split(/\s+/)[0] || undefined;
    if (!id) trace(`adversarial: range ${base}...${head} has no patch id (empty diff)`);
    return id;
  } catch (err) {
    trace(`adversarial: range patch-id failed for ${base}...${head}: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Write an adversarial-review entry to the review ledger. The loop does not
 * await this (fire-and-forget); the returned promise never rejects, so the
 * function is safe to call on every exit path of `runAdversarialLoop`.
 *
 * #1161 — `callerSuppliedDiff`: the review judged a diff string the caller
 * pasted, not one the tool computed from base+head. Such a review is recorded
 * as `passed: false` with detail "<outcome> (caller-supplied diff)", so the
 * merge guard refuses it; the same review via base+head is recorded normally.
 *
 * #1161 — `base` + `head` (no pasted diff): the patchId is the range's own
 * patch id (rangePatchId), not the working tree's, so the row covers the diff
 * the loop reviewed and nothing else.
 */
export function writeAdversarialLedgerEntry(
  result: DispatchResult,
  params: {
    workCwd?: string;
    branch?: string;
    head?: string;
    base?: string;
    resolvedBranch?: string;
    callerSuppliedDiff?: boolean;
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
    // #1161 — a tool-computed range is bound to the diff the loop reviewed:
    // its own range id, never the working tree's. A narrowed range (base =
    // tip~1) then records an id that never matches the whole branch at merge
    // time, so the guard refuses it. Any other review keeps the working-tree id.
    const callerSupplied = params.callerSuppliedDiff === true;
    const range =
      !callerSupplied && params.base && params.head
        ? { base: params.base, head: params.head }
        : undefined;
    const patchId = range ? await rangePatchId(c, range.base, range.head) : computed.patchId;
    if (!patchId) return;
    // #1039 — resolve the head to a full 40-char SHA via the shared
    // resolver (review-head-sha.ts — the same one the lens writer and the
    // diff resolvers use). The adversarial writer takes `head` for branch
    // resolution; now it also uses it (or HEAD) for the headSha field. An
    // unresolvable head leaves headSha undefined (omitted from the entry) —
    // the write succeeds without the field, matching the lens writer's
    // behaviour.
    const headRef = params.head ?? "HEAD";
    const headSha = await resolveHeadSha(c, headRef, execp);
    const entry: LedgerEntry = {
      branch,
      kind: "adversarial",
      patchId,
      passed: adversarialPassed(result) && !callerSupplied,
      at: Date.now(),
      detail: callerSupplied
        ? `${result.loopOutcome ?? "completed"} (caller-supplied diff)`
        : (result.loopOutcome ?? "completed"),
      ...(headSha ? { headSha } : {}),
    };
    await appendLedgerEntry(entry, execp, c);
  };
  return write().catch((err) =>
    trace(`adversarial: ledger write failed: ${(err as Error).message}`),
  );
}

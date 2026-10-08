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
import {
  type LedgerEntry,
  adversarialPassed,
  appendLedgerEntry,
  workingTreePatchId,
} from "./review-ledger.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execp } from "./lens-exec.ts";

const execFileP = promisify(execFile);

/**
 * Write an adversarial-review entry to the review ledger. Fire-and-forget:
 * the caller does not await this; the function is safe to call on every
 * exit path of `runAdversarialLoop`.
 */
export function writeAdversarialLedgerEntry(
  result: DispatchResult,
  params: { workCwd?: string; branch?: string; head?: string; resolvedBranch?: string },
): void {
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
    // #1039 — resolve the head to a full 40-char SHA (the same rule the
    // lens writer applies: `git rev-parse --verify <head>^{commit}`).
    // The adversarial writer takes `head` for branch resolution; now it
    // also uses it (or HEAD) for the headSha field. An unresolvable head
    // leaves headSha undefined (omitted from the entry) — the write
    // succeeds without the field, matching the lens writer's behaviour.
    const headRef = params.head ?? "HEAD";
    let headSha: string | undefined;
    if (!headRef.startsWith("-")) {
      try {
        const { stdout } = await execFileP(
          "git",
          ["-C", c, "rev-parse", "--verify", "--quiet", `${headRef}^{commit}`],
          { maxBuffer: 8 * 1024 },
        );
        headSha = stdout.trim() || undefined;
      } catch (err) {
        trace(
          `adversarial: headSha resolution failed for ${headRef}: ${
            err instanceof Error ? err.message : String(err)
          } — no headSha stored`,
        );
        headSha = undefined;
      }
    }
    const entry: LedgerEntry = {
      branch,
      kind: "adversarial",
      patchId: computed.patchId,
      passed: adversarialPassed(result),
      at: Date.now(),
      detail: result.loopOutcome ?? "completed",
      ...(headSha ? { headSha } : {}),
    };
    await appendLedgerEntry(entry, execp, c);
  };
  write().catch((err) => trace(`adversarial: ledger write failed: ${(err as Error).message}`));
}

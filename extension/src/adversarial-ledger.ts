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

import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  type LedgerEntry,
  adversarialPassed,
  appendLedgerEntry,
  workingTreePatchId,
} from "./review-ledger.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

const execp = promisify(exec);

/**
 * Write an adversarial-review entry to the review ledger. Fire-and-forget:
 * the caller does not await this; the function is safe to call on every
 * exit path of `runAdversarialLoop`.
 */
export function writeAdversarialLedgerEntry(
  result: DispatchResult,
  params: { workCwd?: string; branch?: string },
): void {
  const write = async () => {
    const c = params.workCwd ?? process.cwd();
    let branch = params.branch;
    if (!branch) {
      try {
        const { stdout } = await execp("git rev-parse --abbrev-ref HEAD", {
          cwd: c,
          maxBuffer: 8 * 1024,
        });
        const head = stdout.trim();
        if (head && head !== "HEAD") branch = head; // detached HEAD → skip
      } catch {
        branch = undefined;
      }
    }
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
    const entry: LedgerEntry = {
      branch,
      kind: "adversarial",
      patchId: computed.patchId,
      passed: adversarialPassed(result),
      at: Date.now(),
      detail: result.loopOutcome ?? "completed",
    };
    await appendLedgerEntry(entry, execp, c);
  };
  write().catch((err) => trace(`adversarial: ledger write failed: ${(err as Error).message}`));
}

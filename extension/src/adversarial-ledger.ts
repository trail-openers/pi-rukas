/**
 * adversarial-ledger — the adversarial loop's review-ledger write, split
 * from adversarial.ts (AGENTS.md §12 file-size limit).
 *
 * #912. A completed adversarial review records a `{ branch, patchId, passed }`
 * entry so the merge guard (merge-guard.ts) can refuse an agent-run merge
 * with no passing review on file. Failure isolation: every fault here is
 * swallowed and traced — the loop's DispatchResult comes back byte-identical
 * whether the write ran or threw.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  type LedgerEntry,
  adversarialPassed,
  appendLedgerEntry,
  branchPatchId,
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
    // The patchId is the `git patch-id --stable` of the branch's diff against
    // its base. The base is `origin/main` when available (the normal case for
    // a feature branch), else `HEAD~1` (a standalone commit). The guard
    // re-derives the same id at merge time, so both sides compute it
    // identically.
    let patchId: string | undefined;
    try {
      const { stdout } = await execp(
        "git rev-parse --verify -q origin/main || git rev-parse HEAD~1",
        {
          cwd: c,
          maxBuffer: 8 * 1024,
        },
      );
      const baseRef = stdout.trim() || "HEAD~1";
      patchId = await branchPatchId(execp, c, "HEAD", baseRef);
    } catch (err) {
      trace(`adversarial: ledger patch-id failed: ${(err as Error).message}`);
      return;
    }
    if (!patchId) return;
    const entry: LedgerEntry = {
      branch,
      kind: "adversarial",
      patchId,
      passed: adversarialPassed(result),
      at: Date.now(),
      detail: result.loopOutcome ?? "completed",
    };
    await appendLedgerEntry(entry, execp, c);
  };
  write().catch((err) => trace(`adversarial: ledger write failed: ${(err as Error).message}`));
}

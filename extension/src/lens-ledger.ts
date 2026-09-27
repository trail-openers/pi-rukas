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

import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  type LedgerEntry,
  appendLedgerEntry,
  lensPassed,
  workingTreePatchId,
} from "./review-ledger.ts";
import { trace } from "./trace.ts";

const execp = promisify(exec);

/**
 * Write a lens-review entry to the review ledger. Fire-and-forget: the
 * caller does not await this; the function is safe to call after the
 * verdict is computed.
 */
export function writeLensLedgerEntry(
  verdict: string,
  threshold: string,
  cwd: string | undefined,
  branch?: string,
): void {
  const write = async () => {
    const c = cwd ?? process.cwd();
    let b = branch;
    if (!b) {
      try {
        const { stdout } = await execp("git rev-parse --abbrev-ref HEAD", {
          cwd: c,
          maxBuffer: 8 * 1024,
        });
        const head = stdout.trim();
        if (head && head !== "HEAD") b = head;
      } catch {
        b = undefined;
      }
    }
    if (!b) {
      trace("lens-review: ledger write skipped — no branch (detached head, no caller branch)");
      return;
    }
    // The shared working-tree patch id (review-ledger.ts). When untracked
    // files exist the entry is still written for the tracked content, but the
    // gap is traced — see the warning's wording in workingTreePatchId.
    const computed = await workingTreePatchId(execp, c);
    if (computed.warning) trace(`lens-review: ${computed.warning}`);
    if (!computed.patchId) return;
    const entry: LedgerEntry = {
      branch: b,
      kind: "lens",
      patchId: computed.patchId,
      passed: lensPassed(verdict, threshold),
      at: Date.now(),
      detail: verdict,
    };
    await appendLedgerEntry(entry, execp, c);
  };
  write().catch((err) => trace(`lens-review: ledger write failed: ${(err as Error).message}`));
}

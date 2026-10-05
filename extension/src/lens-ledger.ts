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
 *
 * #973 — the entry carries the round-cap rule's inputs: `hasCritical`
 * (whether the reviewed verdict carried a CRITICAL finding) and `headSha`
 * (the commit reviewed, resolved when a caller names the branch). The
 * `round` is added by `appendLedgerEntry` (`bumpLensRound`) against the
 * file's previous contents, so the writer does not read the ledger itself —
 * `bumpLensRound` in review-ledger.ts is the only read-and-write site of
 * the counter (the writer never touches it).
 */
export function writeLensLedgerEntry(
  verdict: string,
  threshold: string,
  cwd: string | undefined,
  branch?: string,
  hasCritical?: boolean,
  headSha?: string,
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
      ...(hasCritical !== undefined ? { hasCritical } : {}),
      ...(headSha ? { headSha } : {}),
    };
    await appendLedgerEntry(entry, execp, c);
  };
  write().catch((err) => trace(`lens-review: ledger write failed: ${(err as Error).message}`));
}

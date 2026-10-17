#!/usr/bin/env bun
/**
 * #1360 round 3 — the write is bound to the ref the CAPTURE resolved.
 *
 * The head and tree checks in `decideToolPathRow` both compare against
 * `currentHeadSha`, so on their own they accept a capture taken under ref A and
 * a write made while the checkout stands at ref B whenever A and B happen to
 * name the same commit. The row's patch id is then recomputed against a range
 * nobody reviewed. The fix re-resolves `binding.reviewedHeadRef` at write time
 * and refuses when it no longer names the head the row is written against.
 *
 * Split from `test-adversarial-ledger-range.ts` for the 500-line cap (the range
 * arms, the trunk arms and the exec-seam arm stay there).
 */

import { rmSync } from "node:fs";
import path from "node:path";
import {
  BINDING_REFUSAL_PREFIXES,
  honestBinding,
  setupRepo,
  sh,
  toolArm,
} from "./lib/adversarial-ledger-harness.ts";

// The three env pins, in the assignment form rather than `delete` (what
// sibling ledger tests use, which biome's noDelete rule refuses to accept even
// in smoke-tests/). Assigning "" is equivalent for every reader: the ledger
// override is read as `?.trim()` and the merge guard's override with
// `=== "1"`, so an empty value means "not set" to both.
process.env.PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE = "";
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = "";
process.env.PI_ENSEMBLE_FORGE = "github";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function startsWithBindingPrefix(detail: string | undefined): boolean {
  return (
    typeof detail === "string" &&
    BINDING_REFUSAL_PREFIXES.some((prefix) => detail.startsWith(`${prefix}: `))
  );
}

try {
  // ───── a capture made under ref A must not license a write at ref B
  {
    const { dir, mergeBase } = setupRepo();
    try {
      // The capture resolved `HEAD` while a SEPARATE worktree held the branch
      // ref. That worktree is then reset one commit back — an external move of
      // the ref the capture resolved, exactly the shape the loop cannot produce
      // for itself (a fix round re-points its head at `HEAD`, so an honest
      // round's captured ref always still names the head). The checkout under
      // test keeps its HEAD, tree and tip SHA exactly as recorded; only
      // re-resolving the captured ref sees the move. `--orphan` frees the branch
      // name so the second worktree can check it out.
      const worktree = path.join(path.dirname(dir), "stale-wt");
      sh(dir, "checkout", "-q", "--orphan", "detached-for-arm");
      sh(dir, "checkout", "-q", "--detach", "feature/x");
      sh(dir, "worktree", "add", "-q", worktree, "feature/x");
      sh(worktree, "reset", "--hard", "HEAD~1");
      const binding = await honestBinding(dir, mergeBase, "feature/x");
      const { row, reason } = await toolArm(dir, {
        base: mergeBase,
        // The writer resolves `HEAD` — what a re-pointed round would name —
        // while the capture's own ref now names a commit behind it.
        head: "HEAD",
        binding: binding as never,
      });
      assert(
        row.passed === false &&
          startsWithBindingPrefix(row.detail) &&
          (row.detail ?? "").startsWith("head-not-current"),
        `the captured ref no longer resolves to the write's head: NON-PASSING head-not-current (got passed=${row.passed}, detail=${JSON.stringify(row.detail)})`,
      );
      assert(
        (row.detail ?? "").includes("feature/x"),
        `the refusal names the captured ref it re-resolved (got ${JSON.stringify(row.detail)})`,
      );
      assert(
        reason.includes("head-not-current"),
        "captured ref refused: the guard quotes the detail",
      );
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ───── a captured ref that cannot be re-resolved → range-unverifiable
  // The write re-reads the capture's own ref, so a ref that has since been
  // deleted is a check that could not run — `range-unverifiable`, never a pass.
  {
    const { dir, mergeBase } = setupRepo();
    try {
      // Capture against a throwaway branch, then delete that ref before the
      // write. The tree and HEAD the head/tree checks compare are left exactly
      // as recorded, so only the ref re-resolution remains — and it must fail
      // as an unreadable check, not as a pass or a `head-*` refusal.
      const binding = await honestBinding(dir, mergeBase, "feature/x");
      sh(dir, "branch", "stale-captured-ref", "HEAD");
      sh(dir, "branch", "-D", "stale-captured-ref");
      const { row } = await toolArm(dir, {
        base: mergeBase,
        head: "HEAD",
        binding: { ...binding, reviewedHeadRef: "stale-captured-ref" } as never,
      });
      assert(
        row.passed === false &&
          startsWithBindingPrefix(row.detail) &&
          (row.detail ?? "").startsWith("range-unverifiable"),
        `captured ref deleted before the write: NON-PASSING range-unverifiable (got passed=${row.passed}, detail=${JSON.stringify(row.detail)})`,
      );
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ───── the captured ref still resolving to the head does NOT refuse
  // The counterpart, pinned so the new check cannot become "the captured ref is
  // always refused": an honest round captures `HEAD` and writes while `HEAD`
  // still resolves to the reviewed commit.
  {
    const { dir, mergeBase, tip } = setupRepo();
    try {
      const binding = await honestBinding(dir, mergeBase, "HEAD");
      const { row, block } = await toolArm(dir, {
        base: mergeBase,
        head: "HEAD",
        binding: binding as never,
      });
      assert(
        row.passed === true && row.reviewedHead === tip,
        `captured ref unchanged: still PASSING (got passed=${row.passed}, detail=${JSON.stringify(row.detail)})`,
      );
      assert(block === false, "captured ref unchanged: the guard accepts the row");
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }
} finally {
  // nothing global to restore — each arm owns its repo and its ledger
}

console.log(`\nexit ${exit}`);
process.exit(exit);

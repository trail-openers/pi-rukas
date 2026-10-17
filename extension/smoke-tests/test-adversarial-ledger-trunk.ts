#!/usr/bin/env bun
/**
 * #1360 lens 2 — a `trunk` mainline resolves through the whole binding, not
 * just through `headPrefix`.
 *
 * `test-adversarial-ledger-range.ts` builds every fixture on `main`, so the
 * non-main mainline path is exercised there only as far as the fixture reaches
 * (the harness's forge stub hardcodes `baseRefName: "main"`, which the merge
 * guard's `mergeIdentity` compares against the resolved mainline). This file
 * tests the three git-resolved seams directly — `identityBase`,
 * `reviewRangeDecision` and `decideToolPathRow` — against a real clone whose
 * trunk is named `trunk`, so a `develop`/`trunk` repo is proven to classify
 * correctly rather than assumed.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BINDING_REFUSAL_PREFIXES,
  type BindingDecision,
  decideToolPathRow,
  reviewRangeDecision,
} from "../src/adversarial-ledger-binding.ts";
import { execp } from "../src/exec.ts";
import { identityBase } from "../src/review-ledger-path.ts";
import { workingTreePatchId } from "../src/review-ledger.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const sh = (repo: string, ...argv: string[]) => {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  return execFileSync("git", ["-C", repo, ...argv], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
};

/** A clone whose trunk is `trunk` — not main, not master. */
function setupTrunkRepo(): { dir: string; mergeBase: string; tip: string; parent: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "adv-1360-trunk-"));
  const origin = path.join(root, "origin.git");
  const dir = path.join(root, "repo");
  sh(root, "init", "-q", "--bare", origin);
  sh(root, "clone", "-q", origin, dir);
  sh(dir, "config", "user.email", "t@t.t");
  sh(dir, "config", "user.name", "t");
  sh(dir, "checkout", "-qb", "trunk");
  writeFileSync(path.join(dir, "base.txt"), "base\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "base");
  sh(dir, "push", "-q", "origin", "trunk");
  sh(dir, "remote", "set-head", "origin", "trunk");
  const mergeBase = sh(dir, "rev-parse", "trunk");
  sh(dir, "checkout", "-qb", "feature/x", "trunk");
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "commit A");
  const parent = sh(dir, "rev-parse", "HEAD");
  writeFileSync(path.join(dir, "b.txt"), "b\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "commit B");
  const tip = sh(dir, "rev-parse", "HEAD");
  sh(dir, "push", "-q", "origin", "feature/x");
  return { dir, mergeBase, tip, parent };
}

/** Every refusal is a member of the exported vocabulary. */
const isBindingRefusal = (d: BindingDecision) =>
  typeof d.detail === "string" &&
  BINDING_REFUSAL_PREFIXES.some((p) => (d.detail as string).startsWith(`${p}: `));

const trunk = setupTrunkRepo();
try {
  // ───────────────────────────────── identityBase resolves the trunk by name
  const base = await identityBase(execp, trunk.dir);
  assert(
    base.ok === true && base.remote === "origin" && base.mainline === "trunk",
    `identityBase: a trunk-based repo resolves {remote: origin, mainline: trunk} (got ${JSON.stringify(base)})`,
  );
  if (!base.ok) {
    console.error("✗ identityBase failed — the arms below cannot run");
    process.exit(1);
  }

  // ─────────── the range check compares against <remote>/trunk, not origin/main
  const ok = await reviewRangeDecision(trunk.dir, trunk.mergeBase, "HEAD", base);
  assert(
    ok.ok === true && ok.reviewedBase === trunk.mergeBase && ok.reviewedHead === trunk.tip,
    `reviewRangeDecision: base = the trunk merge-base is a branch range (got ${JSON.stringify(ok)})`,
  );

  const narrowed = await reviewRangeDecision(trunk.dir, trunk.parent, "HEAD", base);
  assert(
    narrowed.ok === false && isBindingRefusal(narrowed),
    `reviewRangeDecision: a narrowed base is refused with a binding prefix (got ${JSON.stringify(narrowed)})`,
  );
  assert(
    (narrowed.detail ?? "").startsWith("range-not-branch: "),
    `reviewRangeDecision: the narrowed base on a trunk repo reads range-not-branch (got ${JSON.stringify(narrowed.detail)})`,
  );

  // A base AHEAD of the trunk tip is not the branch's merge-base — the reviewed
  // range reaches commits the branch does not have.
  const aheadBase = sh(trunk.dir, "rev-parse", "feature/x~1");
  const offTrunk = await reviewRangeDecision(trunk.dir, aheadBase, "HEAD", base);
  assert(
    offTrunk.ok === false && (offTrunk.detail ?? "").startsWith("range-not-branch: "),
    `reviewRangeDecision: a base that is not the branch's merge-base is refused (got ${JSON.stringify(offTrunk.detail)})`,
  );

  // ─────────── decideToolPathRow: the tip named `trunk` is not "not current"
  const patch = await workingTreePatchId(execp, trunk.dir);
  const current = await reviewRangeDecision(trunk.dir, trunk.mergeBase, "HEAD", base);
  assert(current.ok === true, "decideToolPathRow prelude: the honest range resolves");

  for (const named of ["HEAD", "trunk", "origin/trunk"] as const) {
    const d = await decideToolPathRow({
      workCwd: trunk.dir,
      baseRef: trunk.mergeBase,
      headRef: named,
      currentTreePatchId: patch.patchId ?? "",
      currentHeadSha: trunk.tip,
      mainline: base,
      binding: {
        reviewedBase: trunk.mergeBase,
        reviewedHead: trunk.tip,
        reviewedTreePatchId: patch.patchId,
        reviewedHeadRef: named,
        headAtCapture: trunk.tip,
      },
    });
    assert(
      d.ok === true && d.reviewedBase === trunk.mergeBase && d.reviewedHead === trunk.tip,
      `decideToolPathRow: head named \`${named}\` on a trunk repo PASSES with the verified range (got ${JSON.stringify(d)})`,
    );
  }

  // ─── a capture that recorded the tip (under any ref spelling) whose worktree
  // HEAD has since moved is `head-moved` — the review WAS of the tip, the tree
  // is no longer at it. `reviewedHeadRef` is what the capture read, and `HEAD`
  // is the spelling the loop uses for every round after a fix pass.
  const stale = await decideToolPathRow({
    workCwd: trunk.dir,
    baseRef: trunk.mergeBase,
    headRef: "HEAD",
    currentTreePatchId: patch.patchId ?? "",
    currentHeadSha: "f".repeat(40),
    mainline: base,
    binding: {
      reviewedBase: trunk.mergeBase,
      reviewedHead: trunk.tip,
      reviewedTreePatchId: patch.patchId,
      reviewedHeadRef: "HEAD",
      headAtCapture: trunk.tip,
    },
  });
  assert(
    stale.ok === false && (stale.detail ?? "").startsWith("head-moved: "),
    `decideToolPathRow: a capture of the tip whose workCwd HEAD moved is head-moved, not head-not-current (got ${JSON.stringify(stale.detail)})`,
  );

  // ─── the same shape named by the MAINLINE's own name: still `head-moved`
  // This is the case the hardcoded main/master list got wrong on a trunk repo.
  const staleNamedTrunk = await decideToolPathRow({
    workCwd: trunk.dir,
    baseRef: trunk.mergeBase,
    headRef: "HEAD",
    currentTreePatchId: patch.patchId ?? "",
    currentHeadSha: "f".repeat(40),
    mainline: base,
    binding: {
      reviewedBase: trunk.mergeBase,
      reviewedHead: trunk.tip,
      reviewedTreePatchId: patch.patchId,
      reviewedHeadRef: "trunk",
      headAtCapture: trunk.tip,
    },
  });
  assert(
    staleNamedTrunk.ok === false && (staleNamedTrunk.detail ?? "").startsWith("head-moved: "),
    `decideToolPathRow: a trunk repo naming the tip \`trunk\` is head-moved, not head-not-current (got ${JSON.stringify(staleNamedTrunk.detail)})`,
  );

  // ─── a capture that named a commit which is not the tip is `head-not-current`
  // Nothing moved in the caller's intent: the round reviewed a commit that was
  // never the tip, so the refusal must not claim the tip moved.
  const notCurrent = await decideToolPathRow({
    workCwd: trunk.dir,
    baseRef: trunk.mergeBase,
    headRef: "HEAD",
    currentTreePatchId: patch.patchId ?? "",
    currentHeadSha: "e".repeat(40),
    mainline: base,
    binding: {
      reviewedBase: trunk.mergeBase,
      reviewedHead: "a".repeat(40),
      reviewedTreePatchId: patch.patchId,
      // The capture recorded the head it reviewed under a ref that is neither
      // `HEAD` nor the mainline — a commit the caller named, not the tip.
      reviewedHeadRef: "some/other/branch",
      headAtCapture: "a".repeat(40),
    },
  });
  assert(
    notCurrent.ok === false && (notCurrent.detail ?? "").startsWith("head-not-current: "),
    `decideToolPathRow: a capture that named a non-tip head is head-not-current (got ${JSON.stringify(notCurrent.detail)})`,
  );

  // ─── the SHAs on the decision come from the VERIFIED range, not the capture
  // A capture that claims SHAs the range check did not confirm must not have
  // them echoed back on an ok decision (the writer stores what it was handed).
  const mismatched = await decideToolPathRow({
    workCwd: trunk.dir,
    baseRef: trunk.mergeBase,
    headRef: "HEAD",
    currentTreePatchId: patch.patchId ?? "",
    currentHeadSha: trunk.tip,
    mainline: base,
    binding: {
      reviewedBase: "9".repeat(40),
      reviewedHead: "8".repeat(40),
      reviewedTreePatchId: patch.patchId,
      reviewedHeadRef: "HEAD",
      headAtCapture: trunk.tip,
    },
  });
  assert(
    mismatched.ok === true &&
      mismatched.reviewedBase === trunk.mergeBase &&
      mismatched.reviewedHead === trunk.tip,
    `decideToolPathRow: a capture's own SHAs are NOT echoed — the decision carries the verified ones (got ${JSON.stringify(mismatched)})`,
  );
} finally {
  rmSync(path.dirname(trunk.dir), { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);

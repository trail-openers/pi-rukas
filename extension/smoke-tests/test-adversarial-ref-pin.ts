#!/usr/bin/env bun
/**
 * #1161 round 2 — the loop pins its refs and derives the ledger provenance.
 *
 * 1. The head ref moves AFTER the loop has resolved it: the reviewed diff and
 *    the ledger row still bind the commits resolved at loop entry.
 * 2. Provenance is derived inside the loop, not set by the caller: a pasted
 *    diff is `pasted`; base+head is `range` with the pinned SHAs; `diff: ""`
 *    with base+head is a range review (the loop's truthy check).
 * 3. A ref that does not resolve is an infra failure with a named reason,
 *    never a review, so no passing row can come from it.
 *
 * The real ledger writer runs on the captured result and params (the loop's
 * own write is captured, as in test-adversarial-range-binding.ts).
 */

import { mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/lens-exec.ts";
import { type RangeDiff, computeRangeDiff } from "../src/review-diff.ts";
import { readLedgerAt } from "../src/review-ledger.ts";
import { rangePatchId } from "../src/review-patch-id.ts";
import type { DispatchResult } from "../src/types.ts";
import { git, installLoopSeams, newRepo } from "./adversarial-loop-helpers.ts";
import {
  assert,
  exit,
  latestEntry,
  setupLedgerPath,
  teardownLedger,
} from "./merge-guard-helpers.ts";

const BRANCH = "feature/x";
const APPROVED = "VERDICT: APPROVED\n\nlooks good";

await installLoopSeams(async (spec) => ({
  role: spec.role,
  ok: true,
  text: APPROVED,
  toolUses: [],
  ms: 1,
  exitCode: 0,
}));

const realLedger = await import("../src/adversarial-ledger.ts");
const writeRealLedgerRow = realLedger.writeAdversarialLedgerEntry;
type LedgerParams = Parameters<typeof writeRealLedgerRow>[1];
const captured: Array<{ result: DispatchResult; params: LedgerParams }> = [];
mock.module(new URL("../src/adversarial-ledger.ts", import.meta.url).href, () => ({
  ...realLedger,
  writeAdversarialLedgerEntry: (result: DispatchResult, params: LedgerParams): Promise<void> => {
    captured.push({ result, params });
    return Promise.resolve();
  },
}));
const { runAdversarialLoop } = await import("../src/adversarial.ts");

const revParse = (dir: string, ref: string) => git(dir, "rev-parse", ref).toString().trim();
const signal = () => new AbortController().signal;
const reviewOpts = (repo: string) =>
  ({
    context: "ref pin",
    workCwd: repo,
    branch: BRANCH,
    reportOnly: true,
    reportVerdict: "terminal",
  }) as const;

const repo = newRepo("adv-1161-pin-");
try {
  // origin/main is the base; the branch carries two commits on top.
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(repo, "checkout", "-q", "-b", BRANCH);
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  writeFileSync(path.join(repo, "b.txt"), "b\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "second");
  const baseSha = revParse(repo, "origin/main");
  const originalHead = revParse(repo, BRANCH);
  await setupLedgerPath();

  // ------------------------------------------ 1. the head moves mid-review
  let moved = false;
  const movingRangeDiff = async (cwd: string, base: string, head: string): Promise<RangeDiff> => {
    if (!moved) {
      // The branch moves AFTER the loop resolved it: a third commit lands.
      moved = true;
      writeFileSync(path.join(repo, "c.txt"), "c\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "third, mid-review");
    }
    return computeRangeDiff(cwd, base, head);
  };
  await runAdversarialLoop(
    { ...reviewOpts(repo), base: "origin/main", head: BRANCH },
    signal(),
    "job-pin-moved",
    movingRangeDiff,
  );
  assert(revParse(repo, BRANCH) !== originalHead, "the branch really moved during the review");
  const moveCall = captured.at(-1);
  if (!moveCall) throw new Error("the loop wrote no ledger result");
  assert(
    moveCall.params.provenance?.kind === "range" &&
      moveCall.params.provenance.base === baseSha &&
      moveCall.params.provenance.head === originalHead,
    "head moved mid-review: the provenance pins the SHAs resolved at loop entry",
  );
  assert(moveCall.result.loopOutcome === "approved", "head moved mid-review: the review approves");
  await writeRealLedgerRow(moveCall.result, moveCall.params);
  const row = latestEntry(
    readLedgerAt(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE ?? ""),
    BRANCH,
    "adversarial",
  );
  assert(row?.headSha === originalHead, "head moved mid-review: the row binds the original head");
  const expected = await rangePatchId(execp, repo, baseSha, originalHead);
  assert(
    expected !== undefined && row?.patchId === expected,
    "head moved mid-review: the row's patch id is the original range's, not the moved head's",
  );

  // -------------------------------- 2. provenance is derived, never supplied
  captured.length = 0;
  await runAdversarialLoop(
    { ...reviewOpts(repo), diff: "diff --git a/x b/x\n+x\n", base: "origin/main", head: BRANCH },
    signal(),
    "job-pin-pasted",
  );
  assert(
    captured.at(-1)?.params.provenance?.kind === "pasted",
    "a pasted diff with base+head is pasted provenance (the string wins)",
  );

  captured.length = 0;
  await runAdversarialLoop(
    { ...reviewOpts(repo), diff: "", base: "origin/main", head: BRANCH },
    signal(),
    "job-pin-empty",
  );
  assert(
    captured.at(-1)?.params.provenance?.kind === "range",
    'diff: "" with base+head is a range review (the loop\'s truthy check)',
  );

  // ----------------------------------- 3. an unresolvable ref is not a review
  captured.length = 0;
  await runAdversarialLoop(
    { ...reviewOpts(repo), base: "origin/no-such-ref", head: BRANCH },
    signal(),
    "job-pin-missing",
  );
  const missing = captured.at(-1)?.result;
  assert(
    missing?.loopOutcome === "infra-failure" && missing.ok === false,
    "an unresolvable base is an infra failure, not a verdict",
  );
  assert(
    /base ref "origin\/no-such-ref" does not resolve/.test(missing?.text ?? ""),
    "an unresolvable base names the ref in the result",
  );

  captured.length = 0;
  await runAdversarialLoop(
    { ...reviewOpts(repo), base: "-x", head: BRANCH },
    signal(),
    "job-pin-dash",
  );
  const dash = captured.at(-1)?.result;
  assert(
    dash?.loopOutcome === "infra-failure" && /starts with '-'/.test(dash.text ?? ""),
    "a ref starting with '-' is refused as an infra failure",
  );
} finally {
  rmSync(repo, { recursive: true, force: true });
  teardownLedger();
}

console.log(`\nexit ${exit}`);
process.exit(exit);

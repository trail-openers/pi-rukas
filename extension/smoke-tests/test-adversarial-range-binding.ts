#!/usr/bin/env bun
/**
 * #1161 — a tool-computed range is bound to the diff the loop reviewed.
 *
 * On a two-commit branch, the reviewer approves the full `origin/main...HEAD`
 * range and then the narrowed `HEAD~1...HEAD` range (the last commit only).
 * Each loop result is written by the REAL writeAdversarialLedgerEntry into a
 * temp ledger (PI_ENSEMBLE_REVIEW_LEDGER_FILE). The merge guard is then driven
 * with the branch's real patch id, the one the guard computes (branchPatchId
 * over origin/<head>..origin/<base>, merge-guard.ts): the full review is
 * accepted, the narrowed review is refused as stale.
 */

import { mock } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/lens-exec.ts";
import { branchPatchId, readLedgerAt } from "../src/review-ledger.ts";
import type { DispatchResult } from "../src/types.ts";
import { git, installLoopSeams, newRepo } from "./adversarial-loop-helpers.ts";
import {
  assert,
  exit,
  hookDecision,
  latestEntry,
  setupLedgerPath,
  teardownLedger,
} from "./merge-guard-helpers.ts";
import type { LedgerEntry } from "./merge-guard-helpers.ts";

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

// The loop's own ledger write is captured, not run: the row under test is
// written explicitly below by the real writer, from the same result and params.
const realLedger = await import("../src/adversarial-ledger.ts");
// Kept as a value: bun's mock.module rebinds the namespace object in place.
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

const repo = newRepo("adv-1161-range-");
let guardPatch: string | undefined;
try {
  // origin/main is the base commit; the branch carries two commits on top.
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(repo, "checkout", "-q", "-b", BRANCH);
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  writeFileSync(path.join(repo, "b.txt"), "b\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "second");
  git(repo, "update-ref", "refs/remotes/origin/feature/x", "HEAD");

  // The patch id the guard recomputes for the whole branch (merge-guard.ts).
  guardPatch = await branchPatchId(execp, repo, "origin/feature/x", "origin/main");
  if (!guardPatch) throw new Error("could not compute the branch's guard patch id");

  const signal = new AbortController().signal;
  const loopArgs = {
    context: "range binding",
    workCwd: repo,
    branch: BRANCH,
    reportOnly: true,
    reportVerdict: "terminal",
  } as const;
  await runAdversarialLoop({ ...loopArgs, base: "origin/main", head: "HEAD" }, signal, "job-full");
  await runAdversarialLoop({ ...loopArgs, base: "HEAD~1", head: "HEAD" }, signal, "job-narrow");
  if (captured.length !== 2) throw new Error(`expected 2 loop results, got ${captured.length}`);

  const recordedRow = async (i: number): Promise<LedgerEntry> => {
    const w = captured[i];
    if (!w) throw new Error(`no captured loop result at ${i}`);
    await writeRealLedgerRow(w.result, w.params);
    const row = latestEntry(
      readLedgerAt(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE ?? ""),
      BRANCH,
      "adversarial",
    );
    if (!row) throw new Error("the real writer recorded no adversarial row");
    return row;
  };
  const lens: LedgerEntry = {
    branch: BRANCH,
    kind: "lens",
    patchId: guardPatch,
    passed: true,
    detail: "APPROVED",
    hasCritical: false,
    round: 1,
    at: 2,
  };

  await setupLedgerPath();
  const full = await recordedRow(0);
  assert(
    full.patchId === guardPatch,
    "full origin/main...HEAD review: the row's patch id is the branch's guard patch id",
  );
  const fullDecision = await hookDecision("gh pr merge 12", [full, lens], {
    patchId: guardPatch,
  });
  assert(fullDecision.block === false, "full origin/main...HEAD review: merge allowed");

  const narrowed = await recordedRow(1);
  assert(
    narrowed.patchId !== guardPatch,
    "narrowed HEAD~1...HEAD review: the row's patch id is not the branch's guard patch id",
  );
  const narrowDecision = await hookDecision("gh pr merge 12", [narrowed, lens], {
    patchId: guardPatch,
  });
  assert(narrowDecision.block === true, "narrowed HEAD~1...HEAD review: merge refused");
  assert(
    narrowDecision.reason?.includes("adversarial review is stale") === true,
    "narrowed HEAD~1...HEAD review: refused for the patch-id mismatch, not another gate",
  );
} finally {
  rmSync(repo, { recursive: true, force: true });
  teardownLedger();
}

console.log(`\nexit ${exit}`);
process.exit(exit);

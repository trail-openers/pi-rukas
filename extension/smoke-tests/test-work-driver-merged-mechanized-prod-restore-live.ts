#!/usr/bin/env bun
/**
 * LIVE test — #476 production-shape restoration when verifyExecFn is absent.
 *
 * The offline suite (test-work-driver-merged-mechanized.ts) covers the same
 * restoration flow with an injected recording fake. This live sibling is
 * the one place the driver's literal production shape is observed:
 * `verifyExecFn` is OMITTED from the context, so both the mechanized merge
 * and the restoration block resolve their executor via
 * `ctx.verifyExecFn ?? execp` — the real shell executor.
 *
 * Setup (local git + two read-only `gh` queries against the clone's remote):
 *   1. Shallow-clone the real repo.
 *   2. Create the cycle's feature branch with a divergent commit and check
 *      it out — the checkout state a real merge leaves behind.
 *   3. Point `refs/remotes/origin/<branch>` at the feature branch (a
 *      no-network stand-in for `git push -u`) so detectMainline and
 *      restoreCheckout resolve the mainline via `git symbolic-ref`
 *      without any network call.
 *   4. Drive runMerged with `verifyExecFn` OMITTED. prNumber is the PR for
 *      the commit being run from (always MERGED — we're on its branch), so
 *      `gh pr view` short-circuits the merge and
 *      `mergeSucceeded=true` triggers the restoration block, which then
 *      runs REAL `git fetch origin --prune` (local clone, no network) and
 *      REAL `git branch -d` on the divergent local branch.
 *
 * Assertions:
 *   - status='merged' + `merged` event (mechanized merge completed via the
 *     real-executor fallback).
 *   - The checkout moved from the feature branch back to main —
 *     restoreCheckout was reached through the real executor.
 *   - `git branch -d` was REFUSED (branch has a commit main does not) and
 *     the refusal landed in a `Checkout restoration` plumb-report with the
 *     local branch left in place — the deliberate no-`-D` policy.
 *
 * Requires: git + gh + network access to the remote (clone + PR lookup).
 * No real Pi spawn.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runMerged } from "../src/work-driver-merged.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function mkPi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

// Run from the repo root; the clone source is the live remote.
const repoRoot = process.cwd();
const remote = execSync("git config --get remote.origin.url", {
  cwd: repoRoot,
  stdio: "pipe",
})
  .toString()
  .trim();
const runningFromBranch = execSync("git rev-parse --abbrev-ref HEAD", {
  cwd: repoRoot,
  stdio: "pipe",
})
  .toString()
  .trim();
const runningFromSha = execSync("git rev-parse HEAD", {
  cwd: repoRoot,
  stdio: "pipe",
})
  .toString()
  .trim();
// The PR for the commit we're running from is always merged — we're on
// its branch. This is what lets the mechanized merge short-circuit.
const prNumber = Number(
  execSync(`gh pr view ${runningFromSha} --json number --jq .number`, {
    cwd: repoRoot,
    stdio: "pipe",
  })
    .toString()
    .trim(),
);

const dir = mkdtempSync(path.join(tmpdir(), "mm-prod-restore-live-"));
try {
  // Shallow clone of the mainline — network. Everything after this is local.
  execSync(`git clone --depth 1 -q ${remote} repo`, { cwd: dir, timeout: 30_000 });
  const repoDir = path.join(dir, "repo");
  const git = (cmd: string) =>
    execSync(`git ${cmd}`, { cwd: repoDir, stdio: "pipe" }).toString().trim();

  const mainline = git("rev-parse --abbrev-ref --symbolic-full-name @{u}");
  // Point origin/<mainline> at the cloned HEAD so detectMainline resolves
  // via `git symbolic-ref refs/remotes/origin/HEAD` — no network.
  git("update-ref refs/remotes/" + mainline + " " + git("rev-parse HEAD"));
  git("symbolic-ref refs/remotes/origin/HEAD refs/remotes/" + mainline);

  // The cycle's feature branch: a divergent commit, checked out — the
  // checkout state a real merge leaves behind.
  const featureBranch = "feature/issue-476-live";
  git("checkout -qb " + featureBranch);
  git("commit -q --allow-empty -m feature");
  // Stand-in for `git push -u origin <branch>` (no network).
  git("update-ref refs/remotes/" + featureBranch + " " + git("rev-parse HEAD"));

  const s = initialState(476, 1_000_000);
  (s as unknown as { pipelineState: Record<string, unknown> }).pipelineState = {
    ...s.pipelineState,
    currentStep: "merged",
    lastCompletedStep: "ci",
    branchName: featureBranch,
    prNumber,
  };
  const state = s as WorkState;

  const ctx: DriverContext = {
    repoRoot: repoDir,
    issue: 476,
    pi: mkPi(),
    // CRITICAL: `verifyExecFn` is deliberately NOT set — production shape,
    // so runMerged must resolve its executor via `?? execp`.
    //
    // mergeGrant answers the merge-authority gate the way `/work N --merge`
    // would (the policy judge is unreachable in a smoke test).
    mergeGrant: true,
    issueBodyFetcherFn: async () => ({
      stdout: "title:\ttest #476\nstate:\tOPEN\n\nbody",
    }),
  } as DriverContext;

  const result = await runMerged(ctx, state, Date.now());

  assert(
    result.pipelineState.status === "merged",
    "#476 live: mechanized merge succeeded → status='merged' (verifyExecFn absent)",
  );
  const mergedEv = result.eventLog.find((e) => e.kind === "merged");
  assert(mergedEv?.kind === "merged", "#476 live: merged event emitted");

  // The restoration ran through the real executor: repoRoot moved from the
  // feature branch back to the mainline.
  const headAfter = git("rev-parse --abbrev-ref HEAD");
  assert(
    headAfter === mainline,
    `#476 live: restoration moved the checkout from feature branch to mainline (HEAD=${headAfter})`,
  );

  // branch -d refused (divergent commit — the live stand-in for the
  // squash-merge SHA mismatch) and the refusal is a plumb-report note,
  // not a halt — the deliberate no-`-D` policy.
  const notes = result.eventLog.filter(
    (e) => e.kind === "plumb-report" && /Checkout restoration: .*branch -d/.test(e.body),
  );
  assert(
    notes.length >= 1,
    "#476 live: branch -d refusal emitted as a plumb-report note (restoration reached)",
  );
  assert(
    git("branch --list " + featureBranch)
      .trim()
      .includes(featureBranch),
    "#476 live: branch -d refusal left the local branch in place (no -D escalation)",
  );
} catch (err) {
  // Environment failure (no network / no remote / no gh) — fail loudly:
  // a live test that silently skips has already burned the clone budget.
  console.error(`✗ live: environment failure: ${(err as Error).message?.slice(0, 200)}`);
  exit = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);

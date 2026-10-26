#!/usr/bin/env bun
/**
 * The `merged` step end-to-end, driven through `runWorkDriver` (issue #323).
 *
 * Split out of test-work-driver-merged-mechanized.ts, which holds the unit
 * tests for the same subsystem (deriveMergeMethod, executeAndVerifyMerge,
 * mechanizedMerge, restoreCheckout) and hit the 500-line cap (AGENTS.md §12).
 * These three cover the whole flow instead: mechanized merge + checkout
 * restoration, the LLM-ops fallback path, and crash-resume idempotency.
 *
 * Since #380 every one of them has to pass the merge gate, so each grants
 * authority the way `/work N --merge` does and answers `gh` green. The gate
 * itself — including the no-grant refusal — lives in test-merge-authority.ts
 * and test-work-driver-pr10-core.ts. No real Pi spawn; all calls are mocked.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { type WorkState, initialState, readState, writeState } from "../src/workflow-state.ts";
import { setupSpawnGuard } from "./test-helpers.ts";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "ops",
    ok: true,
    text: "",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    ...overrides,
  } as DispatchResult;
}

function mkPi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

function mkCtx(
  issue: number,
  exec: VerifyExecFn,
  opts: { dispatchFn?: DriverContext["dispatchFn"]; repoRoot: string },
): DriverContext {
  return {
    repoRoot: opts.repoRoot,
    issue,
    host: mkPi(),
    verifyExecFn: exec,
    mergeGrant: true, // #380 — granted the way `/work N --merge` would
    issueBodyFetcherFn: async () => ({ stdout: `title:\ttest #${issue}\nstate:\tOPEN\n\nbody` }),
    ...(opts.dispatchFn ? { dispatchFn: opts.dispatchFn } : {}),
  } as DriverContext;
}

function mkState(issue: number, pr: number, branch: string): WorkState {
  const s = initialState(issue, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "merged",
      lastCompletedStep: "ci",
      branchName: branch,
      prNumber: pr,
    },
  } as WorkState;
}

/** #1533 — the head these fixtures review and pin. */
const VERIFIED_HEAD = "1".repeat(39) + "a";
/** #1533 — the reviewed patch identity the adversarial ledger row carries. */
const REVIEWED_PATCH = "2".repeat(39) + "b";

/** #1533 — the merge base the fixture's identity reads resolve to. */
const MERGE_BASE = "3".repeat(39) + "c";

/**
 * The ledger row the merged step's identity check looks for: the latest LENS row
 * on the cycle's branch, whose `headSha` is the head this fixture reviews and
 * whose `patchId` is what the fixture's `git patch-id` answers. The check reads
 * the LENS row rather than the adversarial one because the six-pass review is the
 * driver's own review of this branch — an adversarial row is written by a gate that
 * runs pre-commit on a worktree diff, and on the first cut the merged step compared
 * the verified head with itself and merged unreviewed content while an adversarial
 * row said everything was fine. Without a lens row the merged step refuses to merge
 * (no row means nobody reviewed this head), which is the #1533 behaviour, not a
 * fixture these older cases were written against.
 */
function seedReviewLedger(dir: string, branch: string): void {
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  writeFileSync(
    path.join(dir, ".git", "review-ledger.json"),
    JSON.stringify({
      entries: [
        {
          branch,
          kind: "lens",
          patchId: REVIEWED_PATCH,
          headSha: VERIFIED_HEAD,
          passed: true,
          at: 1,
          round: 1,
          hasCritical: false,
        },
      ],
    }),
  );
}

/**
 * #380 — answer the merge gate's evidence probe green. The gate itself is
 * covered by test-merge-authority.ts.
 *
 * Matches on the merge gate's specific 3-field JSON (`mergeStateStatus,mergeable,state`)
 * so it does NOT intercept the forge adapter's `prView` call, which requests
 * a much wider field list that also happens to include `mergeStateStatus`.
 */
function mergeGateGreen(cmd: string): { stdout: string } | undefined {
  if (cmd.includes("mergeStateStatus,mergeable,state"))
    return { stdout: '{"mergeStateStatus":"CLEAN","state":"OPEN","headRefOid":"' + VERIFIED_HEAD + '"}' };
  if (cmd.includes("gh pr checks"))
    return { stdout: '[{"name":"ci","bucket":"pass"}]' };
  return undefined;
}

function mkExecFull(
  calls: string[],
  branch: string,
  throwFirstView: boolean,
  dir?: string,
): VerifyExecFn {
  let vc = 0;
  return async (cmd: string, opts?: { argv?: string[] }) => {
    const line = opts?.argv ? [cmd, ...opts.argv].join(" ") : cmd;
    calls.push(line);
    const green = mergeGateGreen(line);
    if (green) return green;
    if (line.includes("gh pr view")) {
      vc++;
      if (throwFirstView && vc === 1)
        return Promise.reject(Object.assign(new Error("not merged"), { stderr: "not merged" }));
      return { stdout: "MERGED\n" };
    }
    if (cmd.includes("gh pr merge")) return { stdout: "Merged" };
    if (cmd.includes("gh repo view"))
      return { stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}' };
    // The visibility seam's one question, answered the way the headless fixture
    // does: `false` = public. Without it the merge-subject hygiene check's
    // `gh api` read was unmocked, its catch-all returned an empty string, and
    // T18 fell through to the LLM-ops fallback — which is why the mechanized
    // assertions below read as restoration failures rather than as what
    // actually broke.
    if (cmd === "gh" && opts?.argv?.[0] === "api") return { stdout: "false\n" };
    if (cmd.includes("git symbolic-ref")) return { stdout: "origin/main\n" };
    if (line.includes("git config --get remote.")) return { stdout: "https://x.invalid/r.git\n" };
    if (line.includes("git fetch origin")) return { stdout: "" };
    if (line.startsWith("git fetch")) return { stdout: "" };
    if (line.includes("git rev-parse origin/") || /git rev-parse .*origin\//.test(line))
      return { stdout: `${VERIFIED_HEAD}\n` };
    if (line.includes("git rev-parse --git-common-dir")) return { stdout: `${dir}/.git\n` };
    if (line.includes("git merge-base")) return { stdout: `${MERGE_BASE}\n` };
    if (line.includes("git patch-id")) return { stdout: `${REVIEWED_PATCH} x\n` };
    if (line.includes("git rev-parse"))
      return { stdout: /refs?\/|remotes\//.test(line) ? `${VERIFIED_HEAD}\n` : `${branch}\n` };
    return { stdout: "" };
  };
}

// T18. Full mechanized merge + restoration.
{
  const dir = mkdtempSync(path.join(tmpdir(), "wd-full-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    seedReviewLedger(dir, "feature/issue-960");
    await writeState(dir, mkState(960, 9601, "feature/issue-960"));
    const calls: string[] = [];
    await runWorkDriver(
      mkCtx(960, mkExecFull(calls, "feature/issue-960", true, dir), {
        repoRoot: dir,
        dispatchFn: async () => mkResult({ role: "driver", text: "Mechanized merge succeeded." }),
      }),
    );
    const after = await readState(dir, 960);
    assert(after?.pipelineState.status === "merged", "T18: status='merged'");
    const ev = (after?.eventLog ?? []).find((e: any) => e.kind === "merged");
    assert(ev?.kind === "merged" && ev.prNumber === 9601, "T18: merged event has PR number");
    assert(ev?.mergeCommit === undefined, "T18: mergeCommit undefined for mechanized path");
    const hasRestoration =
      calls.some((c) => c.includes("git fetch origin --prune")) &&
      calls.some((c) => c.includes("git checkout")) &&
      calls.some((c) => c.includes("git pull --ff-only"));
    assert(hasRestoration, "T18: restoration (fetch+checkout+pull) executed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// T19. Fallback dispatch carries mergeMethod into prompt.
{
  const dir = mkdtempSync(path.join(tmpdir(), "wd-fallback-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    seedReviewLedger(dir, "feature/issue-961");
    await writeState(dir, mkState(961, 9611, "feature/issue-961"));
    let capturedPrompt = "";
    // #393 — the knob that forced the LLM path is gone, so the fallback is
    // reached the only way that remains: mechanization genuinely fails.
    // `gh repo view` returns nothing here, so deriveMergeMethod cannot resolve
    // a method and falls back — which is the real production trigger.
    const exec: VerifyExecFn = async (cmd, opts) => {
      const line = opts?.argv ? [cmd, ...opts.argv].join(" ") : cmd;
      // method and falls back — which is the real production trigger.
      if (cmd.includes("gh repo view")) return { stdout: "" };
      if (cmd === "gh" && opts?.argv?.[0] === "api") return { stdout: "false\n" };
      const green = mergeGateGreen(line);
      if (green) return green;
      // #1533 — the identity check runs before the mechanized merge, so the
      // fallback case needs the same reads answered as any merging cycle.
      if (line.includes("git config --get remote.")) return { stdout: "https://x.invalid/r.git\n" };
      if (line.includes("git fetch origin")) return { stdout: "" };
      if (line.includes("git rev-parse origin/")) return { stdout: `${VERIFIED_HEAD}\n` };
      if (line.includes("git rev-parse --git-common-dir")) return { stdout: `${dir}/.git\n` };
      if (line.includes("git symbolic-ref")) return { stdout: "origin/main\n" };
      if (line.includes("git merge-base")) return { stdout: `${MERGE_BASE}\n` };
      if (line.includes("git patch-id")) return { stdout: `${REVIEWED_PATCH} x\n` };
      if (line.includes("git rev-parse"))
        return { stdout: /refs?\/|remotes\//.test(line) ? `${VERIFIED_HEAD}\n` : "" };
      return { stdout: "" };
    };
    await runWorkDriver(
      mkCtx(961, exec, {
        repoRoot: dir,
        dispatchFn: async (_pi, spec, opts) => {
          if (opts?.label !== "ops:merge") throw new Error(`unexpected: ${opts?.label}`);
          capturedPrompt = spec.prompt;
          return mkResult({
            role: "ops",
            text: "PR merged.\nmerge-commit: def1234567\n",
          });
        },
      }),
    );
    assert(
      capturedPrompt.includes("--squash --delete-branch"),
      "T19: prompt carries squash as default hint when mechanized ops disabled",
    );
    assert(!/adjust the flags/i.test(capturedPrompt), "T19: no escape clause in prompt");
    const after = await readState(dir, 961);
    assert(after?.pipelineState.status === "merged", "T19: status='merged' after LLM ops fallback");
    const ev = (after?.eventLog ?? []).find((e: any) => e.kind === "merged");
    assert(
      ev?.kind === "merged" && ev.mergeCommit === "def1234567",
      "T19: mergeCommit captured from ops merge-commit marker",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// T20. Already-merged idempotent on resume.
{
  const dir = mkdtempSync(path.join(tmpdir(), "wd-idem-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    seedReviewLedger(dir, "feature/issue-962");
    await writeState(dir, mkState(962, 9621, "feature/issue-962"));
    const calls: string[] = [];
    await runWorkDriver(
      mkCtx(962, mkExecFull(calls, "feature/issue-962", false, dir), {
        repoRoot: dir,
        dispatchFn: async () => mkResult({ role: "driver", text: "Mechanized merge succeeded." }),
      }),
    );
    const after = await readState(dir, 962);
    assert(
      after?.pipelineState.status === "merged",
      "T20: idempotent status='merged' when PR already merged",
    );
    assert(
      !calls.some((c) => c.includes("gh pr merge")),
      "T20: gh pr merge NOT called (short-circuited)",
    );
    assert(
      calls.some((c) => c.includes("git fetch")),
      "T20: restoration runs even when merge short-circuits",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);

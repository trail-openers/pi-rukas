#!/usr/bin/env bun
/**
 * The lens round cap must not park work that is merge-worthy.
 *
 * Measured: two of six outcomes in one overnight run died here. Both
 * `.pi/work-state/457.json` and `680.json` show the same tail —
 * `lens-issues-found` → `cap-hit{cap:"round-cap"}` → `handoff`. A human then
 * judged #457 merge-as-is, and #680's PR merged unchanged. The cap parked work
 * that was fine, and each park cost a re-run plus operator time.
 *
 * So a round cap whose verdict is `ISSUES_FOUND` — never
 * `CRITICAL_ISSUES_FOUND` — and whose adversarial gate approved routes to `ci`
 * instead, after posting the residual findings to the PR. Merge authority is
 * untouched: it is operator-granted, citation-verified and default-deny, so this
 * decides where the cycle goes, never whether it may merge.
 *
 * Everything here drives the REAL `runLens` over a real git repository and reads
 * the log it produces. A previous canary in this repo passed pre-fix because it
 * fed `nextStep` a hand-built state instead of exercising what the code emits;
 * `nextStep` is a pure function of state, so a fabricated event proves nothing
 * about the emission, which is where every one of these defects has lived.
 */

import { exec, execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { nextStep } from "../src/work-driver-context.ts";
import { runLens } from "../src/work-driver-lens.ts";
import { heldByUnresolvedReview } from "../src/work-driver-merge-authority.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import { mkLensSummary, setupSpawnGuard } from "./test-helpers.ts";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
// #533 — nextStep returns a discriminated result; unwrap for comparisons.
function stepOf(s: WorkState): string {
  const d = nextStep(s);
  return d.kind === "step" ? d.step : d.kind;
}

const execFileP = promisify(execFile);
const execP = promisify(exec);

const FINDINGS = [
  { lens: "SIMPLICITY", severity: "MEDIUM", path: "a.txt", line: 1, title: "duplicated guard" },
  { lens: "ARCHITECTURE", severity: "LOW", path: "a.txt", line: 2, title: "naming drift" },
];

const WALL_CLOCK_EXCEEDED_AT = Date.now() - 91 * 60 * 1000;

/**
 * A repo with an origin, a base commit and a feature branch carrying one real
 * commit — so the integrated diff is non-empty and `runLens` reaches its verdict
 * block instead of short-circuiting on the empty-diff guard.
 *
 * A stub `vipune` goes on the front of PATH: `runLens` persists findings as
 * candidate memories, and a smoke test must never write to the developer's real
 * memory store. The stub exits non-zero, which the driver already treats as
 * non-fatal.
 */
async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ens-roundcap-"));
  const origPath = process.env.PATH;
  try {
    const origin = path.join(root, "origin.git");
    const repo = path.join(root, "repo");
    const stubs = path.join(root, "stubs");
    const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
    mkdirSync(stubs, { recursive: true });
    const stub = path.join(stubs, "vipune");
    writeFileSync(stub, "#!/bin/sh\nexit 1\n");
    chmodSync(stub, 0o755);
    process.env.PATH = `${stubs}${path.delimiter}${origPath ?? ""}`;
    await execFileP("git", ["init", "--bare", "--initial-branch=main", origin]);
    await execFileP("git", ["init", "--initial-branch=main", repo]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "T"]);
    writeFileSync(path.join(repo, "a.txt"), "base\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "base"]);
    await git(repo, ["remote", "add", "origin", origin]);
    await git(repo, ["push", "-q", "-u", "origin", "main"]);
    await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await git(repo, ["checkout", "-q", "-b", "feature/issue-901"]);
    writeFileSync(path.join(repo, "a.txt"), "changed\n");
    await git(repo, ["commit", "-qam", "work"]);
    await git(repo, ["push", "-q", "-u", "origin", "feature/issue-901"]);
    await git(repo, ["checkout", "-q", "main"]);
    await fn(repo);
  } finally {
    process.env.PATH = origPath;
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * A driver context whose `gh` calls are captured rather than executed; every
 * other command (all of them git) runs for real, because the diff, the evidence
 * and the claim scan are what make this an end-to-end exercise.
 */
function mkCtx(repo: string, verdict: string, ghCalls: string[]) {
  return {
    repoRoot: repo,
    issue: 901,
    lensReviewFn: async () =>
      mkLensSummary({
        verdict: verdict as "ISSUES_FOUND",
        findings: FINDINGS,
        totalFindings: FINDINGS.length,
      }),
    verifyExecFn: async (cmd: string, opts?: Record<string, unknown>) => {
      if (/^gh\b/.test(cmd)) {
        ghCalls.push(cmd);
        return { stdout: "https://example.test/pull/1#issuecomment-1\n" };
      }
      return execP(cmd, opts);
    },
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
  } as any;
}

/** A cycle about to run a lens round, with a PR already open. */
const stateAt = (roundsDone: number, capStartedAt?: number): WorkState =>
  ({
    issue: 901,
    eventLog: [{ kind: "adversarial-approved", at: 1, jobId: "adv", round: 1 }] as WorkEvent[],
    pipelineState: {
      currentStep: "lens-review",
      lastCompletedStep: "adversarial",
      status: "running",
      reviewRound: roundsDone,
      reviewCapStartedAt: capStartedAt,
      branchName: "feature/issue-901",
      prNumber: 1,
      worktrees: {},
      plumbReports: [],
    },
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
  }) as any;

const capOf = (s: WorkState) => {
  const e = [...s.eventLog].reverse().find((x) => x.kind === "cap-hit");
  return e?.kind === "cap-hit" ? e : undefined;
};

// ---------------------------------------------------------------- the canary
//
// Three rounds of ISSUES_FOUND with the adversarial gate approved. Pre-fix this
// emits cap-hit{round-cap, nextStep:"handoff"} and parks; the whole point of the
// change is that it routes to `ci`.

await withRepo(async (repo) => {
  const ghCalls: string[] = [];
  const after = await runLens(mkCtx(repo, "ISSUES_FOUND", ghCalls), stateAt(2), Date.now());
  const cap = capOf(after);
  assert(
    cap?.cap === "round-cap",
    `the round cap still fires and is still named (got ${cap?.cap})`,
  );
  assert(
    stepOf(after) === "ci",
    `canary: a round-capped ISSUES_FOUND with adversarial approved routes to ci (got ${stepOf(after)}) — it parked two of six overnight outcomes`,
  );
  assert(
    ghCalls.some((c) => /^gh pr comment 1\b/.test(c)),
    `canary: and the residual findings are posted to the PR first (gh calls: ${JSON.stringify(ghCalls)}) — carrying three rounds of unresolved findings into CI silently is worse than a park`,
  );
});

// ------------------------------------------------------------- invariant #1
//
// CRITICAL_ISSUES_FOUND still parks. This must hold BOTH before and after the
// change — it is what catches an over-broad fix that routes every capped review
// onward.

await withRepo(async (repo) => {
  const ghCalls: string[] = [];
  const after = await runLens(
    mkCtx(repo, "CRITICAL_ISSUES_FOUND", ghCalls),
    stateAt(2),
    Date.now(),
  );
  assert(
    capOf(after)?.cap === "round-cap" && stepOf(after) === "handoff",
    `invariant: a CRITICAL_ISSUES_FOUND tail still parks at handoff (got ${stepOf(after)})`,
  );
  assert(
    ghCalls.length === 0,
    `invariant: and nothing was posted to the PR for it (gh calls: ${JSON.stringify(ghCalls)})`,
  );
});

// ------------------------------------------------------------- invariant #2
//
// The wall-clock cap still parks. A review that ran too long is a different
// signal from one that ran out of rounds, and only the round cap moved.

await withRepo(async (repo) => {
  const ghCalls: string[] = [];
  const after = await runLens(
    mkCtx(repo, "ISSUES_FOUND", ghCalls),
    stateAt(0, WALL_CLOCK_EXCEEDED_AT),
    Date.now(),
  );
  assert(
    capOf(after)?.cap === "wall-clock" && stepOf(after) === "handoff",
    `invariant: the wall-clock cap still parks (cap ${capOf(after)?.cap}, next ${stepOf(after)})`,
  );
});

// ---------------------------------------------------------------- canary #2
//
// BOTH caps at once — the case the invariant above cannot reach. It exercises
// the wall-clock cap at round 0, where the round-cap branch never runs; but the
// round-cap branch RETURNS, so a review that had ALSO blown its time budget
// took the round-cap exit and routed to `ci`. The stricter cap silently lost to
// the looser one, in exactly the state the wall-clock cap exists for.

await withRepo(async (repo) => {
  const ghCalls: string[] = [];
  const after = await runLens(
    mkCtx(repo, "ISSUES_FOUND", ghCalls),
    stateAt(2, WALL_CLOCK_EXCEEDED_AT),
    Date.now(),
  );
  assert(
    stepOf(after) === "handoff",
    `canary: round cap AND wall-clock exceeded parks — it does not route to ci (next ${stepOf(after)})`,
  );
});

// --------------------------------------------------- invariant #3 + a canary
//
// Disclosure is the condition, not a courtesy: when the findings cannot reach
// the PR the cycle parks rather than carrying them into CI unseen. The park
// itself is the invariant — it held pre-fix, when everything parked — so it is
// the recorded REASON that is the canary here.

await withRepo(async (repo) => {
  const ghCalls: string[] = [];
  const ctx = mkCtx(repo, "ISSUES_FOUND", ghCalls);
  ctx.verifyExecFn = async (cmd: string, opts?: Record<string, unknown>) => {
    if (/^gh\b/.test(cmd)) throw new Error("gh: not authenticated");
    return execP(cmd, opts);
  };
  const after = await runLens(ctx, stateAt(2), Date.now());
  assert(
    stepOf(after) === "handoff",
    `invariant: an undisclosed residual parks instead of routing to ci (got ${stepOf(after)})`,
  );
  assert(
    after.eventLog.some((e) => e.kind === "plumb-report" && /could not post/.test(e.body)),
    "canary: ...and records why, so the park is not mistaken for a review that failed to converge",
  );
});

// ------------------------------------------------------------- invariant #4
//
// Routing to `ci` reaches the merge-authority gate; it does not bypass it. The
// gate is default-deny and reads an operator grant, so the routing change can
// never be the thing that merges a PR.

{
  const { readFileSync } = await import("node:fs");
  const merged = readFileSync(
    path.join(import.meta.dirname, "..", "src", "work-driver-merged.ts"),
    "utf8",
  );
  assert(
    /resolveMergeAuthority\(/.test(merged) && /cap: "awaiting-human-merge"/.test(merged),
    "invariant: runMerged still resolves merge authority and parks as awaiting-human-merge without a grant",
  );

  // ------------------------------------------------------------- canary #3
  //
  // Routing to `ci` must not become a way to merge unreviewed work. In a repo
  // whose AGENTS.md grants merge authority — this one does — a round-capped PR
  // would otherwise pass CI and merge with three rounds of MEDIUM/HIGH findings
  // that nobody resolved. Every such grant is conditioned on the quality gates
  // having been met, and an exhausted review loop is exactly the gate that was
  // not; so the cap holds the merge on its own, independent of the wording.
  const capRoutedToCi = [
    { kind: "cap-hit", at: 1, cap: "round-cap", reviewRound: 3, nextStep: "ci" },
  ] as WorkEvent[];
  const capParked = [
    { kind: "cap-hit", at: 1, cap: "round-cap", reviewRound: 3, nextStep: "handoff" },
  ] as WorkEvent[];
  assert(
    heldByUnresolvedReview(capRoutedToCi),
    "canary: a round cap routed to ci holds the merge even where authority is granted",
  );
  assert(
    !heldByUnresolvedReview(capParked) && !heldByUnresolvedReview([]),
    "invariant: an ordinary cycle is not held — only one routed past an unresolved review",
  );
  assert(
    /heldByUnresolvedReview\(state\.eventLog\)/.test(merged) && /\|\| routedRoundCap/.test(merged),
    "...and the merge gate actually consults it, rather than the predicate sitting unused",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

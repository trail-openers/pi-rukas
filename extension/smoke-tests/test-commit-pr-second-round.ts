#!/usr/bin/env bun
/**
 * The SECOND commit-pr of a cycle — the one a CI failure legitimately reaches
 * (`ci-status: failure → develop → adversarial → commit-pr`).
 *
 * The re-entry guard was written for a crash-resume ("an open PR heads this
 * branch, so the previous attempt completed") and skipped `integrate()`
 * unconditionally. On the CI-fix round that is the wrong answer: the PR is
 * open BECAUSE the first round completed, and the developer's fix is sitting
 * in the worktree, on no branch. Skipping reported success, nothing was
 * pushed, and `ci` watched the same red head until the retry cap.
 *
 *  1. An open PR + new work in the worktree → the work lands on the EXISTING
 *     branch and the push is a fast-forward; no second PR is opened.
 *  2. An open PR + nothing new (the crash-resume the guard was written for)
 *     → still a no-op.
 *  3. The cycle's PR was merged or closed meanwhile → a refusal naming the
 *     state, not a branch rebuilt from base and pushed over the remote.
 *
 * Offline: real git in temp dirs, a scripted `gh`, no network, no model.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execp as realExec } from "../src/exec.ts";
import { mechanizedCommitPr } from "../src/work-driver-commit.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { nextStep } from "../src/work-driver-context.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { addLocalRemote, fixture, git } from "./helpers-integrate-pin-realgit.ts";
import { commandOf } from "./lib/argv-shell.ts";

process.env.PI_ENSEMBLE_FORGE = "github";
process.env.PI_ENSEMBLE_VERIFY = "0";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), "pi-ens-commit-pr-second-"));
const ISSUE = 26;
const BRANCH = "feature/issue-26-x";
const PR = 7;

/** The cycle's PR as `gh` reports it; `undefined` = never opened. */
type PrState = "OPEN" | "MERGED" | "CLOSED" | undefined;

async function cycle(name: string) {
  const { repo, baseSha } = await fixture(root, name);
  await addLocalRemote(root, repo);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  const wt = path.join(repo, ".worktrees", `issue-${ISSUE}-default`);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);

  let pr: PrState;
  const gh: string[] = [];
  // Production's executor: driver git calls use the argv form, which a
  // `sh -c` executor would turn into a bare `git`.
  const exec: NonNullable<DriverContext["verifyExecFn"]> = async (raw, o) => {
    const cmd = commandOf(raw, o);
    if (!cmd.startsWith("gh ")) return realExec(raw, o);
    gh.push(cmd);
    if (cmd.startsWith("gh pr list")) {
      return { stdout: JSON.stringify(pr === "OPEN" ? [{ number: PR }] : []) };
    }
    if (cmd.startsWith("gh pr view")) {
      return { stdout: JSON.stringify({ number: PR, state: pr, headRefName: BRANCH }) };
    }
    if (cmd.startsWith("gh pr create")) {
      pr = "OPEN";
      return { stdout: `https://github.com/o/r/pull/${PR}\n` };
    }
    return { stdout: "" };
  };
  const ctx = {
    host: {},
    repoRoot: repo,
    issue: ISSUE,
    verifyExecFn: exec,
  } as unknown as DriverContext;

  const base = initialState(ISSUE, 1000);
  const initial: WorkState = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      branchName: BRANCH,
      baseSha,
      worktrees: { default: wt },
    },
  };
  const commit = async (file: string, body: string) => {
    writeFileSync(path.join(wt, file), body);
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-q", "-m", `developer: ${file}`]);
  };
  const remote = async (rev: string) =>
    (await git(repo, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${rev}`])).stdout.trim();
  const remoteFile = async (file: string) =>
    git(repo, ["show", `refs/remotes/origin/${BRANCH}:${file}`]).then(
      (r) => r.stdout,
      () => undefined,
    );
  return {
    repo,
    wt,
    ctx,
    initial,
    gh,
    commit,
    remote,
    remoteFile,
    setPr: (s: PrState) => {
      pr = s;
    },
  };
}

/** Round 1 of a cycle: the developer's commit, consolidated, pushed, PR opened. */
async function firstRound(c: Awaited<ReturnType<typeof cycle>>): Promise<WorkState> {
  await c.commit("feature.txt", "feature\n");
  const res = await mechanizedCommitPr(c.ctx, c.initial, 2000);
  if (!res.ok) throw new Error(`fixture: round 1 failed — ${res.reason}`);
  // What the post-dispatch gate and the ci step record before the re-fix loop.
  return {
    ...res.state,
    pipelineState: { ...res.state.pipelineState, prNumber: PR, ciRetryCount: 1 },
  };
}

// ------------------------------------------------- 0. the path is reachable
{
  let st = initialState(ISSUE, 1000);
  st = {
    ...st,
    pipelineState: { ...st.pipelineState, currentStep: "ci", lastCompletedStep: "lens-review" },
  };
  st = appendEvent(st, { kind: "ci-status", at: 2000, status: "failure" } as never);
  const d1 = nextStep({ ...st, pipelineState: { ...st.pipelineState, ciRetryCount: 1 } });
  assert(d1.kind === "step" && d1.step === "develop", "ci-status: failure → develop");
  const approved = appendEvent(
    {
      ...st,
      pipelineState: {
        ...st.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
      },
    },
    { kind: "adversarial-approved", at: 3000, jobId: "j", rounds: 1 },
  );
  const d2 = nextStep(approved);
  assert(
    d2.kind === "step" && d2.step === "commit-pr",
    "…and the approved CI fix → a second commit-pr (the round under test)",
  );
}

// ------------------------------------- 1. open PR + a committed CI fix
{
  const c = await cycle("ci-fix");
  const afterFirst = await firstRound(c);
  const firstHead = await c.remote(BRANCH);
  assert((await c.remoteFile("feature.txt")) === "feature\n", "round 1 pushed the feature");

  // A lens-fix landed on the branch in between (integrate() leaves repoRoot
  // on it): the branch is now AHEAD of the worktree the developer fixes in.
  writeFileSync(path.join(c.repo, "lens.txt"), "lens fix\n");
  await git(c.repo, ["add", "lens.txt"]);
  await git(c.repo, ["commit", "-q", "-m", "fix(lens): round 1"]);
  await git(c.repo, ["push", "-q", "origin", BRANCH]);
  const lensHead = (await git(c.repo, ["rev-parse", "HEAD"])).stdout.trim();

  await c.commit("fix.txt", "ci fix\n");
  c.gh.length = 0;
  const res = await mechanizedCommitPr(c.ctx, afterFirst, 5000);
  assert(res.ok === true, `round 2 succeeds (${res.ok ? "ok" : res.reason})`);
  await git(c.repo, ["fetch", "-q", "origin"]);
  const secondHead = await c.remote(BRANCH);
  const onLens = await git(c.repo, ["merge-base", "--is-ancestor", lensHead, secondHead]).then(
    () => true,
    () => false,
  );
  assert(
    onLens && (await c.remoteFile("lens.txt")) === "lens fix\n",
    "the fix lands on top of what the branch gained since round 1 (a lens-fix is kept)",
  );
  assert(
    (await c.remoteFile("fix.txt")) === "ci fix\n",
    "the CI fix reaches origin/<branch> on the second commit-pr",
  );
  assert((await c.remoteFile("feature.txt")) === "feature\n", "…on top of round 1's work");
  const ff = await git(c.repo, ["merge-base", "--is-ancestor", firstHead, secondHead]).then(
    () => true,
    () => false,
  );
  assert(ff && firstHead !== secondHead, "…as a fast-forward of the existing remote branch");
  assert(!c.gh.some((g) => g.startsWith("gh pr create")), "…and no second PR is opened");
  const done = res.ok
    ? [...res.state.eventLog].reverse().find((e) => e.kind === "dispatch-completed")
    : undefined;
  assert(
    new RegExp(`\\npr: ${PR}$`).test((done as { summary?: string } | undefined)?.summary ?? ""),
    "…and the completion still carries the existing PR number",
  );
  const wtHead = (await git(c.wt, ["rev-parse", "HEAD"])).stdout.trim();
  assert(wtHead === secondHead, "the worktree is advanced to the pushed head for the next round");

  // 2. The crash-resume the guard was written for: nothing new → nothing moves.
  c.gh.length = 0;
  const again = await mechanizedCommitPr(c.ctx, afterFirst, 6000);
  await git(c.repo, ["fetch", "-q", "origin"]);
  assert(
    again.ok === true && (await c.remote(BRANCH)) === secondHead,
    "open PR + nothing new in the worktree → still a no-op re-entry",
  );
  assert(!c.gh.some((g) => g.startsWith("gh pr create")), "…with no PR created");
}

// ----------------------------------- 1b. open PR + an UNCOMMITTED CI fix
{
  const c = await cycle("ci-fix-uncommitted");
  const afterFirst = await firstRound(c);
  writeFileSync(path.join(c.wt, "fix.txt"), "uncommitted ci fix\n");
  const res = await mechanizedCommitPr(c.ctx, afterFirst, 5000);
  await git(c.repo, ["fetch", "-q", "origin"]);
  assert(
    res.ok === true && (await c.remoteFile("fix.txt")) === "uncommitted ci fix\n",
    `a fix the developer left uncommitted reaches origin too (${res.ok ? "ok" : res.reason})`,
  );
}

// ------------------------------------ 3. the PR was merged / closed meanwhile
for (const gone of ["MERGED", "CLOSED"] as const) {
  const c = await cycle(`pr-${gone.toLowerCase()}`);
  const afterFirst = await firstRound(c);
  const firstHead = await c.remote(BRANCH);
  await c.commit("fix.txt", "ci fix\n");
  c.setPr(gone);
  c.gh.length = 0;
  const res = await mechanizedCommitPr(c.ctx, afterFirst, 5000);
  assert(
    res.ok === false && res.terminal === true,
    `${gone}: the second commit-pr refuses, and the ops fallback is not asked to overrule it`,
  );
  assert(
    res.ok === false && res.reason.includes(`#${PR}`) && res.reason.includes(gone),
    `${gone}: the refusal names the PR and its state (${res.ok ? "" : res.reason.slice(0, 90)})`,
  );
  const halted = res.ok === false ? res.haltedAfter : undefined;
  const tail = halted?.eventLog[halted.eventLog.length - 1];
  assert(
    tail?.kind === "cap-hit" && tail.nextStep === "handoff",
    `${gone}: the cycle parks at handoff`,
  );
  assert(
    (halted?.pipelineState.verifyEvidence?.failures ?? []).some((f) => f.includes(gone)),
    `${gone}: the handoff evidence carries the state`,
  );
  await git(c.repo, ["fetch", "-q", "origin"]);
  assert((await c.remote(BRANCH)) === firstHead, `${gone}: the remote branch is untouched`);
  const local = (await git(c.repo, ["rev-parse", `refs/heads/${BRANCH}`])).stdout.trim();
  assert(local === firstHead, `${gone}: the local branch is not rebuilt from base`);
  assert(!c.gh.some((g) => g.startsWith("gh pr create")), `${gone}: no replacement PR is opened`);
}

rmSync(root, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);

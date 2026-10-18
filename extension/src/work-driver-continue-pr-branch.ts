/**
 * work-driver-continue-pr-branch — #1468: the branch step for `--continue-pr`.
 * The worktree starts at the PR head P with the mainline tip M merged in, so
 * develop judges M..H, the PR's net diff. It never falls back to the ops
 * dispatch, which would create a branch and a second PR.
 */

import { trace } from "./trace.ts";
import { detectMainline, freshMainlineTip } from "./work-driver-branch-mechanized.ts";
import { netTimeoutBranchFailure } from "./work-driver-branch-ops.ts";
import {
  recordDirtyRootExemptBaseline,
  runBranchResiduePass,
} from "./work-driver-branch-residue.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { continueCapHit, continueLookup } from "./work-driver-continue-pr-lookup.ts";
import type { ContinuedPr } from "./work-driver-continue-pr-state.ts";
import { synthesizeDriverCompletion } from "./work-driver-events.ts";
import { ensureWorktreesExcluded } from "./work-driver-git-exclude.ts";
import { isNetGitTimeout, runNetGit } from "./work-driver-net-git.ts";
import { makeWorktreeProvisionedEvent } from "./workflow-state-events-provision.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";
import { type ExecFn, gitErrorDetail, worktreeCreate, worktreeRemove } from "./worktree.ts";

const WORKTREE = "default";

async function gitOut(execFn: ExecFn, cwd: string, argv: string[]): Promise<string> {
  return (await execFn("git", { argv, cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}

async function gitOk(execFn: ExecFn, cwd: string, argv: string[]): Promise<boolean> {
  return gitOut(execFn, cwd, argv).then(
    () => true,
    () => false,
  );
}

/** The HEAD of each worktree that has `branch` checked out. */
async function heldAt(execFn: ExecFn, repoRoot: string, branch: string): Promise<string[]> {
  const listing = await gitOut(execFn, repoRoot, ["worktree", "list", "--porcelain"]);
  return listing
    .split("\n\n")
    .filter((block) => block.split("\n").includes(`branch refs/heads/${branch}`))
    .map((block) => /^HEAD (\S+)$/m.exec(block)?.[1] ?? "");
}

/**
 * Point the local branch at P with a compare-and-swap, or say why it is not
 * safe. Absent: create. Equal: nothing. An ancestor of P: fast-forward.
 */
async function setLocalBranch(
  execFn: ExecFn,
  repoRoot: string,
  head: string,
  P: string,
): Promise<string | undefined> {
  const ref = `refs/heads/${head}`;
  const old = await gitOut(execFn, repoRoot, ["rev-parse", "-q", "--verify", ref]).catch(() => "");
  const held = (await heldAt(execFn, repoRoot, head)).filter((sha) => sha !== P);
  if (held.length > 0) return `${head} is checked out in another worktree at ${held.join(", ")}`;
  if (old === P) return undefined;
  if (old && !(await gitOk(execFn, repoRoot, ["merge-base", "--is-ancestor", old, P]))) {
    return `the local ${head} at ${old} is ahead of or diverged from the PR head ${P}`;
  }
  try {
    await gitOut(execFn, repoRoot, ["update-ref", ref, P, old || "0".repeat(P.length)]);
  } catch (err) {
    return `the local ${head} changed while it was being set: ${gitErrorDetail(err).slice(0, 200)}`;
  }
  return undefined;
}

/** Step 3 in continue mode. The caller passes the cycle's exec and scratch dir. */
export async function runContinueBranch(
  ctx: CycleContext,
  incoming: WorkState,
  now: number,
  execFn: ExecFn,
  salvageScratch: string,
): Promise<WorkState> {
  const { repoRoot } = ctx;
  const started = (s: WorkState) =>
    appendEvent(
      { ...s, pipelineState: { ...s.pipelineState, currentStep: "branch" } },
      { kind: "step-started", step: "branch", at: now },
    );
  const stop = (s: WorkState, cap: Parameters<typeof continueCapHit>[1], evidence: string) => {
    trace(`work-driver: continue-pr branch step stopped (${cap}): ${evidence.slice(0, 200)}`);
    return continueCapHit(started(s), cap, evidence, Date.now());
  };

  const mainline = await detectMainline(execFn, repoRoot);
  const found = await continueLookup(ctx, execFn, mainline);
  if (!("ok" in found)) return stop(incoming, found.cap, found.evidence);
  const { pr } = found;
  const head = pr.headRefName ?? "";
  const P = pr.headRefOid ?? "";
  if (!/^[0-9a-f]{40,64}$/.test(P)) {
    return stop(incoming, "continue-pr-not-found", `PR #${pr.number} has no head commit SHA`);
  }

  const before = incoming.eventLog.length;
  let state = await runBranchResiduePass(ctx, incoming, execFn, salvageScratch);
  const residue = state.eventLog.slice(before);
  if (residue.some((e) => e.kind === "cap-hit")) return state;
  const adopted = residue.flatMap((e) =>
    e.kind === "worktree-leftover-handled" && e.action === "adopt" ? [e.path] : [],
  );
  if (adopted.length > 0) {
    return stop(
      state,
      "step-failed:branch",
      `a leftover worktree would be reused (${adopted.join(", ")}); --continue-pr needs a fresh one: re-run with --restart --continue-pr after removing it`,
    );
  }
  state = await recordDirtyRootExemptBaseline(ctx, state, execFn);

  try {
    await runNetGit(execFn, "git", { argv: ["fetch", "origin", mainline, head], cwd: repoRoot });
  } catch (err) {
    if (isNetGitTimeout(err)) return netTimeoutBranchFailure(state, err, now);
    return stop(state, "step-failed:branch", `fetch failed: ${gitErrorDetail(err).slice(0, 300)}`);
  }
  const { sha: M, fromOrigin } = await freshMainlineTip(execFn, repoRoot, mainline);
  if (!M || !fromOrigin) {
    return stop(state, "step-failed:branch", `origin/${mainline} did not resolve after the fetch`);
  }
  const remote = await gitOut(execFn, repoRoot, [
    "rev-parse",
    "-q",
    "--verify",
    `refs/remotes/origin/${head}`,
  ]).catch(() => "");
  if (remote !== P) {
    return stop(
      state,
      "continue-pr-head-moved",
      `origin/${head} is at ${remote || "(missing)"}, not the PR head ${P} the lookup read`,
    );
  }

  const unsafe = await setLocalBranch(execFn, repoRoot, head, P);
  if (unsafe) return stop(state, "continue-pr-unsafe-head", unsafe);

  const name = `issue-${ctx.issue}-${WORKTREE}`;
  let created: Awaited<ReturnType<typeof worktreeCreate>>;
  try {
    await ensureWorktreesExcluded(execFn, repoRoot);
    created = await worktreeCreate(execFn, {
      repoRoot,
      name,
      fromRef: P,
      strictSiblingListing: true,
    });
  } catch (err) {
    return stop(state, "step-failed:branch", `worktree: ${gitErrorDetail(err).slice(0, 300)}`);
  }
  const wt = created.path;

  let conflictPaths: string[] = [];
  try {
    await gitOut(execFn, wt, [
      "merge",
      "--no-ff",
      "--no-edit",
      "-m",
      `Merge branch '${mainline}' into ${head}`,
      M,
    ]);
  } catch (err) {
    const unmerged = await gitOut(execFn, wt, ["diff", "--name-only", "--diff-filter=U"]).catch(
      () => "",
    );
    conflictPaths = unmerged ? unmerged.split("\n") : [];
    if (conflictPaths.length === 0) {
      await gitOut(execFn, wt, ["merge", "--abort"]).catch(() => "");
      await worktreeRemove(execFn, repoRoot, name, true).catch(() => undefined);
      return stop(
        state,
        "step-failed:branch",
        `merge failed: ${gitErrorDetail(err).slice(0, 300)}`,
      );
    }
  }

  const continuedPr: ContinuedPr = {
    number: pr.number,
    headRefName: head,
    headSha: P,
    mainlineSha: M,
    conflictPaths,
    matchedBy: pr.matchedBy,
  };
  const conflicts = conflictPaths.length
    ? `${conflictPaths.length} conflict(s): ${conflictPaths.join(", ")}`
    : "0 conflicts";
  const done = appendEvent(
    started(state),
    synthesizeDriverCompletion({
      step: "branch",
      label: "driver:branch",
      summary: `Continue PR #${pr.number}: ${head} @ ${P.slice(0, 8)} + origin/${mainline} @ ${M.slice(0, 8)}; ${conflicts}.`,
      startedAt: now,
      now: Date.now(),
    }),
  );
  const p = created.provision;
  const withProvision = appendEvent(
    done,
    makeWorktreeProvisionedEvent(WORKTREE, wt, p.via, p.problem, p.hookFailed),
  );
  return {
    ...withProvision,
    pipelineState: {
      ...withProvision.pipelineState,
      branchName: head,
      baseSha: M,
      prNumber: pr.number,
      workstreams: undefined,
      worktrees: { [WORKTREE]: wt },
      workstreamBaseShas: { [WORKTREE]: M },
      continuedPr,
    },
  };
}

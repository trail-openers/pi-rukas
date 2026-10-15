#!/usr/bin/env bun
/**
 * A pull request merged or closed by a person while the cycle is still
 * reviewing it. The driver used to go on to lens-fix and push onto the merged
 * branch, and the review's residual findings were posted nowhere: the
 * disclosure looked the PR up by branch with `state: open`, and its failure
 * note was read only by the hand-run tool.
 *
 * Covers: merged before lens review, merged between lens review and lens-fix,
 * merged during the fix pass (the push in the adversarial step), closed
 * without a merge, a lookup that fails, residuals posted to a merged PR by
 * number, and the fallback to the issue.
 */

import { execFile } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { postLensResidualDisclosure } from "../src/lens-review-residuals.ts";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { nextStep } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { runLens } from "../src/work-driver-lens.ts";
import { endIfPrGone } from "../src/work-driver-pr-gone.ts";
import { mergedLine } from "../src/work-driver-terminal-delivery.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { addLocalRemote, fixture, git, realExec } from "./helpers-integrate-pin-realgit.ts";
import { mkLensSummary } from "./test-helpers.ts";

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

const execFileP = promisify(execFile);
const root = mkdtempSync(path.join(os.tmpdir(), "pi-ens-pr-gone-"));
const ISSUE = 1290;
const BRANCH = "feature/issue-1290-x";
const PR = 7;
const FINDING = {
  path: "a.txt",
  line: 1,
  severity: "MEDIUM" as const,
  title: "the change drops a check",
  lens: "CORRECTNESS",
};

type PrState = "OPEN" | "MERGED" | "CLOSED" | "unreadable";

/** A repo whose cycle has opened PR #7 on BRANCH, with a local bare remote. */
async function cycle(name: string) {
  const { repo, baseSha } = await fixture(root, name);
  await addLocalRemote(root, repo);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  // The lens diff resolves the mainline from origin/HEAD.
  await git(repo, ["remote", "set-head", "origin", "main"]);
  await git(repo, ["checkout", "-q", "-b", BRANCH]);
  writeFileSync(path.join(repo, "a.txt"), "feature\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "feature"]);
  await git(repo, ["push", "-q", "-u", "origin", BRANCH]);
  await git(repo, ["checkout", "-q", "main"]);

  const c = {
    repo,
    baseSha,
    pr: "OPEN" as PrState,
    issueCommentFails: false,
    gh: [] as string[],
    pushes: [] as string[],
    issueBodies: [] as string[],
    prBodies: [] as string[],
  };
  const bodyOf = (cmd: string) => {
    const m = cmd.match(/--body-file (?:'([^']+)'|(\S+))/);
    const file = m?.[1] ?? m?.[2];
    return file ? readFileSync(file, "utf8") : "";
  };
  const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
    // The driver's network git calls (runNetGit) pass an argv, not a shell string.
    const argv = (o as { argv?: string[] } | undefined)?.argv;
    if (argv) {
      if (cmd === "git" && argv[0] === "push") c.pushes.push(`git ${argv.join(" ")}`);
      const { stdout } = await execFileP(cmd, argv, { cwd: o?.cwd });
      return { stdout };
    }
    if (/\bgit\b.*\bpush\b/.test(cmd)) c.pushes.push(cmd);
    if (!cmd.startsWith("gh ")) return realExec(cmd, o);
    c.gh.push(cmd);
    if (cmd.startsWith("gh pr view")) {
      if (c.pr === "unreadable") throw new Error("gh: could not resolve to a PullRequest");
      return {
        stdout: JSON.stringify({
          number: PR,
          state: c.pr,
          headRefName: BRANCH,
          baseRefName: "main",
        }),
      };
    }
    if (cmd.startsWith("gh issue comment")) {
      if (c.issueCommentFails) throw new Error("gh: HTTP 502");
      c.issueBodies.push(bodyOf(cmd));
      return { stdout: `https://github.com/o/r/issues/${ISSUE}#issuecomment-1\n` };
    }
    if (cmd.startsWith("gh pr comment")) {
      c.prBodies.push(bodyOf(cmd));
      return { stdout: `https://github.com/o/r/pull/${PR}#issuecomment-2\n` };
    }
    return { stdout: "" };
  };
  const ctx = {
    host: { sendUserMessage: () => {} },
    repoRoot: repo,
    issue: ISSUE,
    verifyExecFn: exec,
    issueBodyFetcherFn: async () => ({ stdout: "mock" }),
  } as unknown as DriverContext;
  const base = initialState(ISSUE, 1000);
  const state = (step: WorkState["pipelineState"]["currentStep"]): WorkState => ({
    ...base,
    pipelineState: {
      ...base.pipelineState,
      currentStep: step,
      lastCompletedStep: "commit-pr",
      branchName: BRANCH,
      baseSha,
      prNumber: PR,
      reviewRound: 1,
    },
  });
  const remoteHead = async () =>
    (await git(repo, ["rev-parse", `refs/remotes/origin/${BRANCH}`])).stdout.trim();
  const remoteTip = async () =>
    (await git(repo, ["ls-remote", "origin", `refs/heads/${BRANCH}`])).stdout.split("\t")[0];
  return { c, ctx, state, exec, remoteHead, remoteTip };
}

try {
  // ----------------------------------------------- merged before lens review
  {
    const t = await cycle("merged-before-lens");
    t.c.pr = "MERGED";
    const ended = await endIfPrGone(t.ctx, t.state("lens-review"), "lens-review");
    const last = ended?.eventLog[ended.eventLog.length - 1];
    assert(ended?.pipelineState.status === "merged", "merged before lens review: status merged");
    assert(
      last?.kind === "merged" && last.mergedByOtherDuring === "lens-review" && last.prNumber === PR,
      `…recorded as merged by someone else during lens-review (got ${JSON.stringify(last)})`,
    );
    assert(ended !== undefined && nextStep(ended).kind === "done", "…and the loop ends there");
    assert(
      !t.c.gh.some((g) => g.startsWith("gh pr merge")) && t.c.pushes.length === 0,
      "…the driver neither merged nor pushed",
    );
    const line = ended ? mergedLine(ended) : "";
    assert(
      /merged by someone else during lens-review/i.test(line) &&
        line.includes("merged nothing") &&
        !line.includes("MERGED ✓"),
      `…and the terminal line does not claim the driver merged it (got: ${line})`,
    );
    assert(
      ended !== undefined &&
        validateDiscriminants(ended as unknown as Record<string, unknown>).length === 0,
      "…the state file validates",
    );
  }

  // --------------------------------- merged between lens review and lens-fix
  {
    const t = await cycle("merged-before-fix");
    const reviewed = appendEvent(t.state("lens-review"), {
      kind: "lens-issues-found",
      at: 2,
      jobId: "j",
      round: 1,
      findings: JSON.stringify([FINDING]),
    });
    assert(
      nextStep(reviewed).kind === "step" &&
        (nextStep(reviewed) as { step: string }).step === "lens-fix",
      "a review with findings routes to lens-fix",
    );
    t.c.pr = "MERGED";
    const ended = await endIfPrGone(t.ctx, reviewed, "lens-fix");
    const last = ended?.eventLog[ended.eventLog.length - 1];
    assert(
      ended?.pipelineState.status === "merged" &&
        last?.kind === "merged" &&
        last.mergedByOtherDuring === "lens-fix",
      "merged before lens-fix: the cycle ends merged, lens-fix is not dispatched",
    );
  }

  // ------------------- merged during the fix pass: the fix push is withheld
  for (const pr of ["MERGED", "OPEN"] as const) {
    const t = await cycle(`fix-push-${pr}`);
    const wt = path.join(t.c.repo, ".worktrees", `issue-${ISSUE}-default`);
    await git(t.c.repo, ["worktree", "add", "-q", "--detach", wt, BRANCH]);
    writeFileSync(path.join(wt, "a.txt"), "feature, fixed\n");
    await git(wt, ["commit", "-qam", "lens fix"]);
    const before = await t.remoteTip();
    const ctx = {
      ...t.ctx,
      adversarialLoopFn: async () => ({
        role: "adversarial-loop",
        ok: true,
        exitCode: 0,
        text: "VERDICT: APPROVED",
        toolUses: [],
        ms: 1,
        loopOutcome: "approved",
        adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
      }),
    } as unknown as DriverContext;
    const s = t.state("adversarial");
    const fixed: WorkState = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        lastCompletedStep: "lens-fix",
        worktrees: { default: wt },
      },
    };
    t.c.pr = pr;
    const after = await runAdversarial(ctx, fixed, Date.now());
    const tip = await t.remoteTip();
    if (pr === "MERGED") {
      assert(
        tip === before,
        `merged during the fix pass: nothing was pushed to ${BRANCH} (${before} → ${tip})`,
      );
      assert(after.pipelineState.status === "merged", "…and the cycle ends merged");
    } else {
      assert(
        tip !== before,
        `control: with the PR open, the lens fix IS pushed (${before} → ${tip}, status ${after.pipelineState.status})`,
      );
    }
  }

  // ------------------------------------------------- closed without a merge
  for (const step of ["lens-review", "ci"] as const) {
    const t = await cycle(`closed-${step}`);
    t.c.pr = "CLOSED";
    const ended = await endIfPrGone(t.ctx, t.state(step), step);
    const last = ended?.eventLog[ended.eventLog.length - 1];
    assert(
      ended?.pipelineState.status === "running" &&
        last?.kind === "cap-hit" &&
        last.cap === `verify-failed:${step}` &&
        last.nextStep === "handoff",
      `closed before ${step}: parks to handoff (got ${JSON.stringify(last)})`,
    );
    const failures = ended?.pipelineState.verifyEvidence?.failures ?? [];
    assert(
      failures.length === 1 && failures[0]?.startsWith("[pr-not-open] PR #7 is CLOSED"),
      "…with the [pr-not-open] marker",
    );
    const text = ended ? explainCap(`verify-failed:${step}`, ended) : "";
    assert(
      text.includes(`when the ${step} step started`) && !/rejected the .* "done" claim/.test(text),
      `…explained as a PR that is no longer open, not a rejected claim (got: ${text.slice(0, 160)})`,
    );
    assert(t.c.pushes.length === 0, "…and nothing is pushed");
  }

  // --------------------------------------------------- a lookup that fails
  {
    const t = await cycle("unreadable");
    t.c.pr = "unreadable";
    assert(
      (await endIfPrGone(t.ctx, t.state("lens-review"), "lens-review")) === undefined,
      "an unreadable PR state: the step runs as before",
    );
    t.c.pr = "OPEN";
    assert(
      (await endIfPrGone(t.ctx, t.state("ci"), "ci")) === undefined,
      "an open PR: the step runs as before",
    );
    const noPr = t.state("lens-review");
    noPr.pipelineState.prNumber = undefined;
    const ghBefore = t.c.gh.length;
    assert(
      (await endIfPrGone(t.ctx, noPr, "lens-review")) === undefined && t.c.gh.length === ghBefore,
      "no PR recorded: no lookup, the step runs",
    );
  }

  // --------------------- residuals posted to a merged PR by its recorded number
  {
    const t = await cycle("residuals-by-number");
    t.c.pr = "MERGED";
    const summary = mkLensSummary({ verdict: "ISSUES_FOUND", findings: [FINDING] as never });
    const note = await postLensResidualDisclosure({
      summary,
      branch: BRANCH,
      pr: PR,
      cwd: t.c.repo,
      execFn: t.exec as never,
    });
    assert(note === "", `residuals to a merged PR by number: posted (note: ${note})`);
    assert(
      !t.c.gh.some((g) => g.startsWith("gh pr list")),
      "…without the open-PR lookup by branch that a merged PR never matches",
    );
    assert(
      t.c.prBodies.length === 1 &&
        (t.c.prBodies[0] ?? "").includes(FINDING.title) &&
        (t.c.prBodies[0] ?? "").includes(`<!-- pi-rukas:lens-residuals branch=${BRANCH} patch=`),
      "…on the PR, carrying the merge-guard marker",
    );
  }

  // --------------------- runLens passes the number; a failed post goes to the issue
  for (const issueCommentFails of [false, true]) {
    const t = await cycle(`residuals-fallback-${issueCommentFails}`);
    t.c.issueCommentFails = issueCommentFails;
    const seen: Array<number | undefined> = [];
    const ctx = {
      ...t.ctx,
      lensReviewFn: async (o: { pr?: number }) => {
        seen.push(o.pr);
        return {
          ...mkLensSummary({ verdict: "ISSUES_FOUND", findings: [FINDING] as never }),
          note: "residual-findings disclosure FAILED: gh: HTTP 404",
        };
      },
    } as unknown as DriverContext;
    const s = t.state("lens-review");
    const after = await runLens(
      ctx,
      { ...s, pipelineState: { ...s.pipelineState, reviewRound: 0 } },
      Date.now(),
    );
    assert(seen[0] === PR, `runLens hands the review the recorded PR number (got ${seen[0]})`);
    const ev = after.eventLog.find((e) => e.kind === "lens-residuals-post-failed");
    if (!issueCommentFails) {
      assert(
        t.c.issueBodies.length === 1 &&
          (t.c.issueBodies[0] ?? "").includes(FINDING.title) &&
          !(t.c.issueBodies[0] ?? "").includes("pi-rukas:lens-residuals"),
        "a failed PR post: the findings are posted to the issue, without the PR-only marker",
      );
      assert(
        ev?.kind === "lens-residuals-post-failed" &&
          ev.issueFallback === "posted" &&
          ev.prNumber === PR &&
          ev.reason.includes("HTTP 404"),
        `…and the failure is recorded in the state file (got ${JSON.stringify(ev)})`,
      );
    } else {
      assert(
        ev?.kind === "lens-residuals-post-failed" &&
          ev.issueFallback === "failed" &&
          (ev.detail ?? "").includes("502"),
        `the issue post failing too is recorded, not dropped (got ${JSON.stringify(ev)})`,
      );
    }
    assert(
      validateDiscriminants(after as unknown as Record<string, unknown>).length === 0,
      "…the state file validates",
    );
  }

  // ------------------------------------------ the three steps are gated
  {
    const src = readFileSync(path.join(import.meta.dir, "../src/work-driver-run-step.ts"), "utf8");
    for (const fn of ["runLens", "runLensFix", "runCi"]) {
      assert(
        new RegExp(`\\(await endIfPrGone\\(ctx, state, step\\)\\) \\?\\? ${fn}\\(`).test(src),
        `runStep checks the PR before ${fn}`,
      );
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);

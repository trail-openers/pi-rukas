#!/usr/bin/env bun
/**
 * #1292 — the cycle's PR is a draft until the driver's review is done.
 *
 * commit-pr opens the PR before the six-pass review, and for the hours the
 * review and its fixes take GitHub showed an ordinary mergeable PR: five of
 * nine cycle PRs on one repo were merged by a person mid-review. Pinned here:
 *
 *  1. The adapter spells `--draft` on create and `pr ready` / `mr update
 *     --ready` for both forges.
 *  2. The setting: on for a headless `/work`, off otherwise, `PI_ENSEMBLE_DRAFT_PR`
 *     overrides either way.
 *  3. A headless commit-pr opens a draft (real git, scripted gh); the setting
 *     off opens it ready; the ops fallback prompt asks for `--draft` too.
 *  4. The second commit-pr and the identity gate accept a draft as the
 *     cycle's own (a draft is state OPEN — pinned from gh's real shape).
 *  5. Handoff after a concluded review → `gh pr ready`, whatever the verdict.
 *  6. A park before the review concluded → still a draft, and the comment says so.
 *  7. A failing `gh pr ready` is retried and reported, not dropped.
 *  8. The merge step marks a draft ready BEFORE reading merge evidence (a
 *     draft reports `mergeStateStatus: DRAFT`, which holds the merge).
 *
 * Offline: real git in temp dirs, scripted `gh`, fake forge, no model.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { prCreateCmd, prReadyCmd } from "../src/forge-commands.ts";
import { mapGhPr, mapGlMr } from "../src/forge-mapping.ts";
import type { Forge } from "../src/forge.ts";
import type { DispatchResult } from "../src/types.ts";
import { mechanizedCommitPr } from "../src/work-driver-commit.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { draftPrEnabled, markDraftPrReady, reviewConcluded } from "../src/work-driver-draft-pr.ts";
import { runHandoff } from "../src/work-driver-handoff.ts";
import { runMerged } from "../src/work-driver-merged.ts";
import { inlineCommitPrPrompt } from "../src/work-driver-prompts-late.ts";
import { judgePrIdentity } from "../src/work-driver-verify.ts";
import { scratchDir } from "../src/work-driver-workspace.ts";
import {
  type WorkEvent,
  type WorkState,
  appendEvent,
  initialState,
} from "../src/workflow-state.ts";
import { addLocalRemote, fixture, git } from "./helpers-integrate-pin-realgit.ts";
import { realExec } from "./lib/exec-fake.ts";

process.env.PI_ENSEMBLE_FORGE = "github";
process.env.PI_ENSEMBLE_VERIFY = "0";
process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_HANDOFF_CONSOLIDATE = "0";
process.env.PI_ENSEMBLE_WORKTREE_TEARDOWN = "0";
delete process.env.PI_ENSEMBLE_DRAFT_PR;

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ISSUE = 1292;
const BRANCH = "fix/issue-1292-x";
const PR = 7;

// ---------------------------------------------------------------- 1. commands
{
  const gh = prCreateCmd("github", "T", BRANCH, "/tmp/b", { draft: true });
  assert(gh.includes(" --draft"), `gh pr create carries --draft (${gh})`);
  assert(
    !prCreateCmd("github", "T", BRANCH, "/tmp/b", {}).includes("--draft"),
    "…and not when the PR is not a draft",
  );
  const gl = prCreateCmd("gitlab", "T", BRANCH, "/tmp/b", { baseBranch: "main", draft: true });
  assert(/ --draft --output json$/.test(gl), `glab mr create carries --draft (${gl})`);
  assert(prReadyCmd("github", PR) === "gh pr ready 7", "GitHub ready: gh pr ready <N>");
  assert(
    prReadyCmd("gitlab", PR) === "glab mr update 7 --ready",
    "GitLab ready: glab mr update --ready",
  );
}

// ---------------------------------------------------------------- 2. setting
{
  assert(draftPrEnabled({ headless: true }), "headless /work, setting unset → draft");
  assert(!draftPrEnabled({ headless: false }), "interactive /work, setting unset → not a draft");
  assert(!draftPrEnabled({}), "headless unknown, setting unset → not a draft");
  process.env.PI_ENSEMBLE_DRAFT_PR = "0";
  assert(!draftPrEnabled({ headless: true }), "PI_ENSEMBLE_DRAFT_PR=0 turns it off for headless");
  process.env.PI_ENSEMBLE_DRAFT_PR = "1";
  assert(draftPrEnabled({ headless: false }), "PI_ENSEMBLE_DRAFT_PR=1 turns it on interactively");
  process.env.PI_ENSEMBLE_DRAFT_PR = "true";
  assert(draftPrEnabled({ headless: true }), "only 1/0 are read: 'true' is ignored (headless default holds)");
  assert(!draftPrEnabled({ headless: false }), "…and does not turn drafts on interactively");
  delete process.env.PI_ENSEMBLE_DRAFT_PR;
}

// ------------------------------------------------- 3 + 4. commit-pr (real git)
const execFileP = promisify(execFile);
const root = mkdtempSync(path.join(os.tmpdir(), "pi-ens-draft-pr-"));

/** gh's real `pr view --json …` answer for an open draft PR. */
const DRAFT_VIEW = { number: PR, state: "OPEN", isDraft: true, headRefName: BRANCH };

async function cycle(name: string, headless: boolean) {
  const { repo, baseSha } = await fixture(root, name);
  await addLocalRemote(root, repo);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  const wt = path.join(repo, ".worktrees", `issue-${ISSUE}-default`);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  const gh: string[] = [];
  let opened = false;
  const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
    // The driver's network git calls (runNetGit) pass an argv, not a shell string.
    const argv = (o as { argv?: string[] } | undefined)?.argv;
    if (argv) {
      const { stdout } = await execFileP(cmd, argv, { cwd: o?.cwd });
      return { stdout };
    }
    if (!cmd.startsWith("gh ")) return realExec(cmd, o);
    gh.push(cmd);
    // The list "misses" the PR so the second round reaches recordedPrState.
    if (cmd.startsWith("gh pr list")) return { stdout: "[]" };
    if (cmd.startsWith("gh pr view")) return { stdout: JSON.stringify(DRAFT_VIEW) };
    if (cmd.startsWith("gh pr create")) {
      opened = true;
      return { stdout: `https://github.com/o/r/pull/${PR}\n` };
    }
    return { stdout: "" };
  };
  const ctx = { host: {}, repoRoot: repo, issue: ISSUE, verifyExecFn: exec, headless };
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
  const commit = async (file: string) => {
    writeFileSync(path.join(wt, file), `${file}\n`);
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-q", "-m", `developer: ${file}`]);
  };
  return { ctx: ctx as unknown as DriverContext, initial, gh, commit, opened: () => opened };
}

try {
  const c = await cycle("headless", true);
  await c.commit("feature.txt");
  const r1 = await mechanizedCommitPr(c.ctx, c.initial, 2000);
  const create = c.gh.find((g) => g.startsWith("gh pr create")) ?? "";
  assert(r1.ok && create.includes("--draft"), `headless commit-pr opens a draft (${create})`);
  assert(
    r1.ok && r1.state.pipelineState.prDraft?.status === "draft",
    "…and records prDraft=draft for the mark-ready points",
  );

  // 4. The second commit-pr — a CI fix in the worktree, the PR a draft.
  if (r1.ok) {
    const afterFirst = { ...r1.state, pipelineState: { ...r1.state.pipelineState, prNumber: PR } };
    await c.commit("fix.txt");
    c.gh.length = 0;
    const r2 = await mechanizedCommitPr(c.ctx, afterFirst, 5000);
    assert(
      r2.ok,
      `the second commit-pr accepts the draft PR as the cycle's own (${r2.ok ? "ok" : r2.reason})`,
    );
    assert(
      !c.gh.some((g) => g.startsWith("gh pr create")),
      "…pushing onto it, without opening a second PR",
    );
  }

  const off = await cycle("setting-off", true);
  process.env.PI_ENSEMBLE_DRAFT_PR = "0";
  await off.commit("feature.txt");
  const r3 = await mechanizedCommitPr(off.ctx, off.initial, 2000);
  delete process.env.PI_ENSEMBLE_DRAFT_PR;
  const create3 = off.gh.find((g) => g.startsWith("gh pr create")) ?? "";
  assert(r3.ok && create3 !== "" && !create3.includes("--draft"), "setting off → opened ready");
  assert(r3.ok && r3.state.pipelineState.prDraft === undefined, "…and no prDraft is recorded");
} finally {
  rmSync(root, { recursive: true, force: true });
}

// 3 (fallback). The ops fallback is told to open a draft too.
{
  const prompt = (draft: boolean) =>
    inlineCommitPrPrompt([ISSUE], [], {}, {}, BRANCH, undefined, [], "/tmp/s", "fix: x", {
      integratePath: "/tmp/i",
      scratchDir: "/tmp/s",
      baseSha: "a".repeat(40),
      worktrees: {},
      commitShas: {},
      workstreams: {},
      draft,
    });
  assert(
    prompt(true).includes("`gh pr create --draft --title"),
    "fallback prompt: gh pr create --draft",
  );
  assert(!prompt(false).includes("--draft"), "fallback prompt: no --draft when the setting is off");
}

// 4 (identity). A draft is state OPEN in gh's real shape; the gate accepts it.
{
  const view = mapGhPr({ ...DRAFT_VIEW, mergeStateStatus: "DRAFT" });
  assert(view.state === "OPEN", "gh reports a draft PR as state OPEN");
  assert(
    judgePrIdentity(BRANCH, view).ok,
    "the identity gate accepts a draft PR as the cycle's own",
  );
  const mr = mapGlMr({ iid: PR, state: "opened", draft: true, source_branch: BRANCH });
  assert(mr.state === "OPEN", "glab reports a draft MR as opened → OPEN");
  assert(judgePrIdentity(BRANCH, mr).ok, "…and the gate accepts it too");
}

// ------------------------------------------------------------ 5-7. handoff
const fakePi = { sendUserMessage: () => undefined } as unknown as ExtensionAPI;
const failingDispatch: DriverContext["dispatchFn"] = async (): Promise<DispatchResult> => {
  throw new Error("ops dispatch failed (simulated)");
};

/** A forge whose `prReady` fails the first `failures` calls. */
function mkForge(failures: number) {
  const ready: number[] = [];
  const forge = {
    forge: "github",
    prReady: async (n: number) => {
      ready.push(n);
      if (ready.length <= failures) throw new Error("GraphQL: Could not mark ready (simulated)");
    },
    prComment: async (n: number) => `https://github.com/o/r/pull/${n}#issuecomment-1`,
    issueComment: async (n: number) => `https://github.com/o/r/issues/${n}#issuecomment-2`,
    prComments: async () => [],
    issueComments: async () => [],
    issueView: async () => ({ labels: [{ name: "needs-human-attention" }] }),
    prView: async () => ({ labels: [{ name: "needs-human-attention" }] }),
    labelCreate: async () => undefined,
    labelAdd: async () => undefined,
  } as unknown as Forge;
  return { forge, ready };
}

const at = (n: number) => 1_000_000 + n;
function reviewState(events: WorkEvent[], prDraft?: WorkState["pipelineState"]["prDraft"]) {
  let s = initialState(ISSUE, at(0));
  s = { ...s, pipelineState: { ...s.pipelineState, prNumber: PR, branchName: BRANCH, prDraft } };
  return appendEvent(s, ...events);
}
const started = (step: "commit-pr" | "lens-review" | "lens-fix", n: number): WorkEvent => ({
  kind: "step-started",
  step,
  at: at(n),
});
const cap = (c: string, n: number): WorkEvent =>
  ({ kind: "cap-hit", at: at(n), cap: c, reviewRound: 1, nextStep: "handoff" }) as WorkEvent;
const critical: WorkEvent = {
  kind: "lens-issues-found",
  at: at(3),
  jobId: "j",
  round: 1,
  findings: "x",
  verdict: "CRITICAL_ISSUES_FOUND",
};
const approved: WorkEvent = { kind: "lens-approved", at: at(3), jobId: "j", round: 1 };

async function handoff(state: WorkState, failures = 0) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ens-draft-handoff-"));
  try {
    const { forge, ready } = mkForge(failures);
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: ISSUE,
      dispatchFn: failingDispatch,
      forge,
    };
    const next = await runHandoff(ctx, state, Date.now());
    const body = readFileSync(path.join(scratchDir(dir, ISSUE), "handoff-comment.md"), "utf8");
    return { next, ready, body };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // 5. A concluded review (approved, then a park) marks it ready.
  const concluded = [
    started("commit-pr", 1),
    started("lens-review", 2),
    approved,
    cap("step-failed:ci", 4),
  ];
  assert(reviewConcluded(concluded), "an approved verdict followed only by a cap is concluded");
  const h = await handoff(reviewState(concluded, { status: "draft" }));
  assert(h.ready.length === 1 && h.ready[0] === PR, "handoff after the review: gh pr ready <N>");
  assert(h.next.pipelineState.prDraft?.status === "ready", "…recorded as ready");
  assert(
    !h.body.includes("still a draft") && !h.body.includes("FAILED"),
    "…and no draft notice in the comment",
  );
}

{
  // 6. Parks before the review concluded leave it a draft, and say so.
  const cases: Array<[string, WorkEvent[]]> = [
    [
      "a review that could not complete",
      [started("commit-pr", 1), started("lens-review", 2), cap("review-incomplete", 3)],
    ],
    [
      "a park in a fix round",
      [
        started("commit-pr", 1),
        started("lens-review", 2),
        critical,
        started("lens-fix", 4),
        cap("step-failed:lens-fix", 5),
      ],
    ],
    ["a park at commit-pr itself", [started("commit-pr", 1), cap("verify-failed:commit-pr", 2)]],
  ];
  for (const [what, events] of cases) {
    assert(!reviewConcluded(events), `${what}: the review did not conclude`);
    const h = await handoff(reviewState(events, { status: "draft" }));
    assert(h.ready.length === 0, `${what}: gh pr ready is NOT run`);
    assert(h.next.pipelineState.prDraft?.status === "draft", `${what}: the PR stays a draft`);
    assert(
      h.body.includes("### Pull request is still a draft") && h.body.includes(`gh pr ready ${PR}`),
      `${what}: the handoff comment says it is still a draft and how to mark it ready`,
    );
  }
}

{
  // Setting off: no draft recorded → the handoff never touches readiness.
  const h = await handoff(
    reviewState([
      started("commit-pr", 1),
      started("lens-review", 2),
      critical,
      cap("round-cap", 4),
    ]),
  );
  assert(
    h.ready.length === 0 && !h.body.includes("still a draft") && !h.body.includes("ready FAILED"),
    "setting off: no gh pr ready, no draft notice",
  );
}

{
  // 7. gh pr ready fails every attempt → retried, recorded, reported.
  const events = [
    started("commit-pr", 1),
    started("lens-review", 2),
    approved,
    cap("step-failed:ci", 4),
  ];
  const h = await handoff(reviewState(events, { status: "draft" }), 99);
  assert(h.ready.length === 3, `a failing gh pr ready is retried (attempts=${h.ready.length})`);
  assert(h.next.pipelineState.prDraft?.status === "ready-failed", "…recorded as ready-failed");
  assert(
    h.body.includes("### Marking the pull request ready FAILED") &&
      h.body.includes("Could not mark ready"),
    "…and reported in the handoff comment with the error",
  );
  const flaky = await handoff(reviewState(events, { status: "draft" }), 2);
  assert(
    flaky.ready.length === 3 && flaky.next.pipelineState.prDraft?.status === "ready",
    "two failures then success → ready on the third attempt",
  );
  // A ready that failed at ci is retried at a later park even mid-fix.
  const midFix = [...events, started("lens-fix", 5), cap("step-failed:lens-fix", 6)];
  const held = await handoff(reviewState(midFix, { status: "ready-failed", error: "e" }));
  assert(held.ready.length === 0, "an earlier ready-failed is NOT retried while a fix round is open");
  const retried = await handoff(reviewState(events, { status: "ready-failed", error: "e" }));
  assert(retried.ready.length === 1, "…but is retried at a handoff after the review concluded");
}

{
  // 5b. CRITICAL, then the round cap: never marked ready over a critical finding.
  const h = await handoff(
    reviewState(
      [started("commit-pr", 1), started("lens-review", 2), critical, cap("round-cap", 4)],
      { status: "draft" },
    ),
  );
  assert(h.ready.length === 0, "CRITICAL then cap: gh pr ready is NOT run");
  assert(
    h.next.pipelineState.prDraft?.status === "draft" &&
      /CRITICAL/.test(h.next.pipelineState.prDraft?.holdReason ?? ""),
    "…the PR stays a draft, with the reason recorded",
  );
  assert(
    h.body.includes("### Pull request is still a draft") && h.body.includes("CRITICAL"),
    "…and the handoff comment says why",
  );
}

// ---------------------------------------------------------- ci entry + merge
{
  const { forge, ready } = mkForge(0);
  const ctx = { host: fakePi, repoRoot: "/nonexistent", issue: ISSUE, forge } as DriverContext;
  const marked = await markDraftPrReady(ctx, reviewState([], { status: "draft" }));
  assert(
    ready.length === 1 && marked.pipelineState.prDraft?.status === "ready",
    "entering ci marks the draft ready",
  );
  const again = await markDraftPrReady(ctx, marked);
  assert(ready.length === 1 && again === marked, "…and is a no-op once ready");
}

{
  // 8. The merge step marks it ready before the merge-evidence read.
  const order: string[] = [];
  const { forge } = mkForge(0);
  const recordingForge = {
    ...forge,
    prReady: async () => void order.push("ready"),
  } as unknown as Forge;
  const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
    if (cmd.startsWith("gh pr view")) {
      order.push("evidence");
      return { stdout: JSON.stringify({ state: "OPEN", mergeStateStatus: "BLOCKED" }) };
    }
    return { stdout: "" };
  };
  const ctx = {
    host: fakePi,
    repoRoot: "/nonexistent",
    issue: ISSUE,
    forge: recordingForge,
    verifyExecFn: exec,
    mergeGrant: true,
  } as DriverContext;
  const next = await runMerged(ctx, reviewState([], { status: "draft" }), Date.now());
  assert(
    order[0] === "ready" && order.includes("evidence"),
    `merged: ready before the evidence read (${order.join(" → ")})`,
  );
  assert(
    next.pipelineState.prDraft?.status === "ready",
    "merged: the ready is recorded on the held state",
  );
}

process.exit(exit);

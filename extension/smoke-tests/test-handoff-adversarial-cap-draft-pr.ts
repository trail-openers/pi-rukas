#!/usr/bin/env bun
/**
 * #1402 — an adversarial-loop cap must not leave the work unreachable.
 *
 * At the last round only `CRITICAL_ISSUES_FOUND` blocks (#664), so the cap
 * `adversarial-loop` means the reviewer's final verdict was CRITICAL — and the
 * cycle routes straight from adversarial to handoff, skipping commit-pr. The
 * handoff consolidated the reviewed commits onto a LOCAL branch only: nothing
 * pushed, no PR (tehas cycle 238: 3h45m, three fix rounds, a one-line CRITICAL
 * fix the reviewer had already written out — and nothing anyone could fetch).
 *
 * Real-git test (temp repos and a bare temp "origin" only). Pins:
 *   1. the consolidated branch is pushed to origin;
 *   2. a DRAFT PR is opened for it, carrying the reviewer's findings;
 *   3. the PR is recorded (`prNumber`, `prDraft: draft`) so the handoff targets it
 *      and stays a draft — handoff is terminal, nothing marks it ready or merges;
 *   4. a cap that is NOT adversarial-loop does not push or open anything;
 *   5. `PI_ENSEMBLE_HANDOFF_DRAFT_PR=0` turns it off.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Forge } from "../src/forge.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runHandoff } from "../src/work-driver-handoff.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const g = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const BRANCH = "feature/issue-1402-adv-cap";
const FINDINGS =
  "VERDICT: CRITICAL_ISSUES_FOUND\n\n1. `--jq '.[].name'` fails against gh's real output; use `'.labels[].name'`.";

function buildRepo(): { root: string; dir: string; wt: string; baseSha: string } {
  const root = mkdtempSync(join(tmpdir(), "issue1402-"));
  const origin = join(root, "origin.git");
  const dir = join(root, "repo");
  mkdirSync(dir);
  g(["init", "--bare", "-b", "main", origin], root);
  g(["init", "-b", "main"], dir);
  g(["config", "user.name", "t"], dir);
  g(["config", "user.email", "t@t"], dir);
  writeFileSync(join(dir, "a.txt"), "base\n");
  g(["add", "-A"], dir);
  g(["commit", "-m", "base"], dir);
  g(["remote", "add", "origin", origin], dir);
  g(["push", "-u", "origin", "main"], dir);
  const baseSha = g(["rev-parse", "HEAD"], dir);
  const wt = join(dir, ".worktrees", "issue-1402-default");
  g(["worktree", "add", "--detach", wt, "HEAD"], dir);
  writeFileSync(join(wt, "stop.sh"), "gh issue view --json labels --jq '.[].name'\n");
  g(["add", "-A"], wt);
  g(["commit", "-m", "feat(stop): end a cycle"], wt);
  return { root, dir, wt, baseSha };
}

function stateFor(cap: string, baseSha: string, wt: string): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 1402,
    startedAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "running",
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      plumbReports: [],
      branchName: BRANCH,
      startRef: "main",
      baseSha,
      worktrees: { default: wt },
    },
    eventLog: [
      ...(cap === "adversarial-loop"
        ? [
            {
              kind: "adversarial-rejected" as const,
              at: 2,
              jobId: "j",
              rounds: 3,
              findings: FINDINGS,
            },
          ]
        : []),
      { kind: "cap-hit", at: 3, cap, reviewRound: 0, nextStep: "handoff" },
    ] as WorkState["eventLog"],
  };
}

interface Created {
  title: string;
  head: string;
  body: string;
  draft?: boolean;
}
function recordingForge(created: Created[]): Forge {
  return new Proxy({ forge: "github", host: "github.com", owner: "a", repo: "b" } as object, {
    get(target, prop) {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      if (prop === "then") return undefined;
      return async (...args: unknown[]) => {
        if (prop === "prCreate") {
          const [title, head, body, opts] = args as [string, string, string, { draft?: boolean }];
          created.push({ title, head, body, draft: opts?.draft });
          return { number: 77, url: "https://github.com/a/b/pull/77", headRefName: head };
        }
        if (prop === "issueView") return { number: 1402, title: "fix(stop): end a cycle" };
        if (prop === "labelCreate" || prop === "labelAdd") return undefined;
        throw new Error(`${String(prop)} unavailable`);
      };
    },
  }) as Forge;
}

const fakePi = { sendUserMessage: () => undefined } as unknown as ExtensionAPI;
const saved = {
  channel: process.env.PI_ENSEMBLE_HANDOFF_CHANNEL,
  toggle: process.env.PI_ENSEMBLE_HANDOFF_DRAFT_PR,
};
process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";

async function run(cap: string): Promise<{ next: WorkState; created: Created[]; remote: string }> {
  const { root, dir, wt, baseSha } = buildRepo();
  try {
    const created: Created[] = [];
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: 1402,
      forge: recordingForge(created),
      dispatchFn: async () => {
        throw new Error("no dispatch expected");
      },
    };
    const next = await runHandoff(ctx, stateFor(cap, baseSha, wt), Date.now());
    const remote = g(["ls-remote", "origin", BRANCH], dir);
    return { next, created, remote };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  // ── 1–3. adversarial-loop cap: the work is pushed and a draft PR carries the findings.
  {
    delete process.env.PI_ENSEMBLE_HANDOFF_DRAFT_PR;
    const { next, created, remote } = await run("adversarial-loop");
    assert(remote.includes(BRANCH), "adversarial-loop cap: the branch is pushed to origin");
    assert(created.length === 1, "adversarial-loop cap: exactly one PR is opened");
    const pr = created[0];
    assert(pr?.draft === true, "the PR is opened as a DRAFT");
    assert(pr?.head === BRANCH, "the PR heads the cycle's branch");
    assert(pr?.body.includes("'.labels[].name'") === true, "the PR body carries the findings");
    assert(pr?.body.includes("Fixes #1402") === false, "the draft does not auto-close the issue");
    assert(next.pipelineState.prNumber === 77, "the PR number is recorded for the handoff");
    assert(next.pipelineState.prDraft?.status === "draft", "the PR is recorded as a draft");
    assert(next.pipelineState.status === "handoff", "the cycle still ends in handoff");
    assert(
      next.pipelineState.handoffSnapshot?.branchPushed === true,
      "the handoff snapshot reports the branch as pushed",
    );
  }
  // ── 4. any other cap: no push, no PR (unchanged behaviour).
  {
    const { created, remote } = await run("verify-failed:develop");
    assert(created.length === 0 && remote === "", "another cap: nothing pushed, no PR");
  }
  // ── 5. escape hatch.
  {
    process.env.PI_ENSEMBLE_HANDOFF_DRAFT_PR = "0";
    const { created, remote } = await run("adversarial-loop");
    assert(created.length === 0 && remote === "", "PI_ENSEMBLE_HANDOFF_DRAFT_PR=0: off");
  }
} finally {
  for (const [k, v] of [
    ["PI_ENSEMBLE_HANDOFF_CHANNEL", saved.channel],
    ["PI_ENSEMBLE_HANDOFF_DRAFT_PR", saved.toggle],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

process.exit(exit);

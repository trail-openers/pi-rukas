#!/usr/bin/env bun
/**
 * #1565 — the generic recovery block ("inspect / discard / take over") must
 * run git where a repository was actually found. Live (tehas #329), the
 * handoff told the operator to run `git status` / `add -p` / `commit` /
 * `push` at a repoRoot that the same handoff's own snapshot read had just
 * proved is not a git repository, while the retained worktree holding the
 * work was named only in the "Worktree state" section.
 *
 * Both surfaces are checked: the GitHub body (cwd-relative, bare `git` means
 * repoRoot) and the chat message (`git -C <repoRoot>`). Recovery lines must
 * stay unchained — they land in the Pi chat, where the permission matcher
 * cannot wildcard `a && b`.
 */

import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { renderTerminalStatus } from "../src/work-status.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO = "/home/boss/tehas/work/tehas";
const WT = `${REPO}/.worktrees/issue-329-default`;
const BRANCH = "feature/issue-329-the-factory-resolves";
const NOT_A_REPO = `git rev-parse HEAD in ${REPO}: fatal: not a git repository (or any parent up to mount point /home/boss/tehas/work)`;

function state(opts: { worktrees: Record<string, string>; rootIsRepo: boolean }): WorkState {
  const paths = Object.values(opts.worktrees);
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 329,
    createdAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "develop",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: BRANCH,
      worktrees: opts.worktrees,
      handoffSnapshot: {
        modifiedFiles: [],
        unstagedCount: 0,
        stagedCount: 0,
        branchExists: false,
        branchPushed: false,
        repoRootHeadSha: opts.rootIsRepo ? "abc1234" : "",
        capturedAt: 1,
        ...(paths.length > 0 ? { retainedWorktrees: paths } : {}),
        ...(opts.rootIsRepo ? {} : { unreadable: [NOT_A_REPO] }),
      },
    },
    eventLog: [
      {
        kind: "cap-hit",
        at: 3,
        cap: "verify-failed:develop",
        reviewRound: 0,
        nextStep: "handoff",
        evidence: "empty diff",
      },
    ],
  } as WorkState;
}

/** The recovery block's command lines only (comments and fences dropped). */
function recoveryCommands(out: string, surface: "md" | "chat"): string[] {
  const start =
    surface === "md"
      ? out.indexOf("### Concrete recovery commands")
      : out.indexOf("What to do next");
  const tail = out.slice(start);
  const end = surface === "md" ? tail.indexOf("```", tail.indexOf("```bash") + 7) : tail.length;
  return tail
    .slice(0, end)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("```"));
}

const render = (s: WorkState): Array<[string, string[]]> => [
  ["md", recoveryCommands(renderHandoffMarkdown(s, REPO), "md")],
  ["chat", recoveryCommands(renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-329`), "chat")],
];

/** A git command aimed at repoRoot on either surface. */
const atRoot = (l: string) =>
  (/^git /.test(l) && !/^git -C /.test(l)) || l.startsWith(`git -C ${REPO} `);

// 1. The live shape: repoRoot is not a repo, one retained worktree.
for (const [name, cmds] of render(state({ worktrees: { default: WT }, rootIsRepo: false }))) {
  assert(cmds.length > 0, `${name}: the recovery block has commands (non-vacuity)`);
  assert(
    !cmds.some(atRoot),
    `${name}: no git command at a repoRoot proven not a repo (got ${cmds.filter(atRoot).join(" | ")})`,
  );
  assert(cmds.includes(`git -C ${WT} status`), `${name}: inspects the retained worktree`);
  assert(cmds.includes(`git -C ${WT} diff --stat`), `${name}: diffs the retained worktree`);
  assert(
    cmds.includes(`git -C ${WT} commit`) &&
      cmds.includes(`git -C ${WT} push origin HEAD:refs/heads/${BRANCH}`),
    `${name}: take-over commits + pushes from the worktree, not repoRoot`,
  );
  assert(
    !cmds.some((l) => /&&|\||;/.test(l)),
    `${name}: recovery commands stay unchained (no &&, |, ;)`,
  );
}

// 2. Nothing was found: repoRoot is not a repo, no worktree recorded.
for (const [name, cmds] of render(state({ worktrees: {}, rootIsRepo: false }))) {
  assert(
    !cmds.some((l) => l.startsWith("git ")),
    `${name}: no git command at all when no repository was found (got ${cmds.join(" | ")})`,
  );
}

// 3. Two retained worktrees: one branch each, never pushed over each other.
{
  const wts = { a: `${REPO}/.worktrees/issue-329-a`, b: `${REPO}/.worktrees/issue-329-b` };
  for (const [name, cmds] of render(state({ worktrees: wts, rootIsRepo: false }))) {
    assert(
      cmds.includes(`git -C ${wts.a} push origin HEAD:refs/heads/${BRANCH}-a`) &&
        cmds.includes(`git -C ${wts.b} push origin HEAD:refs/heads/${BRANCH}-b`),
      `${name}: each worktree pushes to its own branch`,
    );
  }
}

// 3b. /work-status prints the same recovery block in the terminal.
{
  const out = renderTerminalStatus(state({ worktrees: { default: WT }, rootIsRepo: false }), REPO);
  const block = out.slice(out.indexOf("Recovery commands"));
  assert(
    block.includes(`git -C ${WT} status`) && !/^\s+git (status|add|commit|push)/m.test(block),
    "work-status: recovery targets the worktree, not the non-repo repoRoot",
  );
}

// 4. Regression guard: a readable repoRoot with no worktree keeps the
//    repoRoot commands it always had.
for (const [name, cmds] of render(state({ worktrees: {}, rootIsRepo: true }))) {
  assert(
    cmds.some((l) => atRoot(l) && l.endsWith(`push -u origin ${BRANCH}`)),
    `${name}: a readable repoRoot still gets its take-over commands`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

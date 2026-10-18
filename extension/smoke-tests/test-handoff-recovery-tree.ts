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

type Snap = NonNullable<WorkState["pipelineState"]["handoffSnapshot"]>;
function state(opts: {
  worktrees: Record<string, string>;
  rootIsRepo: boolean;
  retained?: string[];
  unreadable?: string[];
  branchPushed?: boolean;
  branchExists?: boolean;
  prNumber?: number;
}): WorkState {
  const paths = opts.retained ?? Object.values(opts.worktrees);
  const unreadable = [...(opts.rootIsRepo ? [] : [NOT_A_REPO]), ...(opts.unreadable ?? [])];
  const snap: Snap = {
    modifiedFiles: [],
    unstagedCount: 0,
    stagedCount: 0,
    branchExists: opts.branchExists ?? false,
    branchPushed: opts.branchPushed ?? false,
    repoRootHeadSha: opts.rootIsRepo ? "abc1234" : "",
    capturedAt: 1,
    ...(paths.length > 0 ? { retainedWorktrees: paths } : {}),
    ...(unreadable.length > 0 ? { unreadable } : {}),
  };
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
      ...(opts.prNumber !== undefined ? { prNumber: opts.prNumber } : {}),
      handoffSnapshot: snap,
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

// 3c. Review F1 — a worktree whose own `git status` read proved it is not a
//     repository gets no commands; with none left, nothing git is printed.
{
  const wtFail = `git status in ${WT}: fatal: not a git repository: ${REPO}/.git/worktrees/issue-329-default`;
  const s = state({ worktrees: { default: WT }, rootIsRepo: false, unreadable: [wtFail] });
  for (const [name, cmds] of render(s)) {
    assert(
      !cmds.some((l) => l.startsWith("git ")),
      `${name} (F1): no git command for a worktree proven not a repo (got ${cmds.join(" | ")})`,
    );
  }
  const wts = { a: `${REPO}/.worktrees/issue-329-a`, b: `${REPO}/.worktrees/issue-329-b` };
  const half = state({
    worktrees: wts,
    rootIsRepo: false,
    unreadable: [`git status in ${wts.a}: fatal: not a git repository`],
  });
  for (const [name, cmds] of render(half)) {
    assert(
      !cmds.some((l) => l.startsWith(`git -C ${wts.a} `)) &&
        cmds.includes(`git -C ${wts.b} push origin HEAD:refs/heads/${BRANCH}-b`),
      `${name} (F1): only the readable worktree keeps its commands`,
    );
  }
}

// 3d. Review F2 — the branch suffix follows the RECORDED workstreams (as the
//     snapshot block does): one retained worktree of two never pushes to the
//     cycle's real branch, and a retained real path keeps its recorded id.
{
  const wts = { a: `${REPO}/.worktrees/issue-329-a`, b: `${REPO}/.worktrees/issue-329-b` };
  const real = "/mnt/real/.worktrees/issue-329-a";
  for (const retained of [[wts.a], [real]]) {
    const s = state({ worktrees: wts, rootIsRepo: false, retained });
    for (const [name, cmds] of render(s)) {
      const wt = retained[0];
      assert(
        cmds.includes(`git -C ${wt} push origin HEAD:refs/heads/${BRANCH}-a`) &&
          !cmds.some((l) => l.endsWith(`refs/heads/${BRANCH}`)),
        `${name} (F2): retained ${wt} of two pushes to ${BRANCH}-a, never ${BRANCH}`,
      );
    }
  }
}

// 3e. Review F3 — origin already has the branch: no push from the detached
//     worktree HEAD (non-fast-forward); point at the existing branch / PR.
for (const extra of [{ branchPushed: true }, { prNumber: 77 }]) {
  const s = state({ worktrees: { default: WT }, rootIsRepo: false, ...extra });
  for (const [name, cmds] of render(s)) {
    assert(
      !cmds.some((l) => / push /.test(l)) &&
        cmds.includes(`git -C ${WT} log --oneline HEAD --not origin/${BRANCH}`),
      `${name} (F3, ${JSON.stringify(extra)}): compares with origin's branch instead of pushing over it`,
    );
  }
  const md = renderHandoffMarkdown(s, REPO);
  assert(
    !md.includes("open the PR yourself") &&
      md.includes(`origin already has ${BRANCH}`) &&
      (extra.prNumber === undefined || md.includes("PR #77")),
    `md (F3, ${JSON.stringify(extra)}): names the existing branch/PR, not 'open the PR yourself'`,
  );
}

// 4. Regression guard: a readable repoRoot with no worktree keeps the
//    repoRoot commands it always had — when the branch exists (#747: with no
//    local ref, `push -u origin <branch>` is withheld).
for (const [name, cmds] of render(state({ worktrees: {}, rootIsRepo: true, branchExists: true }))) {
  assert(
    cmds.some((l) => atRoot(l) && l.endsWith(`push -u origin ${BRANCH}`)),
    `${name}: a readable repoRoot still gets its take-over commands`,
  );
}

// 4b. A readable repoRoot WITH a recorded worktree: intentionally changed —
//     the commands target the worktree (where the work is), never repoRoot.
for (const [name, cmds] of render(state({ worktrees: { default: WT }, rootIsRepo: true }))) {
  assert(
    !cmds.some(atRoot) &&
      cmds.includes(`git -C ${WT} status`) &&
      cmds.includes(`git -C ${WT} push origin HEAD:refs/heads/${BRANCH}`),
    `${name}: readable repoRoot + worktree → worktree commands only (got ${cmds.filter((l) => l.startsWith("git ")).join(" | ")})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

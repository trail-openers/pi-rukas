#!/usr/bin/env bun
/**
 * Keep the ops bash permission map explicit at the git boundary.
 *
 * A `git *` catch-all silently authorizes every git verb — including
 * mis-spelled or novel subcommands — and was the shape that let the wrapper
 * retirement leave ops with an un-narrowed grant while claiming the catch-all
 * was gone. The ops block must enumerate the git verbs its prompts
 * (agents-base/ops.md, the ops manifest modules, the /work driver's ops
 * fallback prompts) actually tell it to run, and nothing else: any git
 * command not explicitly allowed must fall to `*": "ask`.
 *
 * Offline assertion over the checked-in permission configuration, resolved
 * with the REAL matcher (matchBashSubcommand from src/bash-command-parser.ts)
 * so the verdicts are exactly what permission-guard.ts would return.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const agentsPath = path.resolve(import.meta.dirname, "..", "..", "agents.json");
const agents = JSON.parse(readFileSync(agentsPath, "utf8")) as {
  agent?: {
    ops?: {
      permission?: {
        bash?: Record<string, unknown>;
      };
    };
  };
};
const bash = (agents.agent?.ops?.permission?.bash ?? {}) as Record<string, string>;

// ---------------------------------------------------------------------------
// (1) No blanket grants
// ---------------------------------------------------------------------------

assert(!("gh api*" in bash), "ops has no blanket gh api* grant");
assert(!("git *" in bash), "ops has no `git *` catch-all row");
assert(bash["gh pr close*"] === "allow", "ops explicitly allows gh pr close*");
assert(bash["gh pr merge*"] === "allow", "ops explicitly allows gh pr merge*");
assert(bash["*"] === "ask", `ops bash default is ${JSON.stringify(bash["*"])}`);

// ---------------------------------------------------------------------------
// (2) Every git command the ops prompts tell it to run resolves to "allow"
//     via the real matcher. Source: agents-base/ops.md, the modules in
//     manifests/ops.manifest (git-workflow, tool-preferences, bash-final-
//     reminders, ci-monitoring, scope-boundaries), and the /work driver's
//     ops fallback prompts (work-driver-prompts-early.ts inlineBranchPrompt:
//     symbolic-ref/status/fetch/checkout/pull/rev-parse/branch -f/worktree
//     add; work-driver-prompts-late.ts commit-pr fallback: git -C … add/log/
//     diff/commit/push, git apply --3way, gh pr create; agents-base/ops.md
//     worktree add/remove/list, branch -d, cherry-pick --abort).
// ---------------------------------------------------------------------------

const { matchBashSubcommand } = await import("../src/bash-command-parser.ts");

const OPS_REQUIRED_GIT: string[] = [
  // agents-base/ops.md step 3: mainline detection + clean-tree precondition
  "git symbolic-ref refs/remotes/origin/HEAD",
  "git status --porcelain",
  "git fetch origin",
  "git checkout main",
  "git pull --ff-only origin main",
  "git branch --show-current",
  // branch creation (ops.md + inlineBranchPrompt step 4, incl. branch -f)
  "git checkout -b feature/issue-1-description",
  "git branch -f feature/issue-1-description deadbeef",
  "git rev-parse feature/issue-1-description",
  "git push -u origin feature/issue-1-description",
  // worktree workflow (ops.md + inlineBranchPrompt step 6)
  "git worktree add .worktrees/issue-1 -b feature/issue-1",
  "git worktree list",
  "git worktree remove .worktrees/issue-1",
  "git worktree remove --force .worktrees/issue-1",
  "git worktree prune",
  "git branch -d feature/issue-1",
  "git branch -D feature/issue-1",
  // commit-pr fallback (work-driver-prompts-late.ts): git -C-prefixed form
  // and the patch consolidation recipe
  "git -C /abs/path push -u origin feature/issue-1",
  "git -C /abs/path commit -m 'fix(scope): subject'",
  "git -C /abs/path add -- src/foo.ts",
  "git -C /abs/path log --oneline",
  "git -C /abs/path diff --cached --binary",
  "git -C /abs/path status --porcelain",
  "git apply --3way --binary --index tmp/issue-1/ws-1.patch",
  "git diff --name-only --cached",
  "git rev-parse --show-toplevel",
  // rebase / conflict-recovery verbs (ops.md abort recipe + rebase origin/…)
  "git rebase origin/main",
  "git rebase --abort",
  "git merge --abort",
  "git cherry-pick --abort",
  "git cherry-pick deadbeef",
  // read-only inspection verbs
  "git log --oneline",
  "git log -1 --format=%cd -- AGENTS.md",
  "git shortlog -sn --no-merges",
  "git for-each-ref --sort=-committerdate refs/heads",
  "git show HEAD",
  "git diff main -- src/foo.ts",
  "git remote get-url origin",
  "git rev-parse --abbrev-ref HEAD",
  "git merge-base --is-ancestor abcdef0123456789abcdef0123456789abcdef01 feature/issue-1",
  "git rev-list --count abcdef0123456789abcdef0123456789abcdef01..feature/issue-1",
  "git add -A",
  "git commit -m 'feat(scope): subject'",
];

let allAllow = true;
for (const cmd of OPS_REQUIRED_GIT) {
  const verdict = matchBashSubcommand(cmd, bash);
  if (verdict !== "allow") {
    allAllow = false;
    console.error(`  RESOLVES TO ${JSON.stringify(verdict)}: ${cmd}`);
  }
}
assert(
  allAllow,
  `every ops-required git command resolves to "allow" (${OPS_REQUIRED_GIT.length} commands)`,
);

if (exit === 0) console.log("\nAll ops allowlist checks passed.");
else console.log("\nFAILED");
process.exit(exit);

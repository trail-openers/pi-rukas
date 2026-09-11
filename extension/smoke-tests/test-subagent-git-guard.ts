#!/usr/bin/env bun
/**
 * Nothing may destroy work the harness has not captured yet.
 *
 * A validation subagent "cleaned up scratch commits" with `git checkout`,
 * wiped the uncommitted deliverable, then "restored" it by re-applying an
 * older patch — silently reverting two reviewed defect fixes. It was caught
 * only because a diffstat line count looked wrong.
 *
 * Nothing anywhere stopped it, at any layer:
 *
 *   - trust mode (the default on an interactive host) returns before any
 *     gating,
 *   - sandbox mode (the default in a container) returns before any gating,
 *   - and under strict opt-in the `oo git *` catch-all in agents.json allows
 *     it explicitly for developer, explore and ops.
 *
 * So the refusal cannot live in the allowlist, and it cannot live after the
 * bypasses either — placed there it would, in practice, never run. It sits
 * ahead of both, like `isDestructiveMemoryWrite`.
 *
 * The distinction that justifies overriding trust: the permission layers
 * answer "may this role run git?" — yes. This answers "may anything destroy
 * work nobody has captured?" — no. The container fence and the operator's
 * trust both protect the HOST; neither protects the developer's own diff.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { discardsUncommittedWork, rejectsInteractiveGit } from "../src/bash-command-parser.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------------ it catches

for (const cmd of [
  "git checkout .",
  "git checkout -- src/config/mod.rs",
  "git checkout -f",
  "git restore src/session/mod.rs",
  "git reset --hard HEAD",
  "git reset --hard origin/main",
  "git clean -fd",
  "git clean --force",
  // The shapes that actually appear in agent output.
  "cd /repo/.worktrees/issue-686-task-a && git checkout .",
  "git -C /repo/.worktrees/issue-686-task-a reset --hard",
  "oo git checkout -- .",
  "npm test; git checkout .",
  "git status && git clean -fdx",
]) {
  assert(discardsUncommittedWork(cmd) !== undefined, `canary: refused — ${cmd}`);
}

// -------------------------------------------------- and it does not overreach

for (const cmd of [
  // Switching branches: git itself refuses when it would clobber local edits.
  "git checkout main",
  "git checkout -b feature/issue-686",
  "git checkout -B feature/issue-686 abc123",
  // Index-only, loses nothing.
  "git reset",
  "git reset --soft HEAD~1",
  "git restore --staged src/a.ts",
  // Recoverable via `git stash list` — deliberately allowed.
  "git stash push -m wip",
  // Reading, and the ordinary work of a cycle.
  "git status --porcelain",
  "git diff --cached",
  "git add -A",
  "git commit -m 'fix'",
  "git clean -n",
  // A command that merely MENTIONS the phrase inside a quoted string.
  "gh pr comment 5 --body 'do not run git checkout . here'",
]) {
  assert(discardsUncommittedWork(cmd) === undefined, `allowed — ${cmd}`);
}

// ------------------------- the guard runs BEFORE trust and sandbox bypass

{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const src = readFileSync(path.join(SRC, "permission-subagent-guard.ts"), "utf8");
  const guardIdx = src.indexOf("registerDestructiveGitGuard(pi)");
  const sandboxIdx = src.indexOf("PI_ENSEMBLE_SANDBOX_MODE");
  const trustIdx = src.indexOf("PI_ENSEMBLE_TRUST_MODE");
  assert(guardIdx > 0, "the destructive-git guard is registered");
  assert(
    guardIdx < sandboxIdx && guardIdx < trustIdx,
    `canary: it is registered BEFORE both bypasses (guard=${guardIdx}, sandbox=${sandboxIdx}, trust=${trustIdx}) — after them it would never run, because both are defaults`,
  );
  // Denial must name a way forward. An agent told only "denied" retries the
  // same command by another route — which is how the original incident's
  // "restore" step re-applied a stale patch over reviewed fixes.
  assert(
    /git stash push/.test(src) && /git revert/.test(src) && /restore --staged/.test(src),
    "canary: the refusal names non-destructive alternatives rather than only saying no",
  );
  assert(
    /PI_ENSEMBLE_ALLOW_DESTRUCTIVE_GIT/.test(src),
    "an operator who genuinely needs it has an opt-out",
  );
  assert(
    /rejectsInteractiveGit\(command\)/.test(src),
    "the interactive-git refusal runs inside the same mode-independent guard",
  );
}

// ------------- the spawn env makes interactive git non-interactive (the seam)

{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const src = readFileSync(path.join(SRC, "spawn.ts"), "utf8");
  for (const v of ["GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_TERMINAL_PROMPT", "GIT_PAGER"]) {
    assert(src.includes(`${v} = `), `canary: childEnv sets ${v}`);
  }
  assert(
    /GIT_EDITOR = "true"/.test(src),
    "canary: GIT_EDITOR is the no-op binary (true), not a shell builtin",
  );
  assert(
    /GIT_PAGER = "cat"/.test(src),
    "canary: GIT_PAGER is cat so paged output never waits on a TTY",
  );
  assert(
    /GIT_TERMINAL_PROMPT = "0"/.test(src),
    "canary: credential prompts fail instead of waiting",
  );
  // Format-pinned canary (NOT a behavioural assertion): the assignments must
  // remain LEXICALLY AFTER the `...process.env` spread so they win over
  // inherited host env. It pins source layout (the spread literal itself), so
  // a cosmetic edit to childEnv construction must consciously update this
  // test. The behavioural contract (env wins) is proven by the value
  // assertions above plus the guard's own test cases.
  const spreadIdx = src.indexOf("{ ...process.env, PI_ENSEMBLE_ROLE: spec.role }");
  const gitEditorIdx = src.indexOf('GIT_EDITOR = "true"');
  assert(spreadIdx > 0 && gitEditorIdx > spreadIdx, "canary: the GIT_* assignments come AFTER the process.env spread, so they win over inherited host env");
}

// ------------------------------------------------------------ it catches

for (const cmd of [
  // The shapes that actually appear in agent output.
  "git rebase -i HEAD~3",
  "git rebase --interactive main",
  "git -C /repo rebase -i",
  "oo git rebase -i",
  "cd /repo && git rebase --interactive",
  "git rebase -i origin/main",
  // Bare commit: opens $EDITOR.
  "git commit",
  "git commit -a",
  "git commit --all",
  "git commit --allow-empty",
  "cd x && git commit",
]) {
  assert(rejectsInteractiveGit(cmd) !== undefined, `canary: refused — ${cmd}`);
}

// -------------------------------------------------- and it does not overreach

for (const cmd of [
  // Message on the line: no editor.
  "git commit -m 'fix'",
  "git commit --message 'fix'",
  "git commit --amend -m x",
  "git commit --amend --no-edit",
  "git commit -am 'wip'",
  "git commit -a -m 'fix'",
  // Non-interactive rebase.
  "git rebase main",
  "git rebase --abort",
  "git rebase --continue",
  "git rebase --skip",
  "git rebase --rebase-merges main",
  // A command that merely MENTIONS the phrase inside a quoted string.
  'echo "rebase -i"',
  "gh pr comment 5 --body 'do not run git commit without -m here'",
]) {
  assert(rejectsInteractiveGit(cmd) === undefined, `allowed — ${cmd}`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);

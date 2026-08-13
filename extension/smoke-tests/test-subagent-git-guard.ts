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
import { discardsUncommittedWork } from "../src/bash-command-parser.ts";

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
}

console.log(`\nexit ${exit}`);
process.exit(exit);

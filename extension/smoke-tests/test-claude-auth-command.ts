#!/usr/bin/env bun
/**
 * The pure matcher behind the `claude auth` guard, in both directions.
 *
 * The AC files prove the refusal reaches a child; this table proves the
 * MATCHER is the reason, since a guard built on `command.includes(…)` passes
 * every AC and is still wrong here. Each row is one of the two ways this
 * predicate can fail: anchored at word 0 (a chain is allowed) or matched as
 * text (a mention is refused).
 *
 * The runner is `bun extension/smoke-tests/test-claude-auth-command.ts`.
 */

import { runsClaudeAuth } from "../src/claude-auth-command.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

const REFUSED: Array<[string, string]> = [
  ["bare logout", "claude auth logout"],
  ["bare login", "claude auth login"],
  ["path-prefixed binary", "/usr/local/bin/claude auth logout"],
  ["semicolon chain", "git status; claude auth logout"],
  ["and-chain", "true && claude auth login"],
  ["pipe chain", "echo hi | claude auth logout"],
  ["newline chain", "echo hi\nclaude auth logout"],
  ["env assignment prefix", "env FOO=1 claude auth logout"],
  ["bare env assignment", "FOO=1 claude auth logout"],
  ["timeout wrapper", "timeout 30 claude auth login"],
  ["sudo wrapper", "sudo claude auth logout"],
  ["nested wrappers", "sudo env FOO=1 timeout 5 claude auth logout"],
  ["shell -c double-quoted", 'bash -c "claude auth logout"'],
  ["shell -c single-quoted", "sh -c 'claude auth login'"],
  ["shell -lc", "bash -lc 'claude auth logout'"],
  ["shell body behind a chain", "true && bash -c 'claude auth logout'"],
  ["command substitution", "echo $(claude auth logout)"],
  ["substitution inside a quoted arg", 'echo "$(claude auth logout)"'],
  ["nested substitution", "echo outer $(inner; claude auth logout) tail"],
  ["quoted group word", 'claude "auth" logout'],
  ["global option before the group", "claude --config /tmp auth logout"],
  ["flags after the verb", "claude auth logout --token abc123"],
];

const ALLOWED: Array<[string, string]> = [
  ["read-only status", "claude auth status"],
  ["version flag", "claude --version"],
  ["bare claude", "claude"],
  ["no group word", "claude logout"],
  ["group without a credential verb", "claude auth status --json"],
  ["grep pattern IS the command", 'grep "claude auth logout" notes.md'],
  ["rg pattern IS the command", "rg 'claude auth login' docs"],
  ["echo of the command", 'echo "claude auth logout"'],
  ["printf of the command", "printf 'claude auth login\\n'"],
  ["sed script holds the verb", "sed 's|claude auth logout|x|' file"],
  ["gh body-file mentions it", "gh issue edit 3 --body-file /tmp/body.md"],
  ["another CLI's auth", "gh auth logout"],
  ["flag value carries the phrase", "claude --message 'claude auth logout'"],
  ["verb glued to a flag", "claude auth --logout"],
  ["verb is a longer word", "claude auth logout-helper"],
  ["group is a longer word", "claude authenticate logout"],
  ["unterminated quote swallows the tail", "echo 'claude auth logout"],
  ["claude after a quoted word", "grep claude auth logout"],
  ["file named for the verb", "vim claude-auth-logout.md"],
  ["npm script", "npm test"],
];

for (const [label, command] of REFUSED) {
  assert(runsClaudeAuth(command) === true, `refused — ${label}: ${JSON.stringify(command)}`);
}
for (const [label, command] of ALLOWED) {
  assert(runsClaudeAuth(command) === false, `allowed — ${label}: ${JSON.stringify(command)}`);
}

// Empty and non-text input read as "nothing to match", never as a match.
assert(runsClaudeAuth("") === false, "the empty command is allowed");

console.log(`exit ${exit}`);
process.exit(exit);

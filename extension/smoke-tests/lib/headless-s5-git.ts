/**
 * The git rows of the headless S5 fixture's exec seam (#1025), split out to
 * keep `headless-s5-fixture.ts` under the 500-line cap (AGENTS.md §12).
 *
 * The seam answers `git` from the fixture's own throwaway repo, and it answers
 * ONLY the reads the cycle step genuinely makes. Anything outside the
 * whitelist is recorded as `unexpected` rather than answered with an empty
 * stdout — which is how the fixture stays honest about what a cycle actually
 * asked for.
 */

import { spawnSync } from "node:child_process";

/**
 * The git subcommands the seam answers from the fixture's own repo.
 *
 * A whitelist, not "starts with git": each entry is a read the cycle genuinely
 * makes. A two-word entry (`rev-parse --verify`) is matched on its first two
 * argv words because a bare `--verify` is not a read this fixture intends to
 * serve.
 */
const KNOWN_GIT_SUBCOMMANDS = new Set([
  "show",
  "rev-parse",
  "rev-parse --verify",
  "remote",
  "config",
  "symbolic-ref",
  // The merged outcome restores the operator's checkout (`restoreCheckout`):
  // the fetch that updates refs, the checkout, the status read that verifies
  // it, the rev-list count that decides whether a pull is warranted, the pull
  // itself, and the branch deletion of the merged branch. Only the
  // positive-control case reaches them, and there they are the contract.
  "fetch",
  "checkout",
  "status",
  "rev-list --count",
  "pull",
  "branch",
  // The merged step's teardown (`worktreeRemove` / `worktreePrune`).
  "worktree",
]);

/** The first two argv words, joined — the form two-word whitelist entries use. */
function subcommandPair(argv: string[]): string {
  return [argv[0], argv[1]]
    .filter((w) => w !== undefined && w !== "--")
    .join(" ")
    .trim();
}

/** Whether this argv-form `git` call is a read the fixture serves. */
export function isKnownGitSubcommand(argv: string[]): boolean {
  const pair = subcommandPair(argv);
  return KNOWN_GIT_SUBCOMMANDS.has(argv[0] ?? "") || KNOWN_GIT_SUBCOMMANDS.has(pair);
}

/** Run git in the fixture's repo, throwing the shape the exec seam's callers expect. */
export function runFixtureGit(args: string[], repoRoot: string): { stdout: string } {
  const child = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (child.status !== 0) {
    throw Object.assign(new Error(child.stderr?.slice(0, 200) ?? "git failed"), {
      stdout: child.stdout ?? "",
      stderr: child.stderr ?? "",
    });
  }
  return { stdout: child.stdout };
}

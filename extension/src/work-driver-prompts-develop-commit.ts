/**
 * work-driver-prompts-develop-commit — #1989: the develop step's commit seam,
 * in one exported constant so the develop prompt and its canary read the same
 * string.
 *
 * Two field shapes drove this. Hand-managed developers each said "done" some
 * 200 turns before their first commit and committed only when a PM steer
 * ordered it, and a lean build child was killed at its turn bound having made
 * edits and no commit at all. The old wording named "a clean build, a passing
 * test suite" as the seam, which reads as "wait for the suite" — so the first
 * commit sat behind the most expensive gate in the dispatch, and a budget kill
 * or a steer found the worktree clean. The seam is therefore EARLY, and every
 * commit is a NEW commit with its message on the command line, because a
 * `git commit` with no message opens an editor this environment has no TTY for
 * (see `rejectsInteractiveGit`). Amending is out entirely: two reviews showed
 * that "amend only your own unpushed commits, never the starting HEAD" cannot
 * be checked on a resumed or merged tree, and an amend can rewrite a commit a
 * reviewer already approved. PRs are squash-merged, so extra commits are free.
 */
export const DEVELOP_COMMIT_INSTRUCTION =
  'Commit your work in the worktree as soon as the change exists: run `git add -A` followed by `git commit -m "<concise subject — follow the project\'s commit convention from AGENTS.md, or <type>(scope): description>"`, then add further commits with `git commit -m "<subject>"` as you go. NEVER wait for a full test suite before your first commit. NEVER amend or rebase a commit — PRs are squash-merged so extra commits are free, and an amend can rewrite a commit a reviewer already approved. The verify gate REJECTS uncommitted-only work — no commit ahead of base SHA means the develop step fails. Do NOT push — the driver owns the branch and ops owns the push in Step 6.';

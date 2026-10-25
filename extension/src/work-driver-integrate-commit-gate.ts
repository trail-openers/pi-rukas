/**
 * work-driver-integrate-commit-gate — the cherry-pick/patch commit site's
 * publish check (#1788 follow-up, item 4), split out of
 * `work-driver-integrate.ts` along the 500-line seam AGENTS.md §12 asks for.
 *
 * `integrate()` has three sites that turn `commitTitle`/`commitBody` — prose
 * derived from the ISSUE title and body — into a commit. Two of them
 * (`work-driver-commit.ts`, `work-driver-integrate-ff.ts`) ask the publish seam
 * first. This file is the third: the cherry-pick/patch path commits staged
 * changes at repoRoot through its own exec, and a message that reaches git inside
 * an exec is a message no `tool_call` hook ever sees — so until now the
 * fast-forward path refused private issue prose while this one committed it to
 * the same branch by the other route.
 *
 * Same contract as the other two: the check runs BEFORE the exec, a refusal is a
 * returned REASON (never a throw — a commit the guard refused is a cycle that
 * parks with a reason the operator can act on), and nothing is committed and then
 * undone. The bytes the site commits are the bytes this gate judged: the
 * normalised title/body come back from {@link cherryPickCommitGate} in
 * `work-driver-commit-message-publish.ts`, which owns that shape for both of
 * integrate()'s commit sites.
 */

export { cherryPickCommitGate } from "./work-driver-commit-message-publish.ts";

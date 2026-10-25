/**
 * work-driver-integrate-commit-gate — the cherry-pick/patch commit site's
 * publish check (#1788 follow-up, item 4), split out of
 * `work-driver-integrate.ts` along the 500-line seam AGENTS.md §12 asks for.
 *
 * `integrate()` has three sites that turn `commitTitle`/`commitBody` — prose
 * derived from the ISSUE title and body — into a commit. Two of them
 * (`work-driver-commit.ts`, `work-driver-integrate-ff.ts`) ask
 * `commitMessageRefusal` first. This file is the third: the cherry-pick/patch
 * path commits staged changes at repoRoot through its own exec, and a message
 * that reaches git inside an exec is a message no `tool_call` hook ever sees —
 * so until now the fast-forward path refused private issue prose while this one
 * committed it to the same branch by the other route.
 *
 * Same contract as the other two: the check runs BEFORE the exec, a refusal is
 * a returned REASON (never a throw — a commit the guard refused is a cycle that
 * parks with a reason the operator can act on), and nothing is committed and
 * then undone.
 */

import { trace } from "./trace.ts";
import { commitMessageRefusal } from "./work-driver-commit-hygiene.ts";
import type { IntegrateOpts, IntegrateResult } from "./work-driver-integrate.ts";
import type { VerifiedRestoreResult } from "./work-driver-restore.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * Judge the commit message the cherry-pick/patch path is about to write.
 *
 * Returns the `{ ok: false, failure: "apply" }` result the caller returns
 * verbatim when the message is refused, and `undefined` when the commit may
 * proceed. `restoreRoot`/`claimFor` are the caller's verified-restore pair —
 * the same ones every other pre-push exit of `integrate()` uses, so a refusal
 * leaves repoRoot in the state the operator was told about rather than the state
 * the half-applied batch left it in.
 */
export async function cherryPickCommitGate(
  execFn: ExecFn,
  opts: Pick<IntegrateOpts, "commitTitle" | "commitBody" | "issue">,
  repoRoot: string,
  restoreRoot: () => Promise<VerifiedRestoreResult>,
  claimFor: (r: VerifiedRestoreResult) => string,
): Promise<IntegrateResult | undefined> {
  const messageRefusal = await commitMessageRefusal(opts.commitTitle, opts.commitBody, {
    cwd: repoRoot,
    issue: opts.issue ?? 0,
    exec: execFn,
  });
  if (messageRefusal === undefined) return undefined;
  const restore = await restoreRoot();
  trace(`work-driver: integrate — cherry-pick commit refused for #${opts.issue ?? "?"}`);
  return {
    ok: false,
    failure: "apply",
    reason: `${messageRefusal} ${claimFor(restore)}.`,
  };
}

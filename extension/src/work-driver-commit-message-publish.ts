/**
 * work-driver-commit-message-publish — the committed message IS the checked
 * message (#1820 lens round 1).
 *
 * Every driver commit site used to ask {@link commitMessageRefusal} and then
 * commit `opts.commitTitle`/`opts.commitBody` — the strings it started with. That
 * is sound only while the seam is a pure refuse/allow question. It is not: on the
 * public-or-unknown branch the driver seam rewrites this host's paths out of the
 * message (`<repo>/…`, `~/…`), so those sites judged one string and published
 * another. The rewrite silently did nothing at three of the four commit sites,
 * and the module that documents the invariant ("the bytes written equal the bytes
 * judged") was contradicted by the code that writes.
 *
 * This module is the one way a driver commit site answers that question: it
 * returns the title and body to `git commit -m`, or the refusal. Both integrate()
 * commit sites call it — the cherry-pick/patch path (`work-driver-integrate.ts`'s
 * own exec) and the fast-forward path (`work-driver-integrate-ff.ts`) — and each
 * commits what it returns rather than what it was handed.
 *
 * It delegates to {@link commitMessageForPublish} rather than restating the rule:
 * that function owns the split back into title/body and the refusal sentence.
 * This one owns the SHAPE each commit site expects, so the two paths cannot
 * disagree about what a refusal looks like.
 */

import { trace } from "./trace.ts";
import { commitMessageForPublish } from "./work-driver-commit-hygiene.ts";
import type { IntegrateResult } from "./work-driver-integrate-result.ts";
import type { VerifiedRestoreResult } from "./work-driver-restore.ts";
import type { ExecFn } from "./worktree.ts";

/** The prose one commit site holds: the issue-derived subject and body. */
export interface CommitMessageParts {
  commitTitle: string;
  commitBody: string;
  /** The issue the message derives from — named in the refusal and trace only. */
  issue?: number;
}

/** The message a driver commit site commits, or the reason it may not. */
export type CommitMessagePublish =
  | { refusal?: undefined; title: string; body: string }
  | { refusal: string; title: string; body: string };

/**
 * The title/body to commit, or the refusal — the question both integrate()
 * commit sites ask before they touch git.
 */
export async function commitMessageToPublish(
  execFn: ExecFn,
  opts: CommitMessageParts,
  cwd: string,
): Promise<CommitMessagePublish> {
  const checked = await commitMessageForPublish(opts.commitTitle, opts.commitBody, {
    cwd,
    issue: opts.issue ?? 0,
    exec: execFn,
  });
  return checked.refusal === undefined
    ? { title: checked.title, body: checked.body }
    : { refusal: checked.refusal, title: checked.title, body: checked.body };
}

/**
 * Judge the commit message the cherry-pick/patch path is about to write, and
 * hand back the bytes to write.
 *
 * Returns the `{ ok: false, failure: "apply" }` result the caller returns
 * verbatim when the message is refused, and the title/body to commit when it is
 * not. `restoreRoot`/`claimFor` are the caller's verified-restore pair — the
 * same ones every other pre-push exit of `integrate()` uses, so a refusal leaves
 * repoRoot in the state the operator was told about rather than the state the
 * half-applied batch left it in.
 *
 * The gate runs BEFORE anything is committed, and the caller passes the returned
 * title/body to its own exec: a message that reaches git inside an exec is a
 * message no `tool_call` hook ever sees, so this is the only place it is read.
 */
export async function cherryPickCommitGate(
  execFn: ExecFn,
  opts: CommitMessageParts,
  repoRoot: string,
  restoreRoot: () => Promise<VerifiedRestoreResult>,
  claimFor: (r: VerifiedRestoreResult) => string,
): Promise<{ refusalResult: IntegrateResult } | { title: string; body: string }> {
  const checked = await commitMessageToPublish(execFn, opts, repoRoot);
  if (checked.refusal === undefined) return { title: checked.title, body: checked.body };
  const restore = await restoreRoot();
  trace(`work-driver: integrate — cherry-pick commit refused for #${opts.issue ?? "?"}`);
  return {
    refusalResult: {
      ok: false,
      failure: "apply",
      reason: `${checked.refusal} ${claimFor(restore)}.`,
    },
  };
}

/**
 * work-driver-merged-direct — the direct-`gh` merge path (#1533 split).
 *
 * When the cycle's forge cannot be resolved (`forgeForCycle` returns undefined)
 * the mechanized merge cannot go through the forge adapter, and this file's
 * function builds the `gh` command itself. That makes it a second, independent
 * implementation of "merge a PR and prove it merged", which is why every rule
 * the adapter path has had to be restated here — and why it lives on its own:
 *
 *  - the **subject** travels through the same public-hygiene driver seam as the
 *    adapter's `prMerge` (#1788), returning the caller's own failure shape
 *    rather than throwing;
 *  - the **head pin** (#1533) is required: this path builds the command with
 *    `prMergeHeadPinFlag`, so the fallback is not a route past the pin the
 *    adapter enforces;
 *  - **refusals** are classified in a fixed order — a refused pin before the
 *    "already been merged" tolerance and before the permanent-error bucket,
 *    because each mis-read produces a different lie (a merge that never
 *    happened, or an LLM retry against a moved head).
 *
 * `gh pr view` is asked twice: once before, so a crash between merge and
 * verification resumes as success rather than re-merging, and once after, to
 * confirm. The post-merge read distinguishes a PERMANENT forge failure (401 /
 * 403 / 404 / "not found" — the operator must fix something, so this is
 * `ok: false`, never the warning shape) from a transient transport blip after a
 * merge that did succeed (`{ merged: true, warningNote }`, #356): re-running the
 * merge is impossible and would be worse than reporting it unverified.
 */

import { prMergeHeadPinFlag, prMergeSubjectFlag } from "./forge-commands.ts";
import { driverPublishCheck } from "./public-hygiene-driver.ts";
import type { VisibilityFn } from "./public-hygiene-visibility.ts";
import { trace } from "./trace.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import type { MergeMethod } from "./work-driver-merged-pin.ts";
import { isHeadPinRefusal, pinRefusalReason } from "./work-driver-merged-pin.ts";
import type { ExecFn } from "./worktree.ts";

/** The result shape this module shares with the adapter path. */
export type DirectMergeResult =
  | { merged: true; warningNote?: string }
  | { ok: false; reason: string };

/** The `gh pr view` read this path asks twice. */
const STATE_QUERY = (prNumber: number): string =>
  `gh pr view ${prNumber} --json state --jq '.state'`;

/**
 * Merge via the direct `gh` exec seam and verify the result.
 *
 * `visibility` is the seam for this path's own public-only gate (#1788 round
 * 2): production leaves it undefined and the check asks `gh`; a test passes a
 * stub so "a private repository is not refused" can be stated without a forge.
 * The adapter path gets its visibility from the adapter itself.
 */
export async function executeAndVerifyMergeDirect(
  prNumber: number,
  method: MergeMethod,
  execFn: VerifyExecFn,
  repoRoot: string,
  subject: string | undefined,
  // #1533 — the verified head OID; REQUIRED and already shape-validated by the
  // caller, so this path cannot merge unpinned while the adapter path is pinned.
  headOid: string,
  visibility?: VisibilityFn,
): Promise<DirectMergeResult> {
  // First check: is the PR already merged? (idempotent on resume)
  try {
    const { stdout } = await execFn(STATE_QUERY(prNumber), {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (stdout.trim() === "MERGED") {
      trace(`work-driver: PR #${prNumber} already merged, skipping merge invocation`);
      return { merged: true };
    }
  } catch (err) {
    trace(`work-driver: pre-check gh pr view failed: ${(err as Error).message?.slice(0, 120)}`);
  }

  // The subject a squash merge writes to main is public text, and this is the
  // one forge write a cycle cannot undo. The forge adapter's `prMerge` checks it
  // through `checkPublicText`; this direct-exec fallback builds the same command
  // itself and reaches no adapter, so it goes through the SAME driver seam —
  // one rule, one owner, one public-only gate, and a fallback that cannot become
  // the way past either. The pure `publicTextRefusal` it used to call asked
  // nothing about the repository, so a private project had its merge subject
  // refused here while the adapter path skipped the same text (#1788 round 2).
  // It returns the function's OWN failure shape rather than throwing, for the
  // reason spelled out on the adapter path in the caller: `runMerged` routes on
  // the result, and a merge the guard refused is a merge that parks with a
  // reason, not an exception that escapes the step.
  // `mergeSubject` is the subject the merge actually writes: the checked text,
  // with this clone's paths rewritten out of it on a public target (#1788
  // follow-up). A local rather than a reassignment of the parameter.
  let mergeSubject = subject;
  if (subject !== undefined) {
    const checked = await driverPublishCheck("merge commit subject", subject, {
      command: "gh pr merge",
      cwd: repoRoot,
      // `VerifyExecFn` and the guard's `ExecFn` differ only in optionality of
      // the options bag; the seam accepts either shape and passes it through.
      exec: execFn as unknown as ExecFn,
      visibility,
      repoRoot,
    });
    if (checked.refusal !== undefined) {
      const refusal = checked.refusal;
      trace(`work-driver: merge subject refused for PR #${prNumber}: ${refusal.slice(0, 200)}`);
      return { ok: false, reason: refusal };
    }
    mergeSubject = checked.text;
  }

  // Execute the merge. The command is built by the same builders the adapter
  // uses, so the pin and the subject cannot be spelled differently here.
  try {
    await execFn(
      `gh pr merge ${prNumber} --${method} --delete-branch${prMergeSubjectFlag(mergeSubject)}${prMergeHeadPinFlag("github", headOid)}`,
      {
        cwd: repoRoot,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const message = (e.stderr ?? e.message ?? "").toString();
    // #1533 — before "already been merged" and before the permanent classifier.
    if (isHeadPinRefusal(message)) {
      trace(`work-driver: PR #${prNumber} head pin refused on the direct path — no merge`);
      return { ok: false, reason: pinRefusalReason(message) };
    }
    if (/already been merged/i.test(message)) {
      trace(`work-driver: PR #${prNumber} was already merged during gh pr merge invocation`);
      return { merged: true };
    }
    return {
      ok: false,
      reason: `gh pr merge failed: ${message.slice(0, 300)}`,
    };
  }

  return verifyDirectMergeState(prNumber, execFn, repoRoot);
}

/** The post-merge read: MERGED is success, a permanent error is a failure. */
async function verifyDirectMergeState(
  prNumber: number,
  execFn: VerifyExecFn,
  repoRoot: string,
): Promise<DirectMergeResult> {
  try {
    const { stdout } = await execFn(STATE_QUERY(prNumber), {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (stdout.trim() !== "MERGED") {
      return {
        ok: false,
        reason: `gh pr merge succeeded but PR #${prNumber} state is ${stdout.trim()}, not MERGED`,
      };
    }
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const msg = e.message ?? "unknown";
    // Distinguish a deterministically PERMANENT forge failure from a transient
    // transport blip. The taxonomy is shared: the CLI's stderr carries the same
    // 4xx/"not found" wording `judgePrIdentity` (work-driver-git.ts) and the
    // mainline resolution paths match on — a permanent failure will keep failing
    // until the operator fixes auth or the PR, so #356's merged-with-warning
    // behaviour must NOT swallow it. Reporting it as merged-success would leave
    // an unverifiable merge looking green.
    const permanent = /\b(401|403|404)\b|not found|could not resolve/i.test(
      `${e.stderr ?? ""}\n${msg}`,
    );
    if (permanent) {
      trace(`work-driver: permanent post-merge verification failure: ${msg.slice(0, 200)}`);
      return {
        ok: false,
        reason: `post-merge verification failed with a permanent gh error: ${msg.slice(0, 300)}`,
      };
    }
    const note = `post-merge verification inconclusive (gh pr view error: ${msg.slice(0, 200) ?? "unknown"})`;
    trace(`work-driver: ${note}`);
    return { merged: true, warningNote: note };
  }

  return { merged: true };
}

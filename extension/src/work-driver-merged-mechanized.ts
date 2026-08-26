/**
 * work-driver-merged-mechanized — mechanized PR merge for the `merged` step.
 *
 * Extracted into a separate file to protect work-driver-merged.ts's
 * budget (266 lines, 500-line hard cap). Follows the mechanizedCommitPr
 * pattern: direct execution of enumerable git/gh operations; fallback
 * to LLM ops dispatch on any mechanized failure.
 *
 * Merge method is derived from GitHub repo settings via `gh repo view`.
 * GitHub is authoritative and cannot drift — no local config file needed.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import type { WorkState } from "./workflow-state.ts";

const execp = promisify(exec);

/** Valid merge methods — maps to `gh pr merge` flags. */
export type MergeMethod = "squash" | "merge" | "rebase";

/**
 * Derive the merge method from GitHub repo settings.
 *
 * Makes ONE `gh repo view` call and applies precedence:
 *   1. `squashMergeAllowed` → squash
 *   2. `mergeCommitAllowed` → merge
 *   3. `rebaseMergeAllowed` → rebase
 *   4. All false / all null / call fails → fallback
 *
 * Squash is preferred when multiple are allowed — matches common default
 * and this project's convention.
 */
export async function deriveMergeMethod(
  execFn: VerifyExecFn,
  repoRoot: string,
): Promise<{ method: MergeMethod } | { fallback: true; note: string }> {
  try {
    const { stdout } = await execFn(
      "gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed",
      { cwd: repoRoot, maxBuffer: 64 * 1024 },
    );
    const parsed = JSON.parse(stdout);

    if (parsed.squashMergeAllowed === true) {
      return { method: "squash" };
    }
    if (parsed.mergeCommitAllowed === true) {
      return { method: "merge" };
    }
    if (parsed.rebaseMergeAllowed === true) {
      return { method: "rebase" };
    }
    return {
      fallback: true,
      note: `no merge method permitted by repo settings (squashMergeAllowed=${parsed.squashMergeAllowed}, mergeCommitAllowed=${parsed.mergeCommitAllowed}, rebaseMergeAllowed=${parsed.rebaseMergeAllowed}) — falling back to LLM dispatch`,
    };
  } catch (err) {
    return {
      fallback: true,
      note: `gh repo view failed (${(err as Error).message?.slice(0, 120)}) — falling back to LLM dispatch`,
    };
  }
}

/**
 * Execute `gh pr merge` with the resolved method and verify the result.
 *
 * Idempotent on resume: if the PR is already merged, treats that as
 * success and returns immediately. This is what makes a crash mid-
 * restoration recoverable.
 *
 * #356 — post-merge verification distinguishes two failure modes:
 *   - The `gh pr view` call itself throws (transient `gh` error) AFTER
 *     `gh pr merge` already succeeded → returns `{ merged: true, warningNote }`.
 *     Re-running the merge is impossible and a retry is out of scope;
 *     the merged event still fires with a warning note.
 *   - `gh pr view` returns a state other than MERGED → genuine failure,
 *     returns `{ ok: false }`.
 *
 * Returns `{ merged: true, warningNote? }` on success, `{ ok: false }` on failure.
 */
export async function executeAndVerifyMerge(
  prNumber: number,
  method: MergeMethod,
  execFn: VerifyExecFn,
  repoRoot: string,
): Promise<{ merged: true; warningNote?: string } | { ok: false; reason: string }> {
  // First check: is the PR already merged? (idempotent on resume)
  try {
    const { stdout } = await execFn(`gh pr view ${prNumber} --json state --jq '.state'`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (stdout.trim() === "MERGED") {
      trace(`work-driver: PR #${prNumber} already merged, skipping merge invocation`);
      return { merged: true };
    }
  } catch (err) {
    // gh pr view failed — try the merge anyway; it may fail with "already merged" too.
    trace(`work-driver: pre-check gh pr view failed: ${(err as Error).message?.slice(0, 120)}`);
  }

  // Execute the merge.
  try {
    await execFn(`gh pr merge ${prNumber} --${method} --delete-branch`, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const message = (e.stderr ?? e.message ?? "").toString();
    // If the error indicates the PR is already merged, treat as success.
    if (/already been merged/i.test(message)) {
      trace(`work-driver: PR #${prNumber} was already merged during gh pr merge invocation`);
      return { merged: true };
    }
    return {
      ok: false,
      reason: `gh pr merge failed: ${message.slice(0, 300)}`,
    };
  }

  // Post-merge verification: gh pr view must return MERGED.
  try {
    const { stdout } = await execFn(`gh pr view ${prNumber} --json state --jq '.state'`, {
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
    // Distinguish a deterministically PERMANENT gh failure from a transient
    // transport blip. The taxonomy is shared: `gh`'s stderr carries the same
    // 4xx/"not found" wording `judgePrIdentity` (work-driver-git.ts) and the
    // mainline resolution paths match on — a permanent failure will keep
    // failing until the operator fixes auth or the PR, so #356's
    // merged-with-warning behaviour must NOT swallow it. Reporting it as
    // merged-success would leave an unverifiable merge looking green.
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
    // #356 — TRANSIENT failure: the merge command succeeded (gh pr merge
    // exited 0); the verification call itself hit a gh/network error.
    // Returning ok:false here would cause the caller to emit a false
    // merge-failure plumb-report and fall back to an LLM ops dispatch
    // against an already-merged PR. The merged event still fires; a
    // warning note records that post-merge state verification was
    // inconclusive.
    const note = `post-merge verification inconclusive (gh pr view error: ${msg.slice(0, 200) ?? "unknown"})`;
    trace(`work-driver: ${note}`);
    return { merged: true, warningNote: note };
  }

  return { merged: true };
}

/**
 * Mechanized merge: derive method → execute → verify.
 *
 * ANY failure returns `{ok: false, reason}` — the caller in runMerged
 * emits a plumb-report and falls back to the LLM ops dispatch.
 *
 * On success, returns the resolved merge method (for the merged event
 * and any fallback dispatch that follows) plus any notes from the
 * derive step.
 */
export async function mechanizedMerge(
  ctx: DriverContext,
  state: WorkState,
): Promise<
  | { ok: true; method: MergeMethod; notes: string[] }
  | { ok: false; reason: string; method?: MergeMethod }
> {
  // #380 — this used to read `ctx.verifyExecFn` with no fallback, unlike
  // every other consumer of the seam. `verifyExecFn` is a TEST injection point
  // and is never assigned in production, so mechanized merge always returned
  // `ok: false` and every real merge went down the LLM-narrated path. That
  // also silently disabled `restoreCheckout`, since `mergeSucceeded` is only
  // set on this branch — which is why repoRoot was left sitting on the merged
  // feature branch after a cycle.
  const execFn = ctx.verifyExecFn ?? execp;

  const prNumber = state.pipelineState.prNumber;
  if (!prNumber) {
    return { ok: false, reason: "prNumber not set in pipeline state" };
  }

  // Derive merge method from GitHub repo settings.
  const methodResult = await deriveMergeMethod(execFn, ctx.repoRoot);
  if ("fallback" in methodResult) {
    trace(`work-driver: merge method fallback: ${methodResult.note}`);
    return { ok: false, reason: methodResult.note };
  }

  // Execute and verify the merge.
  const mergeResult = await executeAndVerifyMerge(
    prNumber,
    methodResult.method,
    execFn,
    ctx.repoRoot,
  );
  if (!("merged" in mergeResult)) {
    return { ok: false, reason: mergeResult.reason, method: methodResult.method };
  }

  const notes: string[] = mergeResult.warningNote ? [mergeResult.warningNote] : [];
  trace(`work-driver: PR #${prNumber} merged via --${methodResult.method} ✓`);
  return { ok: true, method: methodResult.method, notes };
}

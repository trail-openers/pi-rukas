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

import { trace } from "./trace.ts";
import { mechanizeOpsEnabled } from "./work-driver-commit.ts";
import type { DriverContext } from "./work-driver-context.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import type { WorkState } from "./workflow-state.ts";

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
 * Returns `{ merged: true }` on success, `{ ok: false }` on failure.
 */
export async function executeAndVerifyMerge(
  prNumber: number,
  method: MergeMethod,
  execFn: VerifyExecFn,
  repoRoot: string,
): Promise<{ merged: true } | { ok: false; reason: string }> {
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
    return {
      ok: false,
      reason: `post-merge verification failed: ${(err as Error).message?.slice(0, 200)}`,
    };
  }

  return { merged: true };
}

/**
 * Mechanized merge: derive method → execute → verify.
 *
 * ANY failure returns `{ok: false, reason}` — the caller in runMerged
 * emits a plumb-report and falls back to the LLM ops dispatch.
 *
 * Escape hatch: PI_ENSEMBLE_MECHANIZE_OPS=0 bypasses this entirely,
 * forcing the LLM ops path (same as mechanizedCommitPr).
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
  if (!mechanizeOpsEnabled()) {
    // Mechanized ops disabled — return squash as the prompt hint.
    // The LLM has AGENTS.md in context and will use the repo's actual policy.
    return {
      ok: false,
      reason: "PI_ENSEMBLE_MECHANIZE_OPS=0 — mechanized ops disabled",
      method: "squash",
    };
  }

  const execFn = ctx.verifyExecFn;
  if (!execFn) {
    return {
      ok: false,
      reason: "verifyExecFn not injected — mechanized merge requires exec injection",
    };
  }

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

  trace(`work-driver: PR #${prNumber} merged via --${methodResult.method} ✓`);
  return { ok: true, method: methodResult.method, notes: [] };
}

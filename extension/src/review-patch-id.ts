/**
 * review-patch-id — the ONE range patch-id definition the review ledger is
 * compared against (#1161, round 2).
 *
 * The adversarial writer (adversarial-ledger.ts) records a range review's
 * patch id, and the merge guard (merge-guard.ts, via branchPatchId) recomputes
 * it. Both call rangePatchId here, so the two cannot drift. Split out of
 * review-ledger.ts (500-line cap); review-ledger.ts re-exports branchPatchId.
 *
 * Form: THREE-DOT (`base...head`) on both sides — the diff from the merge-base
 * to the head, i.e. the branch's own change from its fork point, which is the
 * change a squash merge lands. The reviewer judges this same diff.
 */

import { trace } from "./trace.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

/** One `git patch-id` line (`<id> <path>`) → the id, or undefined when empty. */
export function parsePatchId(stdout: string, label: string): string | undefined {
  const id = stdout.trim().split(/\s+/)[0]?.trim();
  if (!id) trace(`review-ledger: patch-id was empty for ${label}`);
  return id;
}

/** git's own words for a failed command: the message plus its stderr. */
function execErrorText(err: unknown): string {
  const e = err as { message?: unknown; stderr?: unknown };
  const message = typeof e.message === "string" ? e.message : String(err);
  const stderr = typeof e.stderr === "string" ? e.stderr.trim().slice(0, 300) : "";
  return `${message.slice(0, 200)}${stderr ? ` | git stderr: ${stderr}` : ""}`;
}

/**
 * The patch id of the range `base...head`, fed through `git patch-id --stable`.
 *
 * Argv form throughout: `git diff` and `git patch-id` are separate calls, the
 * diff is handed to patch-id on stdin, and no shell is involved, so a failing
 * `git diff` (bad ref) is traced with git's stderr instead of becoming an
 * empty diff. A leading `-` in either ref is refused (argument injection).
 *
 * Returns undefined on refusal, an empty diff, or any failure; the caller
 * decides what that means (the writer writes no row, the guard refuses).
 */
export async function rangePatchId(
  execFn: VerifyExecFn,
  cwd: string,
  base: string,
  head: string,
): Promise<string | undefined> {
  if (base.startsWith("-") || head.startsWith("-")) {
    trace("adversarial: refused range ref starting with '-'");
    return undefined;
  }
  const label = `${base}...${head}`;
  let diff: string;
  try {
    ({ stdout: diff } = await execFn("git", {
      cwd,
      argv: ["diff", label],
      maxBuffer: 1024 * 1024,
    }));
  } catch (err) {
    trace(`review-patch-id: git diff ${label} failed: ${execErrorText(err)}`);
    return undefined;
  }
  if (!diff.trim()) {
    trace(`review-patch-id: range ${label} has no patch id (empty diff)`);
    return undefined;
  }
  try {
    const { stdout } = await execFn("git", {
      cwd,
      argv: ["patch-id", "--stable"],
      input: diff,
      maxBuffer: 8 * 1024,
    });
    return parsePatchId(stdout, label);
  } catch (err) {
    trace(`review-patch-id: git patch-id for ${label} failed: ${execErrorText(err)}`);
    return undefined;
  }
}

/**
 * The patch id of a branch's changes: the diff from `baseRef` to the branch
 * head, fed through `git patch-id --stable`. The writer and the guard both
 * call this, so the same content always yields the same id (and a new commit
 * always changes it).
 *
 * Returns undefined when the diff is empty or patch-id fails — the caller
 * decides the fail-closed meaning.
 *
 * #1161 — the form is three-dot, not the two-dot tree comparison this once
 * was: it is `rangePatchId(baseRef, branchRef)`, the merge-base to the head.
 * A base that moved past the fork point therefore does not appear as reversed
 * changes; the guard refuses that case separately (merge-guard.ts).
 */
export async function branchPatchId(
  execFn: VerifyExecFn,
  cwd: string,
  branchRef: string,
  baseRef: string,
): Promise<string | undefined> {
  try {
    return await rangePatchId(execFn, cwd, baseRef, branchRef);
  } catch (err) {
    trace(`review-ledger: patch-id failed for ${branchRef}: ${(err as Error).message}`);
    return undefined;
  }
}

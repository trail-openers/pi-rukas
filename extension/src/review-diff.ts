/**
 * review-diff — tool-side git ref-range diff computation (#859).
 *
 * `adversarial_loop` and `dispatch_lens_review` accept `base`/`head` ref
 * names and compute the diff themselves instead of receiving a pasted
 * string. This module is the one seam that reads such a range:
 * `git diff <base>...<head>` (three-dot, merge-base semantics) run via
 * execFile — no shell, so a PM-typed ref can never inject commands.
 *
 * Refs are validated first with `git rev-parse --verify --quiet
 * <ref>^{commit}`; an invalid ref produces an error that NAMES the ref
 * rather than an empty-string fallback (the bug class #384 closed for the
 * driver's integrated-diff read). Emptiness is established POSITIVELY,
 * the same way as #384's `readIntegratedDiff`: an empty range is a
 * distinct "empty diff" error, never a value a caller can mistake for
 * "nothing to review" (and never an APPROVED verdict).
 *
 * The 1 MiB cap matches `fetchDiff`/`readIntegratedDiff` in
 * work-driver-diff.ts: this feature exists so a ~3.4k-line diff stops
 * bloating the PM's context, so the guard must not be dropped when the
 * diff moves from PM-side to tool-side.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const DIFF_MAX_BUFFER = 1024 * 1024;

export type RangeDiff = { ok: true; diff: string } | { ok: false; reason: string };

/** True when a diff was produced beyond the cap (the tail was cut). */
export function diffOverflow(stderr: string): boolean {
  return /E2BIG|exceeded maxBuffer/i.test(stderr);
}

function refError(ref: string, err: unknown): { ok: false; reason: string } {
  const msg = (err as Error)?.message ?? String(err);
  return { ok: false, reason: `git rev-parse failed for ref "${ref}": ${msg.slice(0, 200)}` };
}

/**
 * Resolve a ref name to a commit. Returns false when `git rev-parse
 * --verify --quiet <ref>^{commit}` exits non-zero — i.e. the ref is not
 * a revision (or a revision of something other than a commit), whatever
 * the reason. A refname starting with `-` is rejected up front: the
 * value is never shell-interpolated (execFile), but a leading dash
 * would be parsed by git as an option (argument injection), and such a
 * name is never a legitimate ref here.
 */
async function refIsCommit(cwd: string, ref: string): Promise<boolean> {
  if (ref.startsWith("-")) return false;
  try {
    await execFileP("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute `git diff <base>...<head>` in the given directory.
 *
 * Three-dot (merge-base) semantics — deliberately NOT the driver's
 * two-dot `origin/<base>..origin/<branch>`; the two differ when the
 * branch has diverged from base, and the tool's contract is the plain
 * `git diff base...head` the operator would run.
 *
 * - invalid base or head → `{ok:false}` naming the offending ref;
 * - a ref starting with `-` → `{ok:false}` (argument injection);
 * - a confirmed-empty range → `{ok:false}` "empty diff" (never a value
 *   a caller can mistake for "nothing to review");
 * - a diff beyond the 1 MiB cap → `{ok:false}` (never a silent "" or a
 *   silently truncated string).
 */
export async function computeRangeDiff(
  cwd: string,
  base: string,
  head: string,
): Promise<RangeDiff> {
  for (const ref of [base, head]) {
    if (ref.startsWith("-")) {
      return { ok: false, reason: `ref "${ref}" is rejected: ref names must not start with '-'` };
    }
    if (!(await refIsCommit(cwd, ref))) {
      return refError(ref, new Error("not a valid commit ref (rev-parse --verify failed)"));
    }
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileP("git", ["-C", cwd, "diff", `${base}...${head}`], {
      maxBuffer: DIFF_MAX_BUFFER,
    }));
  } catch (err) {
    const stderr = (err as Error & { stderr?: string })?.stderr ?? "";
    if (diffOverflow(stderr)) {
      return {
        ok: false,
        reason: `git diff ${base}...${head} exceeded the ${DIFF_MAX_BUFFER} byte cap`,
      };
    }
    return {
      ok: false,
      reason: `git diff ${base}...${head} failed: ${((err as Error)?.message ?? String(err)).slice(0, 200)}`,
    };
  }
  if (!stdout.trim()) {
    return {
      ok: false,
      reason: `empty diff for range ${base}...${head} (nothing to review — this is never an approval)`,
    };
  }
  return { ok: true, diff: stdout };
}

/**
 * #973 — a delta diff: `git diff <since>..<head>` (TWO-dot, exactly what
 * changed since `since`), with the same ref validation, cap and injection
 * guard as `computeRangeDiff`.
 *
 * Emptiness means something different here than in `computeRangeDiff`, and
 * the distinction is load-bearing: an empty FULL diff is still an error
 * (#384 — a value nobody may mistake for "nothing to review", i.e. an
 * approval), but an empty DELTA range is the normal outcome of a follow-up
 * review on an unchanged branch — the churn the delta path exists to stop.
 * It returns `{ ok: true, empty: true }`, and the caller turns that into
 * the no-review outcome (no re-review, no ledger entry) rather than
 * faking findings or failing the cycle.
 *
 * The two-dot form is deliberate and different from `computeRangeDiff`'s
 * three-dot: a delta is "what changed since this commit", which is exactly
 * `git diff since..head`, not a merge-base diff.
 */
export type DeltaDiff =
  | { ok: true; diff: string; empty: false }
  | { ok: true; diff: ""; empty: true }
  | { ok: false; reason: string };

export async function computeDeltaDiff(cwd: string, since: string, head: string): Promise<DeltaDiff> {
  for (const ref of [since, head]) {
    if (ref.startsWith("-")) {
      return {
        ok: false,
        reason: `ref "${ref}" is rejected: ref names must not start with '-'`,
      };
    }
    if (!(await refIsCommit(cwd, ref))) {
      return refError(ref, new Error("not a valid commit ref (rev-parse --verify failed)"));
    }
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileP("git", ["-C", cwd, "diff", `${since}..${head}`], {
      maxBuffer: DIFF_MAX_BUFFER,
    }));
  } catch (err) {
    const stderr = (err as Error & { stderr?: string })?.stderr ?? "";
    if (diffOverflow(stderr)) {
      return {
        ok: false,
        reason: `git diff ${since}..${head} exceeded the ${DIFF_MAX_BUFFER} byte cap`,
      };
    }
    return {
      ok: false,
      reason: `git diff ${since}..${head} failed: ${((err as Error)?.message ?? String(err)).slice(0, 200)}`,
    };
  }
  if (!stdout.trim()) return { ok: true, diff: "", empty: true };
  return { ok: true, diff: stdout, empty: false };
}

/**
 * review-patch-identity — the patch identity the review ledger stores and the
 * empty-delta carry checks (#1176), split from review-ledger.ts (the 500-line
 * gate).
 *
 * Every identity here is computed from the MERGE-BASE of a head and a mainline
 * ref — the construction `workingTreePatchId` (review-ledger.ts) stores:
 *
 *   - `patchId`: `git patch-id --stable` over the diff. Insensitive to
 *     whitespace and line numbers.
 *   - `diffSha256`: sha256 of the whitespace-sensitive `git diff --binary`.
 *     Closes the gap `patchId` leaves: a whitespace-only change keeps the
 *     patch-id and changes this digest.
 *
 * `patchIdOfRange` and `diffDigestOfRange` are the ONE construction. The
 * writer (merge-base → working tree) and the carry checker (merge-base →
 * committed head) both call them with a range, so they cannot disagree on how
 * an identity is built. Both THROW on a git failure; each caller decides the
 * fail-closed meaning.
 *
 * `mergeBasePatchId` is the merge guard's and the residual-marker poster's
 * identity (#1305): the committed form of the writer's construction, against
 * the SAME base the writers use (`<remote>/<mainline>`). The guard used the
 * two-dot `git diff base..branch` until #1305 — that diff contains the
 * reverse of every commit main gained after the branch was cut, so every
 * recorded review went "stale" the moment main moved although the branch had
 * not changed.
 */

import { createHash } from "node:crypto";
import { trace } from "./trace.ts";
import { type VerifyExecFn, resolveMainline } from "./work-driver-git.ts";

/** A ref safe to interpolate into a shell command: no leading dash, no metacharacters. */
const SAFE_REF = /^[A-Za-z0-9_][A-Za-z0-9._/@-]*$/;

/** One `git patch-id` line (`<id> <path>`) → the id, or undefined when empty. */
function parsePatchId(stdout: string, label: string): string | undefined {
  const id = stdout.trim().split(/\s+/)[0]?.trim();
  if (!id) trace(`review-ledger: patch-id was empty for ${label}`);
  return id;
}

/** `git diff <range> | git patch-id --stable`. THROWS on a git failure. */
export async function patchIdOfRange(
  execFn: VerifyExecFn,
  cwd: string,
  range: string,
  label: string,
): Promise<string | undefined> {
  const { stdout } = await execFn(`git diff ${range} | git patch-id --stable`, {
    cwd,
    maxBuffer: 1024 * 1024,
  });
  return parsePatchId(stdout, label);
}

/** sha256 of `git diff --binary <range>` (whitespace-sensitive). THROWS on a git failure. */
export async function diffDigestOfRange(
  execFn: VerifyExecFn,
  cwd: string,
  range: string,
): Promise<string> {
  const { stdout } = await execFn(`git diff --binary ${range}`, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return createHash("sha256").update(stdout).digest("hex");
}

/** `git merge-base <head> <base>`, trimmed ("" when none). THROWS on a git failure. */
async function mergeBaseOf(
  execFn: VerifyExecFn,
  cwd: string,
  head: string,
  base: string,
): Promise<string> {
  const { stdout } = await execFn(`git merge-base ${head} ${base}`, { cwd, maxBuffer: 8 * 1024 });
  return stdout.trim();
}

/**
 * The COMMITTED identity of `head` against `base`, built exactly as the
 * ledger's working-tree identity is: merge-base first, then the diff from it
 * to `head`. Any failure — an unsafe ref, no merge-base, a git error — returns
 * `{}`, so the caller fails closed (a carry needs both fields to match).
 */
export async function committedIdentity(
  execFn: VerifyExecFn,
  cwd: string,
  head: string,
  base: string,
): Promise<{ patchId?: string; diffSha256?: string }> {
  if (!SAFE_REF.test(head) || !SAFE_REF.test(base)) return {};
  try {
    const mergeBase = await mergeBaseOf(execFn, cwd, head, base);
    if (!mergeBase) return {};
    const range = `${mergeBase} ${head}`;
    const patchId = await patchIdOfRange(
      execFn,
      cwd,
      range,
      `${mergeBase.slice(0, 8)}..${head.slice(0, 8)}`,
    );
    const diffSha256 = await diffDigestOfRange(execFn, cwd, range);
    return { patchId, diffSha256 };
  } catch (err) {
    trace(
      `review-patch-identity: committed identity of ${head.slice(0, 8)} unavailable: ${(err as Error).message?.slice(0, 120)}`,
    );
    return {};
  }
}

/**
 * The merge guard's identity of a PR's head (#1305): the patch-id of
 * `merge-base(<remote>/<head>, <remote>/<mainline>)..<remote>/<head>` — the
 * committed form of what `workingTreePatchId` records, against the same base
 * ref, so a review stays current while main moves and goes stale only when the
 * branch's own changes do.
 *
 * The writers only ever record against the MAINLINE. A PR whose base branch is
 * not the mainline therefore has no recorded identity to match and fails
 * closed here, named — the operator re-runs the reviews or merges by hand.
 *
 * Every failure (mainline unresolved, unsafe ref, no merge-base, a git error,
 * an empty diff) is `{ ok: false, reason }`: the guard refuses with the reason,
 * the marker poster posts nothing. The caller fetches both refs first.
 */
export async function mergeBasePatchId(
  execFn: VerifyExecFn,
  cwd: string,
  remote: string,
  headBranch: string,
  prBaseBranch: string,
): Promise<{ ok: true; patchId: string } | { ok: false; reason: string }> {
  const mainline = await resolveMainline(cwd, execFn);
  if (!("branch" in mainline)) {
    return { ok: false, reason: `the mainline is unresolved (${mainline.reason})` };
  }
  if (prBaseBranch !== mainline.branch) {
    return {
      ok: false,
      reason: `the PR's base \`${prBaseBranch}\` is not the mainline \`${mainline.branch}\` — reviews are recorded against the mainline only`,
    };
  }
  const head = `${remote}/${headBranch}`;
  const base = `${remote}/${mainline.branch}`;
  if (!SAFE_REF.test(head) || !SAFE_REF.test(base)) {
    return { ok: false, reason: `unsafe ref (${JSON.stringify(head)} / ${JSON.stringify(base)})` };
  }
  try {
    const mergeBase = await mergeBaseOf(execFn, cwd, head, base);
    if (!mergeBase) return { ok: false, reason: `no merge-base between ${head} and ${base}` };
    const patchId = await patchIdOfRange(
      execFn,
      cwd,
      `${mergeBase} ${head}`,
      `${mergeBase.slice(0, 8)}..${head}`,
    );
    if (!patchId)
      return { ok: false, reason: `the diff ${mergeBase.slice(0, 8)}..${head} is empty` };
    return { ok: true, patchId };
  } catch (err) {
    return { ok: false, reason: `git failed: ${(err as Error).message?.slice(0, 120)}` };
  }
}

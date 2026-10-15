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
 * `branchPatchId` (two-dot `base..branch`) is NOT the carry identity: the merge
 * guard uses it for adversarial entries, so it stays as it was.
 */

import { createHash } from "node:crypto";
import { trace } from "./trace.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

/** A ref safe to interpolate into a shell command: no leading dash, no metacharacters. */
const SAFE_REF = /^[A-Za-z0-9_][A-Za-z0-9._/@-]*$/;

/**
 * The patch id of a branch's changes: the diff from `baseRef` to the branch
 * head, fed through `git patch-id --stable`. The writer and the guard both
 * call this, so the same content always yields the same id (and a new commit
 * always changes it).
 *
 * Returns undefined when the diff is empty or patch-id fails — the caller
 * decides the fail-closed meaning.
 */
export async function branchPatchId(
  execFn: VerifyExecFn,
  cwd: string,
  branchRef: string,
  baseRef: string,
): Promise<string | undefined> {
  try {
    // `git patch-id --stable` over the diff of the branch's own commits.
    // Piping here is intentional: patch-id reads the diff from stdin.
    const { stdout } = await execFn(`git diff ${baseRef}..${branchRef} | git patch-id --stable`, {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    return parsePatchId(stdout, `${baseRef}..${branchRef}`);
  } catch (err) {
    trace(`review-ledger: patch-id failed for ${branchRef}: ${(err as Error).message}`);
    return undefined;
  }
}

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
    const { stdout } = await execFn(`git merge-base ${head} ${base}`, {
      cwd,
      maxBuffer: 8 * 1024,
    });
    const mergeBase = stdout.trim();
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

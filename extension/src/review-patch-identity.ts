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
 * `committedPatchIdentity` is the committed form of the same construction: the
 * carry checker (`committedIdentity`) and the merge guard / residual-marker
 * poster (`mergeIdentity`, merge-guard-reads.ts, #1305) both build on it, so
 * neither can drift from what the writers record.
 */

import { createHash } from "node:crypto";
import { trace } from "./trace.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

/** A ref safe to interpolate into a shell command: no leading dash, no metacharacters. */
const SAFE_REF = /^[A-Za-z0-9_][A-Za-z0-9._/@-]*$/;

/**
 * #1398 round 3 — the bound on the LOCAL git reads a patch identity is built
 * from (`git merge-base`, `git diff | git patch-id`). The identity sits on the
 * ready gate (`work-driver-draft-pr.ts`), the disclosure record
 * (`work-driver-draft-disclosure.ts`) and the merge guard's own read, and a git
 * call that parks — a lock, a hung filter driver, an fs that will not answer —
 * used to park whatever step was waiting on it, with no named cause.
 *
 * Exported so every identity reader passes the SAME number through its
 * injectable executor instead of each inventing its own; callers that already
 * bound the call (the network-git seam, `runNetGit`) are unaffected.
 */
export const LOCAL_GIT_TIMEOUT_MS = 30_000;

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
    timeout: LOCAL_GIT_TIMEOUT_MS,
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
    timeout: LOCAL_GIT_TIMEOUT_MS,
  });
  return createHash("sha256").update(stdout).digest("hex");
}

/**
 * The ONE committed identity construction (#1305): merge-base of `head` and
 * `base`, then the diff from it to `head` — exactly what `workingTreePatchId`
 * stores, over committed content. `digest` also computes `diffSha256`.
 *
 * Every failure — an unsafe ref, no merge-base, a git error, an empty diff —
 * is `{ ok: false, reason }`, so each caller fails closed with a named cause.
 */
export async function committedPatchIdentity(
  execFn: VerifyExecFn,
  cwd: string,
  head: string,
  base: string,
  opts: { digest?: boolean } = {},
): Promise<{ ok: true; patchId: string; diffSha256?: string } | { ok: false; reason: string }> {
  if (!SAFE_REF.test(head) || !SAFE_REF.test(base)) {
    return { ok: false, reason: `unsafe ref (${JSON.stringify(head)} / ${JSON.stringify(base)})` };
  }
  let mergeBase: string;
  try {
    const { stdout } = await execFn(`git merge-base ${head} ${base}`, {
      cwd,
      maxBuffer: 8 * 1024,
      timeout: LOCAL_GIT_TIMEOUT_MS,
    });
    mergeBase = stdout.trim();
  } catch (err) {
    // `git merge-base` exits 1 with no output when the histories share no
    // ancestor; any other git failure lands here too, so both are named.
    return {
      ok: false,
      reason: `git merge-base ${head} ${base} failed — no merge-base, or a git error (${(err as Error).message?.slice(0, 120)})`,
    };
  }
  if (!mergeBase) return { ok: false, reason: `no merge-base between ${head} and ${base}` };
  const range = `${mergeBase} ${head}`;
  const label = `${mergeBase.slice(0, 8)}..${head}`;
  try {
    const patchId = await patchIdOfRange(execFn, cwd, range, label);
    if (!patchId) return { ok: false, reason: `the diff ${label} is empty` };
    if (!opts.digest) return { ok: true, patchId };
    return { ok: true, patchId, diffSha256: await diffDigestOfRange(execFn, cwd, range) };
  } catch (err) {
    return {
      ok: false,
      reason: `git failed on ${label}: ${(err as Error).message?.slice(0, 120)}`,
    };
  }
}

/**
 * The carry checker's view of `committedPatchIdentity` (#1176): both fields,
 * or `{}` on any failure, so the caller fails closed (a carry needs both
 * fields to match).
 */
export async function committedIdentity(
  execFn: VerifyExecFn,
  cwd: string,
  head: string,
  base: string,
): Promise<{ patchId?: string; diffSha256?: string }> {
  const r = await committedPatchIdentity(execFn, cwd, head, base, { digest: true });
  if (r.ok) return { patchId: r.patchId, diffSha256: r.diffSha256 };
  trace(
    `review-patch-identity: committed identity of ${head.slice(0, 8)} unavailable: ${r.reason}`,
  );
  return {};
}

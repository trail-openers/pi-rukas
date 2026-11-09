/**
 * merge-identity — the merge-time patch identity: the content of the head's own
 * commits, measured over the merge-base with the mainline, compared to what the
 * review writers recorded.
 *
 * Both forms live here because the identity and the protected-path read must
 * agree on ONE `<remote>/<mainline>` pair: a caller resolves the mainline once and
 * hands the same values to both. Two readers that each resolved it themselves is
 * how a protected diff gets computed against a base the merge was not judged on.
 */

import { identityBase } from "./review-ledger-path.ts";
import { committedPatchIdentity } from "./review-patch-identity.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

/** The patch identity of the PR head against the mainline, or the named refusal. */
export type MergeIdentityResult = { ok: true; patchId: string } | { ok: false; reason: string };

/**
 * The patch identity of the PR head against the mainline, in the shape the guard
 * and the marker poster both use. `mainline`/`remote` are the pair the caller
 * resolved for its own reads; with none to hand they come from `identityBase`, the
 * one answer every review writer uses. The writers record only against the
 * MAINLINE, so a PR based elsewhere has no recorded identity to match: it fails
 * closed here, named.
 */
export async function mergeIdentity(
  execFn: VerifyExecFn,
  cwd: string,
  headBranch: string,
  prBaseBranch: string,
  mainline?: string,
  remote?: string,
): Promise<MergeIdentityResult> {
  let resolvedMainline = mainline;
  let resolvedRemote = remote;
  if (resolvedMainline === undefined || resolvedRemote === undefined) {
    const base = await identityBase(execFn, cwd);
    if (!base.ok) return base;
    resolvedMainline = resolvedMainline ?? base.mainline;
    resolvedRemote = resolvedRemote ?? base.remote;
  }
  if (prBaseBranch !== resolvedMainline) {
    return {
      ok: false,
      reason: `the PR's base \`${prBaseBranch}\` is not the mainline \`${resolvedMainline}\` — reviews are recorded against the mainline only`,
    };
  }
  const r = await committedPatchIdentity(
    execFn,
    cwd,
    `${resolvedRemote}/${headBranch}`,
    `${resolvedRemote}/${resolvedMainline}`,
  );
  return r.ok ? { ok: true, patchId: r.patchId } : r;
}

/**
 * `mergeIdentity` for a caller that already resolved `<remote>/<mainline>` — the
 * guard, which resolves the pair once for its fetch and its protected read too.
 */
export async function mergeIdentityAgainstMainline(
  execFn: VerifyExecFn,
  cwd: string,
  headBranch: string,
  prBaseBranch: string,
  mainline: string,
  remote: string,
): Promise<MergeIdentityResult> {
  return mergeIdentity(execFn, cwd, headBranch, prBaseBranch, mainline, remote);
}

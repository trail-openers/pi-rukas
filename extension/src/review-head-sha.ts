/**
 * review-head-sha — the ONE head-SHA shape check and the ONE head-ref
 * resolution (split from review-ledger.ts, #1039).
 *
 * #1039: the review writers (the lens and adversarial ledger writes) and the
 * diff resolvers used to each carry their own copy of the
 * `git rev-parse --verify --quiet <ref>^{commit}` call. This module is the
 * single home for both halves of that:
 *
 *   - `isFullCommitSha` — the shape check a stored `headSha` must pass
 *     before it can be matched by string equality against a PR head OID
 *     (a branch name or abbreviated OID is treated as UNKNOWN, never
 *     matched). The implementation lives in `commit-sha.ts`, a dependency-free
 *     leaf so the lean state validator and base proof can reach the regex
 *     without importing this module's executor/trace seam; this file RE-EXPORTS
 *     it so every importer here keeps working, and new callers that want only
 *     the shape should import the leaf.
 *   - `resolveHeadSha` — resolving a caller-named ref (or `HEAD`) to the
 *     full 40-char SHA the ledger stores, and `resolveHeadShaOutcome` — the same
 *     resolution for the one caller that has to tell "git said no" apart from
 *     "git could not be asked".
 *
 * Resolution is deliberately conservative: a leading dash (argument
 * injection — git would parse it as an option) and any ref that is not a
 * commit object both resolve to `undefined`, and the failure is traced WITH
 * the error message so the operator can see why no headSha was recorded
 * (the round-cap check fails closed on an absent headSha — conservative by
 * design).
 */

import { LOCAL_GIT_TIMEOUT_MS } from "./review-patch-identity.ts";
import { trace } from "./trace.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

// The shape predicate is a dependency-free leaf (see commit-sha.ts); re-exported
// so the ~15 existing importers of this module are untouched by the split.
export { isFullCommitSha } from "./commit-sha.ts";

/**
 * Resolve a ref to its full 40-char commit SHA, or `undefined` when it is
 * not a resolvable commit (leading dash, non-commit object, or git failure).
 *
 * The resolution is `git rev-parse --verify --quiet <ref>^{commit}` (the
 * `^{commit}` peels tags to the commit they point at and rejects everything
 * else); the ref is passed as an argv element (no shell interpolation), and
 * a leading dash is refused up front because git would parse it as an
 * option. Traces the failure (with the error message) on every miss.
 */
export async function resolveHeadSha(
  cwd: string,
  ref: string,
  execFn: VerifyExecFn,
): Promise<string | undefined> {
  const outcome = await resolveHeadShaOutcome(cwd, ref, execFn);
  return outcome.sha;
}

/**
 * The same resolution, with WHY it did not answer.
 *
 * `resolveHeadSha` collapses every miss to `undefined`: a leading dash, a name
 * that peels to no commit, and a git that threw are one answer. For most callers
 * that is the whole question — a ledger write records no `headSha` either way.
 * `lean/base-proof.ts` needs the split: when its own second opinion finds nothing
 * behind a miss, "git said no" is a refusal the issue is told about and "git
 * could not be asked" is an infrastructure fault that must hand the run back
 * instead of posting a wrong diagnosis on the issue.
 *
 * `failed` means exactly one thing: this call's resolver CAUGHT an error. It is
 * per-call by construction, which is why it replaces a process-global counter —
 * an absolute reading of a monotonic counter let any unrelated git failure
 * anywhere earlier in the process blame a silent refusal on a broken object
 * store. The trace below is still the operator's evidence (ungated, unlike the
 * trace write's own `PI_ENSEMBLE_DEBUG` gate), but the machine-readable answer
 * is the return value, not a side effect read from elsewhere.
 */
export async function resolveHeadShaOutcome(
  cwd: string,
  ref: string,
  execFn: VerifyExecFn,
): Promise<{ sha: string } | { sha: undefined; failed: boolean }> {
  if (ref.startsWith("-")) return { sha: undefined, failed: false };
  try {
    const { stdout } = await execFn("git", {
      cwd,
      argv: ["-C", cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      maxBuffer: 8 * 1024,
      // #1774 — BOUNDED like every other identity git read. This resolution is
      // what the owed-round `ci` route compares the verdict's head against, and
      // an unbounded rev-parse (a lock, a hung filter driver) hung the park path
      // that exists to refuse a doomed step. A failure here is `undefined`,
      // which the caller fails closed on — never a route on.
      timeout: LOCAL_GIT_TIMEOUT_MS,
    });
    const sha = stdout.trim();
    if (sha !== "") return { sha };
    return { sha: undefined, failed: false };
  } catch (err) {
    // #1910: the lean base proof tells a missing object from a git it could not
    // ask, and for the one case it cannot see for itself — a refusing exit with
    // an EMPTY stderr — this trace is the only evidence that a git read failed.
    // It is written here rather than scraped off stderr so the reader does not
    // depend on `PI_ENSEMBLE_DEBUG` (the trace write itself is gated on it).
    trace(
      `review-head-sha: resolution failed for ${JSON.stringify(ref.slice(0, 64))}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { sha: undefined, failed: true };
  }
}

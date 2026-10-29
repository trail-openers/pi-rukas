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
 *     full 40-char SHA the ledger stores.
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
  if (ref.startsWith("-")) return undefined;
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
    return stdout.trim() || undefined;
  } catch (err) {
    // #1910: the lean base proof tells a missing object from a git it could not
    // ask, and for the one case it cannot see for itself — a refusing exit with
    // an EMPTY stderr — this trace is the only evidence that a git read failed.
    // It is counted here rather than scraped off stderr so the reader does not
    // depend on `PI_ENSEMBLE_DEBUG` (the trace write itself is gated on it).
    resolveHeadTraceFailures++;
    trace(
      `review-head-sha: resolution failed for ${JSON.stringify(ref.slice(0, 64))}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

/**
 * How many `resolveHeadSha` git failures this process has swallowed.
 *
 * Monotonically increasing and never reset: the consumer asks "has any
 * resolution failed", and erasing another caller's evidence to make a question
 * fresher is the wrong trade. Read by `lean/base-proof.ts` (which decides
 * whether a silent refusal is a refusal) through `resolveHeadTraceCount`.
 */
let resolveHeadTraceFailures = 0;

/** The counter above — see `resolveHeadTraceFailures` for why it never resets. */
export function resolveHeadTraceCount(): number {
  return resolveHeadTraceFailures;
}

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
 *     matched);
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

import { trace } from "./trace.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

/**
 * #1039 — true when the value is a full 40-char lowercase-hex commit SHA.
 * A branch name or abbreviated OID (pre-#1039 legacy entry) is treated as
 * UNKNOWN — never matched by string equality against a PR head OID.
 */
export function isFullCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

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
    });
    return stdout.trim() || undefined;
  } catch (err) {
    trace(
      `review-head-sha: resolution failed for ${JSON.stringify(ref.slice(0, 64))}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

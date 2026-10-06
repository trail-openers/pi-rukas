/**
 * review-branch — the ONE branch-resolution path for a review's merge-ledger
 * write and the #973 residual-findings disclosure post.
 *
 * #980. Before #980 the `git rev-parse --abbrev-ref HEAD` recovery lived
 * inline in TWO places (lens-ledger.ts and adversarial-ledger.ts), and the
 * poster (lens-review-residuals.ts) received the caller's `branch` verbatim —
 * which the `dispatch_lens_review` / `adversarial_loop` tool paths NEVER
 * supply, so a hand-run review from a named-branch checkout resolved a
 * ledger key but never posted the disclosure, and a detached-HEAD run
 * skipped both silently. The merge guard (merge-guard.ts) keys its entries
 * on the PR's headRefName, so the three consumers must agree on the SAME
 * branch string or the marker/ledger can never match.
 *
 * Resolution order (one function, used by the lens ledger write, the
 * adversarial ledger write and the residual poster):
 *
 *   1. `opts.branch` — the caller's explicit branch (the /work driver
 *      supplies `ps.branchName` because its worktrees are detached);
 *   2. `head` — when it names a branch (a leading `<remote>/` prefix is
 *      stripped, `origin/feature/x` → `feature/x`, and the ref must exist
 *      locally or on that remote — a commit SHA or tag is NOT a branch);
 *   3. `git rev-parse --abbrev-ref HEAD` in cwd, when it is a branch name
 *      (a detached head reports `HEAD` — treated as "no branch");
 *   4. undefined — the caller renders the "not recorded" note (the note is
 *      the caller's, because only it knows whether a record would have
 *      happened, e.g. the disclosure fires only on ISSUES_FOUND).
 *
 * Normalization: step 2 strips the remote prefix because the guard's key is
 * the PR's headRefName (the LOCAL branch name, `feature/x`) and the
 * `branch=` in the disclosure marker must match it byte-for-byte. Step 1
 * (explicit) is used verbatim — the driver supplies local branch names, and
 * an explicit argument is a caller statement, not an inference. Step 3
 * already yields the local name.
 *
 * Failure isolation: every fault (non-repo cwd, a `head` whose ref does not
 * exist, a rev-parse failure) is swallowed — resolution degrades to the next
 * step or undefined, never throws into the review.
 */

import { shq } from "./forge-commands.ts";
import { trace } from "./trace.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

/** #988 — every git exec in this module is bounded (matching
 * lens-review-residuals.ts); an unbounded shell exec would hang the review
 * for the process lifetime. A timeout degrades exactly like any other
 * exec failure below (fall through / false / undefined) — it is never
 * retried or surfaced. */
const GIT_TIMEOUT_MS = 30_000;

export interface ResolveReviewBranchResult {
  /** The resolved branch, or undefined when nothing branch-shaped is
   * derivable (detached head, non-repo cwd, an unresolvable `head`). */
  branch: string | undefined;
  /** The source of the resolution (for traces / tests): `explicit` (the
   * caller's `branch`), `head` (a branch-named ref), `rev-parse` (the
   * checkout's HEAD) or `none`. */
  source: "explicit" | "head" | "rev-parse" | "none";
}

/**
 * The VISIBLE "review NOT recorded in the merge ledger" note a tool-path
 * result carries when `resolveReviewBranch` returns no branch (the pre-#980
 * skip was trace-only — the tool result was byte-identical to a recorded
 * review). One string, shared by `runLensReview` and `runAdversarialLoop`.
 */
export const NOT_RECORDED_NOTE =
  "Note: this review was NOT recorded in the merge ledger — no branch could be resolved (detached head, no explicit branch, no branch-named head), so the merge guard has no review on file for this checkout; run the review on the branch's own checkout (or with a branch-named `head`) to record it.";

/**
 * Resolve the branch a review's ledger entry and disclosure marker are keyed
 * on. See the module header for the resolution order and the normalization
 * rule. Never throws.
 */
export async function resolveReviewBranch(
  opts: { branch?: string; head?: string; cwd?: string },
  execFn: VerifyExecFn,
): Promise<ResolveReviewBranchResult> {
  // 1. Explicit caller branch — the /work driver's worktrees are detached,
  // so its supplied name is authoritative and is NOT re-normalized.
  if (opts.branch?.trim()) {
    return { branch: opts.branch.trim(), source: "explicit" };
  }
  const cwd = opts.cwd ?? process.cwd();
  // 2. `head` naming a branch (with or without a `<remote>/` prefix).
  // The ref must EXIST as a branch — locally (`refs/heads/<name>`) or on
  // the named remote (`refs/remotes/<remote>/<name>`). A commit SHA or a
  // tag resolves here to nothing: it is not the branch a ledger entry is
  // keyed on, so resolution degrades to rev-parse rather than guessing.
  if (opts.head?.trim() && !opts.head.trim().startsWith("-")) {
    const headRef = opts.head.trim();
    const branchRef = await isBranchRef(execFn, cwd, headRef);
    if (branchRef) {
      // The resolved branch is the LOCAL name: `localName` is the branch's
      // full name for a local hit, or the ref with the leading
      // `<remote>/` prefix stripped for a remote-tracking hit
      // (`origin/feature/x` → `feature/x`).
      const localName = branchRef.localName ?? headRef.slice(headRef.indexOf("/") + 1);
      trace(`review-branch: resolved ${headRef} → ${localName}`);
      return { branch: localName, source: "head" };
    }
  }
  // 3. The checkout's own HEAD (the writer's pre-#980 recovery, now the
  // single shared site). `git rev-parse --abbrev-ref HEAD` prints `HEAD`
  // itself on a detached head — that is "no branch", not a branch named
  // "HEAD".
  try {
    const { stdout } = await execFn("git rev-parse --abbrev-ref HEAD", {
      cwd,
      maxBuffer: 8 * 1024,
      timeout: GIT_TIMEOUT_MS,
    });
    const head = stdout.trim();
    if (head && head !== "HEAD") return { branch: head, source: "rev-parse" };
  } catch (err) {
    trace(
      `review-branch: rev-parse in ${cwd} failed: ${
        err instanceof Error ? err.message : String(err)
      } — no branch resolvable`,
    );
  }
  return { branch: undefined, source: "none" };
}

/** Does `ref` (a full `refs/...` name) exist in the repo? Never throws. */
async function checkRef(execFn: VerifyExecFn, cwd: string, ref: string): Promise<boolean> {
  try {
    // #988 — the ref is caller-supplied (opts.head); shq (forge-commands.ts,
    // the project's existing quoting helper) keeps it out of shell
    // expansion. A timeout degrades to `false` like any other exec failure.
    await execFn(`git show-ref --verify --quiet ${shq(ref)}`, {
      cwd,
      maxBuffer: 8 * 1024,
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Does `original` name an existing branch — as a local branch (the full ref,
 * so a `feature/x` branch resolves), or as a remote-tracking ref
 * (`origin/feature/x` → `refs/remotes/origin/feature/x`)? Never throws:
 * an unreadable ref namespace (non-repo cwd) simply means "not a branch
 * here" and resolution degrades to rev-parse.
 *
 * #988 — the result carries the LOCAL name so the caller does not re-probe
 * `refs/heads/<original>`: `localName` is the branch's full name for a
 * local hit, and the `<remote>/`-prefixed input for a remote hit (the
 * caller strips the prefix — the only shape a remote hit has, so the
 * stripped name is always derivable on that arm).
 */
async function isBranchRef(
  execFn: VerifyExecFn,
  cwd: string,
  original: string,
): Promise<{ isLocal: boolean; localName?: string } | null> {
  // Local branch (full ref) always tried first — `feature/x` is a local
  // branch with a slash, not a remote called `feature` with branch `x`.
  if (await checkRef(execFn, cwd, `refs/heads/${original}`))
    return { isLocal: true, localName: original };
  // Remote-tracking form: `<remote>/<name>` where the full ref is the
  // original (so `origin/feature/x` → `refs/remotes/origin/feature/x`).
  const i = original.indexOf("/");
  if (i > 0) {
    const remote = original.slice(0, i);
    const name = original.slice(i + 1);
    if (await checkRef(execFn, cwd, `refs/remotes/${remote}/${name}`)) return { isLocal: false };
  }
  return null;
}

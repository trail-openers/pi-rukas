/**
 * merge-guard-author — the merge-author gate as one call, for the two paths that
 * hold rather than block: the `/work` driver's `merged` step and lean's `land`
 * step.
 *
 * The guard path (a hand-run `gh pr merge`) asks the same shared function in
 * merge-guard.ts; this module exists so the two driver paths read the allowlist
 * and the author the same way and phrase the refusal the same way. Three copies
 * of "read `.pi/merge-authors` at the base commit and compare a login" is exactly
 * the drift this project keeps removing.
 *
 * The author is NOT read here. It arrives on the evidence read the caller already
 * made (`MergeEvidence.author`), which the field list in `mergeEvidenceViewCmd`
 * requests from the same `gh pr view` that carries the CI verdict and the head
 * OID — one read, one moment on the forge, so a reassignment between two reads
 * cannot put a green verdict and an allowlisted author from different PRs.
 *
 * Both refusals park rather than merge, and neither consults an override:
 * `PI_ENSEMBLE_MERGE_AUTHORITY=0`, `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE` and
 * `/work --merge` are statements about reviews and permission, not about who
 * opened the PR. See merge-author-allowlist.ts for the fail-closed rule.
 */

import {
  type AuthorGate,
  type AuthorRead,
  MERGE_AUTHORS_FILE,
  type AllowlistRead,
  mergeAuthorGate,
  mergeGuardAuthorRead,
  readMergeAuthorAllowlist,
} from "./merge-author-allowlist.ts";
import type { MergeEvidence } from "./work-driver-merge-evidence.ts";
import type { MergeExecFn, MergeTarget } from "./merge-target.ts";

/** The executor seam every merge path already holds. */
type AuthorExec = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; argv?: string[] },
) => Promise<{ stdout: string; stderr?: string }>;

/** What the gate decided, and what the caller must record alongside it. */
export interface MergeAuthorDecision {
  /** `true` only when the allowlist was read AND the author is on it. */
  ok: boolean;
  /** The refusal, in the operator's words. Absent when `ok`. */
  reason?: string;
  /** Which failure this is, so a renderer can tell an unreadable gate from a stranger. */
  kind?: "not-allowlisted" | "author-unreadable" | "allowlist-unreadable";
}

/**
 * The guard's half of the same gate: the read plus the `{ block }` the hook returns.
 *
 * Split into this module for the 500-line file cap (AGENTS.md §12), the same seam
 * `merge-guard-protected.ts` used: the shared predicate answers, this module
 * phrases, and the hook calls one function.
 *
 * `baseRef` is `<remote>/<mainline>` as the guard resolved it — the ref whose
 * commit the merge would land onto. The guard has no `baseSha` of its own (it is a
 * hook on a command, not a cycle), so its base is the mainline it already fetched
 * and pinned the head against, passed to `git show <ref>:.pi/merge-authors`. That
 * is the commit the merge is made against, which is the rule's point: the copy a
 * cycle is judged by is the one that existed before it ran, not one its own patch
 * wrote.
 */
export async function guardMergeAuthorRefusal(
  execFn: MergeExecFn,
  cwd: string,
  baseRef: string,
  target: MergeTarget,
): Promise<{ block: true; reason: string } | undefined> {
  const allowlist = await readMergeAuthorAllowlist(execFn, cwd, baseRef, MERGE_AUTHORS_FILE);
  const decision = decideMergeAuthor(allowlist, mergeGuardAuthorRead(target.author));
  if (decision.ok) return undefined;
  return { block: true, reason: `merge refused: ${decision.reason}` };
}

/** The author of a PR, as its evidence read reported it (#2181). */
export function authorFromEvidence(evidence: MergeEvidence | undefined): AuthorRead {
  if (evidence === undefined) {
    return { ok: false, detail: "the merge evidence was never read, so no author was read with it" };
  }
  const login = evidence.author?.trim();
  if (login === undefined || login.length === 0) {
    return { ok: false, detail: evidence.authorError ?? "the forge's PR read reported no author login" };
  }
  return { ok: true, login };
}

/** The decision, rendered by each caller in its own frame (block vs park). */
export function decideMergeAuthor(
  allowlist: AllowlistRead,
  author: AuthorRead,
): MergeAuthorDecision {
  const gate: AuthorGate = mergeAuthorGate({ allowlist, author });
  if (gate.ok) return { ok: true };
  // Classified from the INPUTS, never from the rendered text: the shared function
  // owns the wording, and a caller that sniffed it would drift the moment it was
  // reworded. The order is the gate's own — an unreadable allowlist outranks an
  // unreadable author, because that is the refusal the operator can act on.
  const kind: MergeAuthorDecision["kind"] = !allowlist.ok
    ? "allowlist-unreadable"
    : !author.ok
      ? "author-unreadable"
      : "not-allowlisted";
  return { ok: false, reason: gate.reason, kind };
}

/**
 * Read the allowlist at a commit and decide one PR's author against it.
 *
 * `baseSha` is the cycle's or the run's base commit — the file is read there,
 * never from the working tree, so a patch in the PR cannot widen its own allowlist.
 */
export async function heldForMergeAuthor(args: {
  exec: AuthorExec;
  cwd: string;
  baseSha: string | undefined;
  author: AuthorRead;
  file?: string;
}): Promise<MergeAuthorDecision> {
  const allowlist = await readMergeAuthorAllowlist(
    args.exec,
    args.cwd,
    args.baseSha,
    args.file ?? MERGE_AUTHORS_FILE,
  );
  return decideMergeAuthor(allowlist, args.author);
}

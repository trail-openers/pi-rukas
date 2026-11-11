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

import { errText } from "./protected-paths-text.ts";
import {
  type AuthorGate,
  type AuthorRead,
  MERGE_AUTHORS_FILE,
  type AllowlistRead,
  mergeAuthorGate,
  mergeGuardAuthorRead,
  readMergeAuthorAllowlist,
} from "./merge-author-allowlist.ts";
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
  // One path through `heldForMergeAuthor` for all three callers: the base the guard
  // holds is `<remote>/<mainline>`, a REF, and the reader underneath accepts only a
  // hex sha, so calling it directly here would refuse every merge for the wrong
  // reason. Resolving first is the shared behaviour, not this path's exception.
  const decision = await heldForMergeAuthor({
    exec: execFn,
    cwd,
    baseSha: baseRef,
    author: mergeGuardAuthorRead(target.author),
  });
  if (decision.ok) return undefined;
  return { block: true, reason: `merge refused: ${decision.reason}` };
}

/**
 * The author of a PR, as its evidence read reported it (#2181).
 *
 * Takes the fields, not the whole `MergeEvidence`, for a reason that is not style:
 * the driver and lean each reach this with a value typed against their OWN import
 * of the evidence type (`work-driver-merge-authority.ts` re-exports it from
 * `work-driver-merge-evidence.ts`), and an `undefined` argument to a structurally
 * typed parameter silently skips the "the read never happened" case. `undefined`
 * here is a compile error, and the two absence cases are named separately instead:
 * a read that never ran, and a read that answered without an author.
 */
export function authorFromRead(read: { author?: string; authorError?: string }): AuthorRead {
  const login = read.author?.trim();
  if (login === undefined || login.length === 0) {
    return { ok: false, detail: read.authorError ?? "the forge's PR read reported no author login" };
  }
  return { ok: true, login };
}

/**
 * The author fields lifted off an evidence result that may never have been produced.
 *
 * `undefined` is the read-that-never-ran shape, and it is named — never folded into
 * an empty author, which is a different fault with different operator action.
 */
export function evidenceAuthorRead(
  evidence: { author?: string; authorError?: string } | undefined,
): { author?: string; authorError?: string } {
  if (evidence === undefined) {
    return {
      authorError: "the merge evidence was never read, so no author was read with it",
    };
  }
  return { author: evidence.author, authorError: evidence.authorError };
}

/** The author of a PR from its evidence read, or the reason none was read (#2181). */
export function authorFromEvidence(
  evidence: { author?: string; authorError?: string } | undefined,
): AuthorRead {
  return authorFromRead(evidenceAuthorRead(evidence));
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
 * Resolve the commit the allowlist is read at.
 *
 * Both driver paths record their base as a REF, not a sha: `work-driver-branch-ops.ts`
 * writes `baseSha` as `origin/main` (its own comment says so) and lean persists the
 * same shape. `git show <ref>:.pi/merge-authors` reads the same commit either way,
 * so a ref is resolved here to its OID and the strict sha check still runs — which
 * keeps the sha discipline in `readMergeAuthorAllowlist` (it refuses any base that is
 * not hex) while letting the paths that record a ref be judged at their own base.
 */
async function resolveAllowlistBase(
  exec: AuthorExec,
  cwd: string,
  baseSha: string,
): Promise<{ oid: string } | { failure: Extract<AllowlistRead, { ok: false }> }> {
  if (/^[0-9a-f]{7,40}$/.test(baseSha.trim())) return { oid: baseSha.trim() };
  try {
    // No `--end-of-options` here: `git rev-parse` has no such option (unlike
    // `cat-file` and `show`, which do), and it would print the token instead of
    // resolving it. The guard against an option-looking base is instead that the
    // ANSWER must be a 40-hex OID — a base that resolves to nothing, or to text,
    // is refused below rather than passed on as a commit.
    const { stdout } = await exec("git", {
      argv: ["rev-parse", "--verify", "--quiet", `${baseSha.trim()}^{commit}`],
      cwd,
      timeout: 15_000,
      maxBuffer: 8 * 1024,
    });
    const oid = stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(oid)) {
      return {
        failure: {
          ok: false,
          reason: "bad-base-sha",
          detail: `${JSON.stringify(baseSha.slice(0, 40))} did not resolve to a commit`,
        },
      };
    }
    return { oid };
  } catch (err) {
    return {
      failure: {
        ok: false,
        reason: "git-failed",
        detail: `the recorded base commit ${JSON.stringify(baseSha.slice(0, 40))} could not be resolved (${errText(err)})`,
      },
    };
  }
}

/**
 * Read the allowlist at a commit and decide one PR's author against it.
 *
 * `baseSha` is the cycle's or the run's base commit — the file is read there,
 * never from the working tree, so a patch in the PR cannot widen its own allowlist.
 * A ref-shaped base is resolved to its OID first (see `resolveAllowlistBase`).
 */
export async function heldForMergeAuthor(args: {
  exec: AuthorExec;
  cwd: string;
  baseSha: string | undefined;
  author: AuthorRead;
  file?: string;
}): Promise<MergeAuthorDecision> {
  const file = args.file ?? MERGE_AUTHORS_FILE;
  const base = args.baseSha?.trim() ?? "";
  if (base.length === 0) {
    return decideMergeAuthor({ ok: false, reason: "no-base" }, args.author);
  }
  const resolved = await resolveAllowlistBase(args.exec, args.cwd, base);
  if ("failure" in resolved) return decideMergeAuthor(resolved.failure, args.author);
  const allowlist = await readMergeAuthorAllowlist(args.exec, args.cwd, resolved.oid, file);
  return decideMergeAuthor(allowlist, args.author);
}

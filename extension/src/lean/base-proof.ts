/**
 * lean/base-proof — proving a run's base is the commit it claims to be.
 *
 * `baseSha` is the ref every later read of a lean run is anchored to: the
 * config loader resolves `.pi/work.json` AT it, and `build`/`verify` diff and
 * test against it. A value that is not an object name (`main`, `HEAD`, a short
 * prefix) or an object name the clone does not hold turns the whole run into a
 * claim about a commit it never named — and the config loader cannot tell "no
 * such commit" from "no config file", because `gitType`/`gitShow` catch every
 * git failure and answer "absent", which for a loader is the correct answer
 * about a *file*. So the base has to be proven somewhere, and this module is
 * that somewhere: two rules and one second opinion, shared by the seeder (which
 * must not write a base `ready` would refuse) and by `ready` itself.
 *
 * The two rules are reported SEPARATELY because they are different mistakes:
 * `notAnOidRule` is somebody's hand on a text field, and `notACommitRule` is a
 * clone that does not contain the object. Both name the value clipped, and
 * neither is echoed anywhere else — the rule is where an operator reads it, and
 * a second unclipped copy is a second renderer that has to remember.
 */

import { execp } from "../exec.ts";
import { isFullCommitSha, resolveHeadSha } from "../review-head-sha.ts";
import { LOCAL_GIT_TIMEOUT_MS } from "../review-patch-identity.ts";
import type { VerifyExecFn } from "../work-driver-git.ts";
import { oneLine } from "./text-fence.ts";

/** The two refusals a base can earn, worded so an operator sees WHICH half failed. */
export const NOT_AN_OID = " is not a full commit sha";
export const NOT_A_COMMIT = " is not a commit in this clone";

/**
 * The suffix for a value that DOES resolve — to something else. The commonest
 * way a hand-edited record is wrong, and the one an operator can act on
 * (`git cat-file -t <that>`) without guessing what the field meant.
 */
export function resolvesTo(resolved: string): string {
  return `${NOT_A_COMMIT} (it resolves to ${oneLine(resolved, 80)})`;
}

/** `base <value>` is not an object name at all: not 40 lowercase hex. */
export function notAnOidRule(baseSha: string): string {
  return `base sha ${oneLine(baseSha, 80)}${NOT_AN_OID}`;
}

/** `base <value>` is an oid-shaped string this clone holds no commit for. */
export function notACommitRule(baseSha: string, suffix = NOT_A_COMMIT): string {
  return `base sha ${oneLine(baseSha, 80)}${suffix}`;
}

/**
 * Is `baseSha` a full commit sha AND the commit this clone holds?
 *
 * Both halves are needed and neither implies the other. The shape check is what
 * makes the value an immutable object name rather than a ref: `main`, `HEAD`,
 * `@{0}` and a short prefix all fail it, and with it the git argument can never
 * be a moving ref or a revision chain — an earlier shape of this gate passed
 * `main^{commit}` to git and was satisfied with any 40-hex answer, so
 * `main^{commit}``touch x``@{0}` resolved to main's tip and the run anchored to
 * a commit it never named. The peel is what proves the clone contains it, and
 * that the answer comes BACK EQUAL to the base: a full sha is content-addressed,
 * so anything that resolves to a different spelling was never the object the run
 * was seeded with (a mixed-case or otherwise mangled value).
 *
 * The resolution goes through the repo's canonical `resolveHeadSha`, which peels
 * with `^{commit}` (so a blob or tag object answers `undefined`) and is bounded
 * like every other identity git read.
 *
 * Throws on a git INFRASTRUCTURE fault and only there — see `probeCommitObject`.
 * A caller that wants a refusal rather than a handback must not get one for a
 * repository whose git could not be asked.
 */
export async function proveBaseSha(
  repoRoot: string,
  baseSha: string,
  exec: VerifyExecFn = execp,
): Promise<{ ok: true } | { ok: false; rule: string }> {
  if (!isFullCommitSha(baseSha)) return { ok: false, rule: notAnOidRule(baseSha) };
  const resolved = await resolveHeadSha(repoRoot, baseSha, exec);
  if (resolved === undefined) {
    // A miss is not yet an answer: `resolveHeadSha` returns `undefined` for a
    // non-commit AND for a git that could not answer. Ask the narrow question.
    const probe = await probeCommitObject(repoRoot, baseSha, exec);
    if (probe !== true) {
      throw new Error(`could not verify base sha ${oneLine(baseSha, 80)}: ${oneLine(probe, 160)}`);
    }
    return { ok: false, rule: notACommitRule(baseSha) };
  }
  if (resolved !== baseSha)
    return { ok: false, rule: notACommitRule(baseSha, resolvesTo(resolved)) };
  return { ok: true };
}

/**
 * Is `baseSha` a commit this clone holds, yes-or-no — and what did git say
 * when it could not be asked?
 *
 * The second opinion behind a `resolveHeadSha` miss. `git cat-file -e` is the
 * narrowest question that answers it: exit 0 for an object, 1 for a missing
 * object, and whatever git exits with when the repository itself is broken.
 *
 * Returns `true` only for a clean "no such object": exit 1 or 128 whose stderr
 * names a missing object (git's wording for a well-formed sha that is simply
 * absent is `fatal: Not a valid object name …`, the same class of answer as
 * `missing object …` for a ref), or whose stderr is empty. Anything else comes
 * back as a one-line CAUSE string for the caller to throw with, so a locked
 * index, a corrupt object store or a hung git is reported as what it is — an
 * infrastructure fault — rather than as a defect in somebody's issue.
 */
async function probeCommitObject(
  repoRoot: string,
  baseSha: string,
  exec: VerifyExecFn,
): Promise<true | string> {
  try {
    const out = await exec("git", {
      cwd: repoRoot,
      argv: ["cat-file", "-e", "--end-of-options", `${baseSha}^{commit}`],
      // The same bound `resolveHeadSha` gives its rev-parse (#1774): this probe
      // runs exactly where that read could not answer, so an unbounded second
      // opinion would reinstate the hang the first bound exists to prevent.
      timeout: LOCAL_GIT_TIMEOUT_MS,
    });
    // exit 0 — the object exists, so the first probe's miss was the fault.
    return `git answered the object but not the resolution (stderr ${oneLine(out?.stderr ?? "", 80)})`;
  } catch (err) {
    const e = err as { code?: unknown; stderr?: unknown; killed?: unknown };
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const trimmed = stderr.trim();
    const cause = trimmed || (err instanceof Error ? err.message : String(err));
    // git's two wordings for "this name has no object": `missing object …` (a
    // broken ref) and `Not a valid object name …` (a well-formed sha that is
    // simply absent, which is exactly what a stale record carries). Matched
    // anywhere in the line because git prefixes its own `fatal:` to one and not
    // the other, and a parser pinned to a prefix silently turns a refusal into
    // a fault the moment the wording shifts.
    const namesMissingObject =
      /missing (object|bare object|tree)/i.test(trimmed) ||
      /not a valid object name/i.test(trimmed);
    if ((e.code === 1 || e.code === 128) && (trimmed === "" || namesMissingObject)) return true;
    // A timeout or a signal carries no exit code at all — it is a fault, never
    // a "not a commit".
    return `${cause} (exit ${String(e.code)}, killed=${String(e.killed === true)})`;
  }
}

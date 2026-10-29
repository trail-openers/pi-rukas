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

import { isFullCommitSha } from "../commit-sha.ts";
import { execp } from "../exec.ts";
import { resolveHeadSha, resolveHeadTraceCount } from "../review-head-sha.ts";
import { LOCAL_GIT_TIMEOUT_MS } from "../review-patch-identity.ts";
import type { VerifyExecFn } from "../work-driver-git.ts";
import { NO_MAINLINE_WHY } from "./io.ts";
import { oneLine } from "./text-fence.ts";

/** The two refusals a base can earn, worded so an operator sees WHICH half failed. */
export const NOT_AN_OID = " is not a full commit sha";
export const NOT_A_COMMIT = " is not a commit in this clone";

/**
 * The rule for an empty base, with a tail that is never empty.
 *
 * `readyOutcome` owns the wording; this owns the guarantee that the clause
 * always says something — the seed's cause when it has one, the probe's cause
 * when it re-ran, and `NO_MAINLINE_WHY` (owned by `lean/io.ts`, beside the
 * probe list it quotes) when neither produced a reason. Clipped because the
 * cause is git's text, not ours.
 */
export function unresolvedMainlineRule(why: string | undefined): string {
  const reason = why === undefined || why.trim() === "" ? NO_MAINLINE_WHY : oneLine(why, 160);
  return `could not resolve the mainline sha: ${reason}`;
}

/**
 * Has a `resolveHeadSha` git failure been swallowed in this process?
 *
 * `resolveHeadSha` answers `undefined` for a non-commit AND for a git that could
 * not answer, tracing the message as it swallows the error; a probe that gets no
 * reason at all can tell those apart only through that trace. The trace WRITE is
 * gated on `PI_ENSEMBLE_DEBUG`, so the probe cannot read stderr for it — the
 * resolver counts its failures ungated and this asks the count. The counter is
 * never reset: erasing another caller's evidence to make the question fresher is
 * the wrong trade, and the conservative direction here is to blame the object
 * store, which refuses less.
 */
export function resolveHeadTracedFailure(): boolean {
  return resolveHeadTraceCount() > 0;
}

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
 * The classification is INVERTED from the obvious shape: "not a commit" is the
 * narrow, positively-recognised answer and everything else is a fault. The
 * earlier spelling — refuse when the exit is 1/128 and the stderr is *anything*
 * — read "empty stderr at exit 1" as a refusal, and git prints a reason for
 * every object it truly cannot find: measured against a fanout directory whose
 * mode is `000`, `cat-file -e <sha>^{commit}` answers exit 128 with
 * `unable to open loose object …: Permission denied` followed by
 * `Not a valid object name …`, and `rev-parse --verify --quiet <sha>^{commit}`
 * prints the same permission error with exit 1 and EMPTY stdout. A store git
 * cannot read therefore looks exactly like an absent object unless a non-empty
 * stderr is read as the fault it is. Everything else — "unable to open loose
 * object", "Permission denied", "Too many levels of symbolic links" — comes
 * back as a one-line CAUSE string for the caller to throw with, so a locked
 * index, an unreadable object store or a hung git is reported as an
 * infrastructure fault rather than as a defect in somebody's issue.
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
    const exit = e.code;
    // The exit code must be a real "git said no" — 1 or 128. A timeout or a
    // signal carries no exit code at all (`null`/`undefined`), which is never a
    // "not a commit".
    const refusedExit = exit === 1 || exit === 128;
    if (refusedExit && trimmed !== "") {
      // An INFRASTRUCTURE fault is decided FIRST and takes precedence over every
      // missing-object wording, because git prints both at once. Measured against
      // a `chmod 000` fanout dir, `cat-file -e <sha>^{commit}` answers exit 128
      // with:
      //
      //   error: unable to open loose object <sha>: Permission denied
      //   error: unable to open loose object <sha>: Permission denied
      //   fatal: Not a valid object name <sha>^{commit}
      //
      // The last line is git's OWN "no such object" wording, so a classifier that
      // asked "does this name a missing object?" first would read an unreadable
      // object store as a base that simply is not there and post "your base is
      // not a commit" on an issue whose clone cannot be read. The fault lines are
      // the positive evidence and the refusal wording here is a lie about it —
      // which is why the rule is inverted and the fault is checked first. A
      // genuine absence prints only `fatal: Not a valid object name …` (measured,
      // exit 128 with nothing else), so no fault line is present and the refusal
      // still answers.
      if (OBJECT_STORE_FAULT.test(trimmed))
        return `git object store unreadable (exit ${String(exit)}): ${oneLine(firstLine(trimmed), 120)}`;
      // git's wordings for "this name has no object": `missing object …` (a
      // broken ref), `Not a valid object name …` (a well-formed sha that is
      // simply absent, which is exactly what a stale record carries), and
      // cat-file's own `could not get object info` for the same class. Matched
      // anywhere in the line because git prefixes its own `fatal:` to one and not
      // the other, and a parser pinned to a prefix silently turns a refusal into
      // a fault the moment the wording shifts.
      const namesMissingObject =
        /missing (object|bare object|tree)/i.test(trimmed) ||
        /not a valid object name/i.test(trimmed) ||
        /could not get object info/i.test(trimmed);
      if (namesMissingObject) return true;
      // Any other non-empty stderr at a refusing exit — text that names neither
      // absence nor a fault line above — is still not a recognised refusal.
      return `git object store unreadable (exit ${String(exit)}): ${oneLine(firstLine(trimmed), 120)}`;
    }
    if (refusedExit) {
      // Empty stderr at a refusing exit. git prints a reason for every object it
      // genuinely cannot find (measured: the three wordings above, each with a
      // non-empty stderr), so silence is not evidence of absence — but it is not
      // evidence of a broken store either, and nothing downstream can tell the
      // two apart. The rule this module documents is that a refusal must be
      // POSITIVELY recognised, and silence is not that; the exception, written
      // down here as the brief required, is that silence stays a refusal while
      // `resolveHeadSha` stayed silent too. That resolver counts every git error
      // it swallows (`resolveHeadTraceCount`, ungated because the trace write is
      // gated on `PI_ENSEMBLE_DEBUG`), so a non-zero count means a git read
      // actually failed in this process and the object store is suspect. The
      // counter is process-global and monotonic, so an unrelated earlier failure
      // turns a later silent refusal into a fault — conservative, and the right
      // direction for a check whose failure mode is "refuse less". Under an
      // INJECTED executor (every fake-git case in the base-proof suite) nothing
      // reaches the counter, so those cases keep answering "refusal", which is
      // what they pin; the production shape — real git, real failing rev-parse —
      // is the one the counter refuses, and `chmod 000` case in
      // test-lean-base-proof.ts drives it.
      if (resolveHeadTracedFailure())
        return `git refused with no reason while a resolution failure was traced (exit ${String(exit)})`;
      return true;
    }
    const cause = trimmed || (err instanceof Error ? err.message : String(err));
    return `${cause} (exit ${String(exit)}, killed=${String(e.killed === true)})`;
  }
}

/**
 * The stderr lines that say the object store could not be READ, not that an
 * object is absent. Matched anywhere in the blob, because git interleaves its
 * `error:` lines with the `fatal:` refusal described above.
 *
 * `unable to open loose object` / `unable to read sha1 file` are git's own
 * wording (both measured against a `chmod 000` fanout dir); `Permission denied`
 * and `Too many levels of symbolic links` cover the OS-level causes that reach
 * git verbatim on any object read; `could not open` / `unable to read pack` /
 * `bad object` / `corrupt` cover the pack and index variants of the same fault.
 * Kept deliberately narrow: none of these is a wording git uses for an ABSENT
 * object, which is the answer that must stay a refusal.
 */
const OBJECT_STORE_FAULT =
  /unable to open|unable to read|could not open|permission denied|too many levels of symbolic links|not a git repository|unable to fork|corrupt|bad object|bad pack/i;

/** The first non-empty line of a stderr blob — the one line worth printing. */
function firstLine(stderr: string): string {
  for (const line of stderr.split("\n")) if (line.trim() !== "") return line.trim();
  return stderr;
}

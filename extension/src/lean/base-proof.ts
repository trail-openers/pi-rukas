/**
 * lean/base-proof — proving a run's base is the commit it claims to be.
 *
 * `baseSha` is the ref every later read of a lean run is anchored to: the config loader
 * resolves `.pi/work.json` AT it, and `build`/`verify` diff and test against it. A value
 * that is not an object name, or one the clone does not hold, turns the whole run into a
 * claim about a commit it never named — and the config loader cannot tell "no such commit"
 * from "no config file", because `gitType`/`gitShow` catch every git failure and answer
 * "absent". So the base has to be proven somewhere: two rules and one second opinion,
 * shared by the seeder and by `ready` itself.
 *
 * The two rules are reported SEPARATELY because they are different mistakes:
 * `notAnOidRule` is somebody's hand on a text field, and `notACommitRule` is a clone that
 * does not contain the object. Neither is echoed anywhere else — the rule is where an
 * operator reads it.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { execp } from "../exec.ts";
import { resolveHeadShaOutcome } from "../review-head-sha.ts";
import { LOCAL_GIT_TIMEOUT_MS } from "../review-patch-identity.ts";
import type { VerifyExecFn } from "../work-driver-git.ts";
import { NO_MAINLINE_WHY } from "./io.ts";
import { oneLine } from "./text-fence.ts";

/** The two refusals a base can earn, worded so an operator sees WHICH half failed. */
const NOT_AN_OID = " is not a full commit sha";
const NOT_A_COMMIT = " is not a commit in this clone";

/**
 * The rule for an empty base, with a tail that is never empty: the seed's cause
 * when it has one, the probe's cause when it re-ran, else `NO_MAINLINE_WHY`.
 * Clipped because the cause is git's text, not ours.
 */
export function unresolvedMainlineRule(why: string | undefined): string {
  const reason = why === undefined || why.trim() === "" ? NO_MAINLINE_WHY : oneLine(why, 160);
  return `could not resolve the mainline sha: ${reason}`;
}

/**
 * The suffix for a value that DOES resolve — to something else, which an operator can act
 * on with `git cat-file -t <that>`.
 */
function resolvesTo(resolved: string): string {
  return `${NOT_A_COMMIT} (it resolves to ${oneLine(resolved, 80)})`;
}

/** `base <value>` is not an object name at all: not 40 lowercase hex. */
function notAnOidRule(baseSha: string): string {
  return `base sha ${oneLine(baseSha, 80)}${NOT_AN_OID}`;
}

/** `base <value>` is an oid-shaped string this clone holds no commit for. */
function notACommitRule(baseSha: string, suffix = NOT_A_COMMIT): string {
  return `base sha ${oneLine(baseSha, 80)}${suffix}`;
}

/**
 * Is `baseSha` a full commit sha AND the commit this clone holds?
 *
 * Both halves are needed and neither implies the other. The shape check is what makes the
 * value an immutable object name rather than a ref (`main`, `HEAD`, `@{0}` and a short prefix
 * all fail it), so the git argument can never be a moving ref or a revision chain. The peel
 * proves the clone contains it, and that the answer comes BACK EQUAL to the base: a full sha
 * is content-addressed, so anything resolving to a different spelling was never the object
 * the run was seeded with.
 *
 * Resolution goes through the repo's canonical resolver (`review-head-sha.ts`
 * `resolveHeadShaOutcome`), which peels with `^{commit}` and is bounded like every other
 * identity git read. The OUTCOME form is the only one that can say whether a miss was git
 * reporting "no such commit" or git failing to answer at all.
 *
 * Throws on a git INFRASTRUCTURE fault and only there — see `probeCommitObject`.
 */
export async function proveBaseSha(
  repoRoot: string,
  baseSha: string,
  exec: VerifyExecFn = execp,
): Promise<{ ok: true } | { ok: false; rule: string }> {
  if (!isFullCommitSha(baseSha)) return { ok: false, rule: notAnOidRule(baseSha) };
  // The resolver's own verdict on its own read, carried in as an argument. There is
  // deliberately no process-global counter to consult: an absolute reading of a monotonic
  // counter lets any unrelated git failure elsewhere turn THIS call's silent refusal into a
  // fault.
  const outcome = await resolveHeadShaOutcome(repoRoot, baseSha, exec);
  if (outcome.sha === undefined) {
    // A miss is not yet an answer: the resolver returns no sha for a non-commit AND for a git
    // that could not answer. `failed` says which, and the probe asks the narrow question of
    // the one case the resolver cannot see itself.
    const probe = await probeCommitObject(repoRoot, baseSha, exec, outcome.failed === true);
    if (probe !== true) {
      throw new Error(`could not verify base sha ${oneLine(baseSha, 80)}: ${oneLine(probe, 160)}`);
    }
    return { ok: false, rule: notACommitRule(baseSha) };
  }
  if (outcome.sha !== baseSha)
    return { ok: false, rule: notACommitRule(baseSha, resolvesTo(outcome.sha)) };
  return { ok: true };
}

/**
 * Is `baseSha` a commit this clone holds, yes-or-no — and what did git say
 * when it could not be asked?
 *
 * The second opinion behind a `resolveHeadSha` miss. `git cat-file -e` is the narrowest
 * question that answers it: exit 0 for an object, 1 for a missing object, and whatever git
 * exits with when the repository itself is broken.
 *
 * The classification is INVERTED from the obvious shape: "not a commit" is the narrow,
 * positively-recognised answer and everything else is a fault. An object store git cannot
 * read (a `000`-mode fanout directory) reports exit 128/1 with the same "Not a valid object
 * name" wording, so a non-empty stderr is read as the fault it is. Everything else returns a
 * one-line CAUSE string, so a locked index or a hung git is reported as infrastructure.
 */
async function probeCommitObject(
  repoRoot: string,
  baseSha: string,
  exec: VerifyExecFn,
  resolutionFailed: boolean,
): Promise<true | string> {
  try {
    const out = await exec("git", {
      cwd: repoRoot,
      argv: ["cat-file", "-e", "--end-of-options", `${baseSha}^{commit}`],
      // The same bound `resolveHeadSha` gives its rev-parse: this probe runs exactly where
      // that read could not answer, so an unbounded second opinion would reinstate the hang
      // the first bound exists to prevent.
      timeout: LOCAL_GIT_TIMEOUT_MS,
    });
    // exit 0 — the object exists, so the first probe's miss was the fault: git resolved
    // `<sha>^{commit}` here and answered nothing on the earlier read. Reported as a fault,
    // never as "not a commit".
    return `git answered the object but not the resolution (stderr ${oneLine(out?.stderr ?? "", 80)})`;
  } catch (err) {
    const e = execRejection(err);
    const stderr = typeof e?.stderr === "string" ? e.stderr : "";
    const trimmed = stderr.trim();
    const exit = e?.code;
    // A git that never RAN, or ran and was killed, is decided BEFORE the exit code is read.
    // It is not a refusal in any spelling: a SIGKILL, a SIGTERM or an ENOENT carries no exit
    // code, and falling through to the "unrecognised stderr" arm would word a hung or absent
    // binary as `git object store unreadable`. Classified cause first, per shape.
    const neverRan = killedGitFault(e, err);
    if (neverRan !== undefined) return neverRan;
    // The exit code must be a real "git said no" — 1 or 128. A timeout or a signal carries no
    // exit code at all, which is never a "not a commit".
    const refusedExit = exit === 1 || exit === 128;
    if (refusedExit && trimmed !== "") {
      // An INFRASTRUCTURE fault is decided FIRST and takes precedence over every
      // missing-object wording, because git prints both at once: against an unreadable fanout
      // dir it answers exit 128 with `unable to open loose object …: Permission denied` lines
      // followed by its own `Not a valid object name …` refusal. A genuine absence prints only
      // the refusal line.
      if (OBJECT_STORE_FAULT.test(trimmed))
        return `git object store unreadable (exit ${String(exit)}): ${oneLine(firstLine(trimmed), 120)}`;
      if (NAMES_MISSING_OBJECT.test(trimmed)) return true;
      // Non-empty stderr that names neither absence nor a fault line is not a recognised
      // refusal.
      return `git object store unreadable (exit ${String(exit)}): ${oneLine(firstLine(trimmed), 120)}`;
    }
    if (refusedExit) {
      // Empty stderr at a refusing exit: git prints a reason for every object it genuinely
      // cannot find, so silence is not evidence of absence. The rule is that a refusal must be
      // POSITIVELY recognised; the written-down exception is that silence stays a refusal while
      // the resolution stayed silent too — hence `resolutionFailed`, which arrives as an
      // argument from the caller that made the read rather than from a global.
      if (resolutionFailed)
        return `git refused with no reason while a resolution failure was traced (exit ${String(exit)})`;
      return true;
    }
    const cause = trimmed || (err instanceof Error ? err.message : String(err));
    // Only reachable with a numeric `code` that is neither 1 nor 128. `??` rather than a cast:
    // the narrowing is the code's, and a future early-returning arm must not start blaming
    // `undefined` for somebody else's exit.
    return `${cause} (exit ${String(exit)}, killed=${String(e?.killed === true)})`;
  }
}

/**
 * The stderr lines that say the object store could not be READ, not that an object is
 * absent. Matched anywhere in the blob, because git interleaves its `error:` lines with the
 * `fatal:` refusal. Kept deliberately narrow: none of these is a wording git uses for an
 * ABSENT object, which must stay a refusal.
 */
const OBJECT_STORE_FAULT =
  /unable to open|unable to read|could not open|permission denied|too many levels of symbolic links|not a git repository|unable to fork|corrupt|bad object|bad pack|unable to unpack|inflate/i;

/**
 * The stderr wordings that say "this name has no object", git's own text.
 *
 * A set rather than inline tests because the same questions are asked of a blob's text in
 * one place, and a wording added to one arm and not the other is how a refusal becomes a
 * fault silently. Matched anywhere in the line because git prefixes its own `fatal:` to one
 * wording and not the other.
 *
 * The fault arm above still wins — an unreadable store prints its own lines alongside these
 * — so a broken repository is never read as an absent commit.
 */
const NAMES_MISSING_OBJECT =
  /missing (object|bare object|tree)|not a valid object name|could not get object info|ambiguous argument|unknown revision/i;

/**
 * The shape `execp` rejects with, read without a cast.
 *
 * `execp` attaches `code`/`signal`/`killed`/`stdout`/`stderr` to the Error it rejects, but
 * nothing in the type system says so, and an `as` cast would read `e.code` off a thrown
 * string or treat an object whose `code` is a string as a git exit. A value that does not
 * look like an exec rejection is reported as `undefined`, which the caller's arms already
 * treat as "no exit code", i.e. a fault.
 */
function execRejection(
  err: unknown,
): { code?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown } | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const o = err as Record<string, unknown>;
  // A rejection is recognised by the RESULT SHAPE, never by the shape of its `code`: a plain
  // `TypeError` carries a `code` that is a STRING (`ERR_…`), and reading the code itself as the
  // marker would classify our own bugs as git rejections.
  const shaped = "code" in o || "stderr" in o || "killed" in o || "signal" in o || "stdout" in o;
  if (!shaped) return undefined;
  return { code: o.code, stderr: o.stderr, killed: o.killed, signal: o.signal };
}

/** The rejection's own words, for a cause string git's stderr cannot supply. */
function rejectionMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const e = execRejection(err);
  if (typeof e?.stderr === "string" && e.stderr.trim() !== "") return firstLine(e.stderr);
  return String(err);
}

/**
 * Did git fail to run, rather than run and refuse?
 *
 * Decided from the rejection's shape and not its exit code, because none of these carries
 * one: `killed`, a non-null `signal`, a `code` that is not a number, and an explicit
 * `ENOENT`/`spawn` error. Each returns a classified CAUSE so the operator reads "git was
 * killed (signal 9)" rather than "the object store is unreadable".
 */
function killedGitFault(
  e: { code?: unknown; killed?: unknown; signal?: unknown } | undefined,
  err: unknown,
): string | undefined {
  if (e?.killed === true) return "git was killed (timeout or external kill)";
  if (e?.signal !== undefined && e.signal !== null)
    return `git was killed (signal ${String(e.signal)})`;
  if (e === undefined) {
    // Not an exec rejection at all — a thrown string or a TypeError from our own code.
    // Nothing git answered, so nothing about the object can be concluded from it.
    return `git did not run (${oneLine(rejectionMessage(err), 100)})`;
  }
  const code = e.code;
  if (typeof code === "number") return undefined;
  const cause = typeof code === "string" && code !== "" ? code : rejectionMessage(err);
  return /enoent|spawn/i.test(cause)
    ? `git did not start (${oneLine(cause, 100)})`
    : `git did not exit normally (${oneLine(cause, 100)})`;
}

/** The first non-empty line of a stderr blob — the one line worth printing. */
function firstLine(stderr: string): string {
  for (const line of stderr.split("\n")) if (line.trim() !== "") return line.trim();
  return stderr;
}

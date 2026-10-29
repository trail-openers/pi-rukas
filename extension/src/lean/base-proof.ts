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
import { resolveHeadShaOutcome } from "../review-head-sha.ts";
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
 * The resolution goes through the repo's canonical resolver (`review-head-sha.ts`
 * `resolveHeadShaOutcome`), which peels with `^{commit}` (so a blob or tag object
 * answers no sha) and is bounded like every other identity git read. The OUTCOME
 * form is the one this module uses, because it is the only one that can answer
 * the question the second opinion exists to settle: the miss was either git
 * saying "no such commit" or git failing to answer at all, and the probe must be
 * told which, per call.
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
  // The resolver's own verdict on its own read, carried in as an argument. There
  // is deliberately no process-global counter to consult: an absolute reading of
  // a monotonic counter (and even a per-call baseline of one) lets any unrelated
  // git failure elsewhere in the process — another run's config read, a ledger
  // write three steps ago — turn THIS call's silent refusal into a fault. The
  // only failure this probe can be evidence about is the one THIS resolution
  // reported, and the only place that fact can come from is the call itself.
  const outcome = await resolveHeadShaOutcome(repoRoot, baseSha, exec);
  if (outcome.sha === undefined) {
    // A miss is not yet an answer: the resolver returns no sha for a non-commit
    // AND for a git that could not answer. `failed` says which, and the probe
    // asks the narrow question of the one case the resolver cannot see itself.
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
  resolutionFailed: boolean,
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
    // exit 0 — the object exists, so the first probe's miss was the fault. git
    // resolved `<sha>^{commit}` to a commit here and answered nothing on the
    // earlier read; the run's base is real and the resolution is what broke, so
    // this is reported as a fault and never as "not a commit".
    return `git answered the object but not the resolution (stderr ${oneLine(out?.stderr ?? "", 80)})`;
  } catch (err) {
    const e = execRejection(err);
    const stderr = typeof e?.stderr === "string" ? e.stderr : "";
    const trimmed = stderr.trim();
    const exit = e?.code;
    // A git that never RAN, or ran and was killed, is decided BEFORE the exit
    // code is read at all. It is not a refusal in any spelling: a SIGKILL, a
    // SIGTERM from a memory-pressure daemon or an ENOENT (no git on PATH, no
    // directory to run in) carries no exit code, and an implementation that
    // fell through to the "unrecognised stderr" arm would word a hung or absent
    // binary as `git object store unreadable` — which sends an operator to
    // repair an object store that is fine. Classified cause first, per shape.
    const neverRan = killedGitFault(e, err);
    if (neverRan !== undefined) return neverRan;
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
      // git's wordings for "this name has no object" — see NAMES_MISSING_OBJECT
      // for the set and why it is matched anywhere in the blob rather than at a
      // prefix.
      if (NAMES_MISSING_OBJECT.test(trimmed)) return true;
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
      // the resolution stayed silent too. That resolver reports a caught git
      // error on its own outcome (`resolveHeadShaOutcome`'s `failed`, ungated
      // because the trace write is gated on `PI_ENSEMBLE_DEBUG`), and THIS call's
      // resolution is the only one whose failure can be evidence about THIS base
      // — so the flag arrives as an argument from the caller that made the read,
      // and a `failed: true` means the object store is suspect. Under an
      // INJECTED executor (every fake-git case in the base-proof suite) nothing
      // reaches a global, so those cases keep answering "refusal", which is what
      // they pin; the production shape — real git, real failing rev-parse — is
      // the one the flag refuses, and the `chmod 000` case in
      // test-lean-base-proof.ts drives it.
      if (resolutionFailed)
        return `git refused with no reason while a resolution failure was traced (exit ${String(exit)})`;
      return true;
    }
    const cause = trimmed || (err instanceof Error ? err.message : String(err));
    // Only reachable with a numeric `code` that is neither 1 nor 128 — the arms
    // above take every killed/signal/non-numeric shape and both refusing exits,
    // so `e` is a rejection here by construction. `??` rather than a cast: the
    // narrowing is the code's, and a future arm that returns early must not
    // start blaming `undefined` for somebody else's exit.
    return `${cause} (exit ${String(exit)}, killed=${String(e?.killed === true)})`;
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
 * `bad object` / `corrupt` cover the pack and index variants of the same fault;
 * `unable to unpack` and `inflate` are the zlib side of a damaged object (git
 * prints `error: unable to unpack <sha>`, `inflate() failed`, `zlib: inflate
 * return = …`) — a pack whose objects will not decompress cannot be read any
 * more than one it cannot open. Kept deliberately narrow: none of these is a
 * wording git uses for an ABSENT object, which is the answer that must stay a
 * refusal.
 */
const OBJECT_STORE_FAULT =
  /unable to open|unable to read|could not open|permission denied|too many levels of symbolic links|not a git repository|unable to fork|corrupt|bad object|bad pack|unable to unpack|inflate/i;

/**
 * The stderr wordings that say "this name has no object", git's own text.
 *
 * A set rather than inline tests because the same three questions are asked of
 * a blob's text in one place, and a wording added to one arm and not the other
 * is how a refusal becomes a fault silently. Matched anywhere in the line
 * because git prefixes its own `fatal:` to one wording and not the other, and a
 * parser pinned to a prefix turns a refusal into a fault the moment the wording
 * shifts.
 *
 * `missing object …` (a broken ref), `Not a valid object name …` (a well-formed
 * sha that is simply absent — what a stale record carries) and cat-file's
 * `could not get object info` are the originals. `ambiguous argument` and
 * `unknown revision` are git's rev-parse wordings for a name it cannot turn into
 * an object; they are added here because rev-parse can print them while cat-file
 * has already agreed the object is simply absent. The fault arm above still wins
 * — an unreadable store prints its own lines alongside these — so a broken
 * repository is never read as an absent commit.
 */
const NAMES_MISSING_OBJECT =
  /missing (object|bare object|tree)|not a valid object name|could not get object info|ambiguous argument|unknown revision/i;

/**
 * The shape `execp` rejects with, read without a cast.
 *
 * `execp` attaches `code`/`signal`/`killed`/`stdout`/`stderr` to the Error it
 * rejects, but nothing in the type system says so, and an `as` cast is a
 * prettier lie than a check: it would read `e.code` off a thrown string, or
 * treat an object whose `code` is a string as a git exit. A value that does not
 * look like an exec rejection at all is reported with the bare `code?: unknown`
 * shape — which the caller's arms already treat as "no exit code", i.e. a
 * fault — so an unexpected throw never reaches the refusal arms.
 */
function execRejection(
  err: unknown,
): { code?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown } | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const o = err as Record<string, unknown>;
  // A rejection is recognised by the RESULT SHAPE, never by the shape of its
  // `code`: a plain `TypeError` carries a `code` that is a STRING (`ERR_…`), and
  // reading the code itself as the marker would classify our own bugs as git
  // rejections and word them as a store fault. No result field, no rejection.
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
 * Decided from the rejection's shape and not its exit code, because none of
 * these carries one: `killed` (the exec wrapper's own timeout flag), a non-null
 * `signal` (a git the OS terminated), a `code` that is not a number (a wrapper
 * error, or a spawn failure whose `code` is a string like `ENOENT`), and an
 * explicit `ENOENT`/`spawn` error (git missing, or the directory gone). Each
 * returns a classified CAUSE so the operator reads "git was killed (signal 9)"
 * rather than "the object store is unreadable".
 */
function killedGitFault(
  e: { code?: unknown; killed?: unknown; signal?: unknown } | undefined,
  err: unknown,
): string | undefined {
  if (e?.killed === true) return "git was killed (timeout or external kill)";
  if (e?.signal !== undefined && e.signal !== null)
    return `git was killed (signal ${String(e.signal)})`;
  if (e === undefined) {
    // Not an exec rejection at all — a thrown string, a TypeError from our own
    // code, a wrapper that rejected without a result shape. Nothing git answered,
    // so nothing about the object can be concluded from it.
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

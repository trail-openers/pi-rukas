/**
 * lean/base-proof — proving a run's base is the commit it claims to be.
 *
 * `baseSha` is the ref every later read of a lean run is anchored to: the config loader resolves
 * `.pi/work.json` AT it, and `build`/`verify` diff and test against it. The config loader cannot tell "no such
 * commit" from "no config file", so the base is proven here: two rules and one second opinion, shared by the
 * seeder and by `ready` itself.
 *
 * The two rules are reported SEPARATELY because they are different mistakes: a value that is not an object
 * name, and one the clone does not hold. The rule text is the only place an operator reads which half failed.
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
 * The rule for an empty base, with a tail that is never empty: the seed's or probe's cause when it has one,
 * else `NO_MAINLINE_WHY`. Clipped — the cause is git's text.
 */
export function unresolvedMainlineRule(why: string | undefined): string {
  const reason = why === undefined || why.trim() === "" ? NO_MAINLINE_WHY : oneLine(why, 160);
  return `could not resolve the mainline sha: ${reason}`;
}

/** The suffix for a value that DOES resolve — to something else. */
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
 * Both halves are needed and neither implies the other. The shape check is what makes the value an immutable
 * object name rather than a ref (`main`, `HEAD`, `@{0}` and a short prefix all fail it), so the git argument
 * can never be a moving ref or a revision chain. The peel proves the clone contains it, and that the answer
 * comes BACK EQUAL to the base.
 *
 * Resolution goes through the repo's canonical resolver (`review-head-sha.ts`); the OUTCOME form is the only
 * one that can say whether a miss was git reporting "no such commit" or git failing to answer at all.
 *
 * Throws on a git INFRASTRUCTURE fault and only there — see `probeCommitObject`.
 */
export async function proveBaseSha(
  repoRoot: string,
  baseSha: string,
  exec: VerifyExecFn = execp,
): Promise<{ ok: true } | { ok: false; rule: string }> {
  if (!isFullCommitSha(baseSha)) return { ok: false, rule: notAnOidRule(baseSha) };
  // The resolver's verdict on its own read arrives as an argument: a process-global counter would let any
  // unrelated git failure elsewhere turn this call's refusal into a fault.
  const outcome = await resolveHeadShaOutcome(repoRoot, baseSha, exec);
  if (outcome.sha === undefined) {
    // A miss is not yet an answer: the resolver returns no sha for a non-commit AND for a git that could not
    // answer. `failed` says which.
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
 * Is `baseSha` a commit this clone holds, yes-or-no — and what did git say when it could not be asked? The
 * second opinion behind a `resolveHeadSha` miss.
 *
 * The classification is INVERTED from the obvious shape: "not a commit" is the narrow, positively-recognised
 * answer and everything else is a fault. An object store git cannot read (a `000`-mode fanout directory)
 * reports exit 128/1 with the same "Not a valid object name" wording, so a non-empty stderr is read as the
 * fault it is. Everything else returns a one-line CAUSE string.
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
      // The same bound `resolveHeadSha` gives its rev-parse: this probe runs exactly where that read could
      // not answer, so an unbounded one would reinstate that hang.
      timeout: LOCAL_GIT_TIMEOUT_MS,
    });
    // exit 0 — the object exists, so the resolver's miss was the fault, never "not a commit".
    return `git answered the object but not the resolution (stderr ${oneLine(out?.stderr ?? "", 80)})`;
  } catch (err) {
    const e = execRejection(err);
    const stderr = typeof e?.stderr === "string" ? e.stderr : "";
    const trimmed = stderr.trim();
    const exit = e?.code;
    // A git that never RAN, or ran and was killed, is decided BEFORE the exit code is read: a SIGKILL, a
    // SIGTERM or an ENOENT carries no exit code.
    const neverRan = killedGitFault(e, err);
    if (neverRan !== undefined) return neverRan;
    // Only 1 or 128 is a real "git said no"; a timeout or a signal carries no exit code.
    const refusedExit = exit === 1 || exit === 128;
    if (refusedExit && trimmed !== "") {
      // The INFRASTRUCTURE fault is decided FIRST and outranks every missing-object wording, because git
      // prints both at once against an unreadable fanout dir.
      if (OBJECT_STORE_FAULT.test(trimmed))
        return `git object store unreadable (exit ${String(exit)}): ${oneLine(firstLine(trimmed), 120)}`;
      if (NAMES_MISSING_OBJECT.test(trimmed)) return true;
      // Non-empty stderr naming neither absence nor a fault line is not a recognised refusal.
      return `git object store unreadable (exit ${String(exit)}): ${oneLine(firstLine(trimmed), 120)}`;
    }
    if (refusedExit) {
      // A refusal must be POSITIVELY recognised: silence at a refusing exit stays a refusal only while the
      // resolution stayed silent too — hence `resolutionFailed`, passed in by the caller.
      if (resolutionFailed)
        return `git refused with no reason while a resolution failure was traced (exit ${String(exit)})`;
      return true;
    }
    const cause = trimmed || (err instanceof Error ? err.message : String(err));
    // Only reachable with a numeric `code` that is neither 1 nor 128.
    return `${cause} (exit ${String(exit)}, killed=${String(e?.killed === true)})`;
  }
}

/**
 * The stderr lines that say the object store could not be READ, not that an object is absent. Matched
 * anywhere in the blob, because git interleaves its `error:` lines with the `fatal:` refusal. Deliberately
 * narrow: none is a wording git uses for an ABSENT object.
 */
const OBJECT_STORE_FAULT =
  /unable to open|unable to read|could not open|permission denied|too many levels of symbolic links|not a git repository|unable to fork|corrupt|bad object|bad pack|unable to unpack|inflate/i;

/**
 * The stderr wordings that say "this name has no object", git's own text. A set rather than inline tests so a
 * wording added to one arm cannot fail to reach the other. The fault arm above still wins.
 */
const NAMES_MISSING_OBJECT =
  /missing (object|bare object|tree)|not a valid object name|could not get object info|ambiguous argument|unknown revision/i;

/**
 * The shape `execp` rejects with, read without a cast. `execp` attaches
 * `code`/`signal`/`killed`/`stdout`/`stderr` to the Error it rejects, but nothing in the type system says so.
 * A value that does not look like an exec rejection is reported as `undefined`.
 */
function execRejection(
  err: unknown,
): { code?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown } | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const o = err as Record<string, unknown>;
  // Recognised by the RESULT SHAPE, never the shape of its `code`: a plain `TypeError` also carries a string
  // `code` (`ERR_…`), and the code alone would classify our own bugs as git rejections.
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
 * Did git fail to run, rather than run and refuse? Decided from the rejection's shape and not its exit code,
 * because none of these carries one. Each returns a classified CAUSE.
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

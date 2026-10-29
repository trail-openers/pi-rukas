/**
 * lean/specify-absence — the two-wording classifier behind `existsInCommit`.
 *
 * Split from `specify-reset.ts` for the file-size cap; it is the same boundary.
 * `git cat-file -e <base>:<path>` answers exactly two things — the path is not
 * in that tree, or git could not be asked — and collapsing them is the bug this
 * module exists to prevent: reading a failure as absence would let a repository
 * git cannot read certify that EVERY submitted test is new, which passes the
 * exact fraud the newness rule in `validateSubmitRows` refuses while reporting
 * total confidence. So absence is a fact git has to STATE, per line.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import type { ExecFn } from "../worktree.ts";
import { NO_HOOKS, SpecifyResetError } from "./specify-reset.ts";

/**
 * Is `rel` a file in the tree of `ref`? Asked of git, not of the working tree.
 *
 * The boundary in `validateSubmitRows` needs this to refuse a submitted test
 * that the run's base ALREADY has — a tracked test the child never wrote is not
 * a new acceptance test, whatever it declares about it — and `git cat-file -e
 * <ref>:<rel>` is the only read that answers it, because a working-tree check
 * cannot tell "the child wrote this" from "it was checked out at me".
 *
 * Two answers, and the difference between them is everything:
 *
 *   - git ran and said the path is not in that commit → **false**: the file is
 *     new. Absence is a fact git has to STATE, in one of the wordings
 *     `existsInCommitProblem` recognises, and nothing else is absence;
 *   - anything else — the clone is unreadable, the probe was killed or timed
 *     out, its output blew its buffer → **throw**.
 *
 * The throw arm is the one that matters. Reading every failure as "not there"
 * would make a broken repository certify that every submitted test is new, and
 * the newness rule would pass the exact shape it exists to refuse while
 * reporting the loudest possible confidence.
 *
 * `ref` is a full lowercase oid or this throws: the shape check
 * `lean/base-proof.ts` applies to a run's base is applied here too, because a
 * ref that is a moving name or a revision chain silently changes which tree the
 * newness rule asks about.
 *
 * `--end-of-options` closes the ref so a path the child spelled cannot be read
 * as a flag, and `--literal-pathspecs` (a top-level option, as `commitTestFiles`
 * passes it) makes `tests/[a]x.test.sh` one file rather than a glob.
 */
export async function existsInCommit(
  exec: ExecFn,
  cwd: string,
  ref: string,
  rel: string,
): Promise<boolean> {
  if (!isFullCommitSha(ref))
    throw new SpecifyResetError(
      `could not read the base commit to check whether ${rel} is new: \`${ref}\` is not a full commit sha`,
    );
  try {
    await exec("git", {
      argv: [
        ...NO_HOOKS,
        "--literal-pathspecs",
        "cat-file",
        "-e",
        "--end-of-options",
        `${ref}:${rel}`,
      ],
      cwd,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch (err) {
    // ONE classifier, consulted once: undefined when git positively stated
    // absence, a cause when it did not. Two rules asked in sequence is how a
    // failure reads as absence in one and a fault in the other.
    const problem = existsInCommitProblem(err);
    if (problem === undefined) return false;
    throw new SpecifyResetError(
      `could not read the base commit ${ref} to check whether ${rel} is new: ${problem}`,
    );
  }
}

/**
 * The cause to report, or undefined when git positively said the path is
 * absent — the SINGLE classifier `existsInCommit` asks, and the only place the
 * two wording sets below are consulted.
 *
 * The shared tree-probe rule in `git-range.ts` (`gitCatFileSaysAbsent`) covers
 * the `does not exist` / `no such path` family but not the wording this probe
 * gets for a file that sits in the WORKING TREE but not in `<base>` —
 * `fatal: path '…' exists on disk, but not in '<base>'` — which carries no
 * "does not exist" and so reads as a store fault there. For the other caller of
 * that rule (`lens-evidence.ts`, asking whether a branch holds a prose file) a
 * fault is the safe answer; here it is the UNSAFE one, because the shape is
 * exactly the fraud the newness rule exists to catch. So the wording is
 * recognised HERE, at the caller that can say what it means, and deliberately
 * not pushed into the shared rule, where it would widen `lens-evidence`'s
 * absence set for a reason that has nothing to do with it.
 *
 * Recognition is per LINE and exhaustive, not "the blob mentions it": git
 * interleaves its own `error:` lines with a refusal, and measured against a
 * `chmod 000` fanout dir `cat-file -e` answers exit 128 with a permission
 * complaint FOLLOWED by a missing-object wording. A classifier that asked "does
 * any line say absent?" read an unreadable object store as "the base does not
 * hold this file" and certified the child's own file as new. So: a refusing
 * exit, no killed/signal, a numeric code, and EVERY non-empty line either a
 * recognised absence or nothing at all. Any other line is a fault, and the
 * cause says which.
 */
function existsInCommitProblem(err: unknown): string | undefined {
  const e = execRejection(err);
  const refusedExit = e?.code === 1 || e?.code === 128;
  const neverRan =
    e?.killed === true ||
    (e?.signal !== undefined && e?.signal !== null) ||
    typeof e?.code !== "number";
  if (!refusedExit || neverRan) return "the probe did not run to an exit git uses for refusal";
  const lines = (typeof e.stderr === "string" ? e.stderr : "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) return "git refused with no reason on stderr";
  for (const line of lines) {
    // A clone git cannot even open, checked per line so one such line among
    // absence wordings is the fault it is and not noise to ignore.
    if (/not a git repository|dubious ownership/i.test(line))
      return `the clone could not be read: ${line}`;
    // The store-fault wordings `lean/base-proof.ts` recognises for the same
    // question ("git could not READ its object store"). Inlined rather than
    // imported: that module keeps its classifier private, and a second site
    // owning a copy of the wording set is what `git-range.ts` exists to prevent
    // — so the shared set is this module's comment, and this is the one place
    // this probe reads it.
    if (OBJECT_STORE_FAULT.test(line)) return `the object store could not be read: ${line}`;
    // The wordings meaning "this name has no object in this commit".
    if (ABSENT_LINE.test(line)) continue;
    return `git's answer is neither an absence nor a recognised fault: ${line}`;
  }
  return undefined;
}

/**
 * The rejection shape `execp` attaches (`code`/`stderr`/`killed`/`signal`), read
 * without a cast. A throw with NONE of those fields is not something git answered
 * — a `TypeError` from our own code, or a wrapper that rejected without a result
 * — and reading a `code` off it would classify our own bug as a git verdict.
 */
function execRejection(
  err: unknown,
): { code?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown } | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const o = err as Record<string, unknown>;
  const shaped = "code" in o || "stderr" in o || "killed" in o || "signal" in o || "stdout" in o;
  return shaped
    ? { code: o.code, stderr: o.stderr, killed: o.killed, signal: o.signal }
    : undefined;
}

/** The store-fault wordings, same set `lean/base-proof.ts` uses for a ref probe. */
const OBJECT_STORE_FAULT =
  /unable to open|unable to read|could not open|permission denied|too many levels of symbolic links|not a git repository|unable to fork|corrupt|bad object|bad pack|unable to unpack|inflate/i;

/**
 * One line that positively names the object as absent from this commit: the
 * shared tree-probe rule's set, plus git's wording for a file that sits in the
 * WORKING TREE but not in the commit (`… exists on disk, but not in '<base>'`)
 * — the shape a child's own new file produces, and the one the rule exists to
 * catch. Deliberately NOT here: `Not a valid object name`, which is about the
 * REF and says nothing about the path.
 */
const ABSENT_LINE =
  /does not exist|no such (?:path|object|tree|file)|path '.+' exists on disk, but not in '.+'/i;

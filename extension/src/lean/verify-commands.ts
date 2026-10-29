/**
 * lean/verify-commands — the `command` criteria tier of the verify gate.
 *
 * A `command` criterion is the only place a `pi-spec` carries text that the
 * pipeline is meant to RUN, and the only kind whose pass condition is GREEN: it
 * states behaviour that already holds ("the existing reposition smoke tests still
 * pass"), so — unlike a frozen acceptance test — it can never be red on the base
 * and belongs at the gate, not at the freeze. `specify`'s coverage rule asks for
 * a red test only of `verify: "test"` criteria; this module is where the
 * preservation criteria are actually checked.
 *
 * **A residual the reader must not misread as isolation.** The test FILE is
 * pinned to the base commit — same tree entry, same mode, same blob oid, same
 * bytes on disk — but the CODE it loads is HEAD's, by design. A preservation
 * criterion exists to ask "does the new code still hold the old contract?", and
 * answering that with the base's own source would prove nothing about this run.
 * So the file is frozen and the product is not; `verify.ts` re-checks the tree
 * after this tier precisely because the code under test may have been rewritten
 * underneath it.
 *
 * Five rules make running text out of an issue body safe enough to try:
 *
 *   1. **A `command` is a FILE, never a command line.** It is accepted only as a
 *      plain repo-relative path, checked by the frozen tests' own path rule
 *      (`specify-tree`'s `normaliseRelPath` + `pathProblem`) plus a
 *      no-whitespace/no-shell-metacharacter test, and it is then handed to the
 *      project's `verify.test` template through `runTestFile` in **argv form** —
 *      so no shell ever parses it, and a traversal, an absolute path, `.git`,
 *      `.pi` or `node_modules` is refused before anything is spawned.
 *   2. **A `command` names an EXISTING test that has not changed since the base —
 *      in the commit AND on disk.** The criterion claims behaviour that already
 *      held before this run began, so the only file that can evidence it is one
 *      the base commit already held, byte for byte. `git ls-tree` answers that for
 *      both trees, and `git hash-object` answers it for the working file: a blob
 *      that differs from the base's is not the test the base had, whatever the
 *      index says (`--assume-unchanged` keeps `git status` quiet about exactly
 *      that). Checking the working tree with a plain `existsSync` FOLLOWS symlinks,
 *      so a committed mode-120000 entry pointing outside the worktree was
 *      porcelain-clean and got executed; checking HEAD alone let a developer
 *      author `src/wipe.sh`, exit 0, and have it recorded as a preservation
 *      criterion on a ready PR.
 *   3. **Not-runnable is not a verdict.** A criterion refused by any rule above
 *      is absent from the record — no throw, no red — with its own reason in
 *      `notRunnable[id]`: the criterion is treated like `manual`, `publish` keeps
 *      the PR a draft, and the body prints that reason on the criterion's own row.
 *      Reading it as a red would punish the developer for the spec's own defect;
 *      reading it as passed would be the lie this module exists to prevent.
 *   4. **An unrunnable runner is infrastructure.** A killed, timed-out or
 *      un-startable run THROWS, exactly as `frozenTestFailure` does — a verdict
 *      nobody observed is not evidence that the code is wrong. So is a tier that
 *      cannot finish inside its budget.
 *   5. **The tier is bounded.** At {@link COMMAND_CRITERION_MAX} criteria run per
 *      gate, and the whole tier shares {@link COMMAND_TIER_BUDGET_MS}; each run's
 *      timeout is the time the budget still has, so the tier cannot outlive the
 *      gate that trusts it. A run that is given no share cannot fall back to the
 *      runner's own default — it gets one millisecond and dies on it.
 *   6. **The `command` text is untrusted text.** It comes from the issue body, so
 *      every reason this module derives from it interpolates the clipped
 *      {@link oneLine} form: a reason reaches the durable record and then the PR
 *      body, and a 5 KB `command` must not become a 5 KB reason.
 */

import { trace } from "../trace.ts";
import type { Criterion } from "./spec.ts";
import { TEST_TIMEOUT_MS, runTestFile } from "./specify-proof.ts";
import { fileProblem, normaliseRelPath, pathProblem } from "./specify-tree.ts";
import { oneLine } from "./text-fence.ts";
import {
  entryRefusal,
  entryUnreadable,
  parseTreeLine,
  treeEntry,
  unreadableEntry,
  workingOid,
} from "./verify-tree.ts";
import { type VerifyExec, VerifyInfraError } from "./verify-types.ts";

/** The outcome of one executed `command` criterion, kept for the record. */
export interface CommandCriterionRecord {
  /** `passed` — the criterion ran through the gate's own runner and exited 0. */
  kind: "passed";
  /**
   * The base blob the pre-run check accepted, kept so the post-run re-check has an
   * expectation of its own. Read from the tree again afterwards, an oid would agree
   * with itself whatever the tier did to it — so a criterion that rewrote its own
   * file, or the tree that held it, would still be recorded as preservation.
   */
  oid: string;
  /**
   * The repo-relative path this criterion named, so the post-run re-check can find
   * the file again by more than its criterion id.
   */
  rel: string;
}

/** How many `command` criteria one gate run may execute. */
export const COMMAND_CRITERION_MAX = 32;

/** Wall clock the whole command tier gets, shared across every run in it. */
export const COMMAND_TIER_BUDGET_MS = 600_000;

/**
 * How much of a `command` a refusal may quote.
 *
 * The `command` is untrusted text out of the issue body, and every refusal below
 * quotes it, so the bound lives here rather than at each interpolation. It is
 * well under the record's own 300-character cap on a not-runnable reason
 * (`state-outcome`), which is what makes the clip at the SOURCE rather than at the
 * printer: a reason that was clipped only on its way to the PR body would still be
 * refused by the record, and a criterion declined for a reason too long to store
 * is declined for a reason nobody can read.
 */
const COMMAND_QUOTE_MAX = 80;
/** The `command` as this module may quote it: one line, at most {@link COMMAND_QUOTE_MAX}. */
const quoted = (command: string): string => oneLine(command, COMMAND_QUOTE_MAX);

export interface CommandCriteriaOutcome {
  /** First failure's reason, for a red; absent when nothing failed. */
  failed?: string;
  /** Every criterion the gate actually ran and that held, keyed by id. */
  executed: Record<string, CommandCriterionRecord>;
  /**
   * Why the gate did NOT run a given criterion, keyed by criterion id. Per
   * criterion rather than one slot, because a spec with three command criteria
   * can have three different problems — one names a file the base never held,
   * another is a symlink, a third was edited since base — and the operator has to
   * fix each one. The record is a durable record of verdicts, so the reason a
   * criterion was declined travels with its id rather than being flattened: the
   * PR body prints it on that criterion's own row.
   */
  notRunnable: Record<string, string>;
}

/**
 * Why this `command` criterion's file is not an unchanged regular test of the base,
 * or `undefined` when it is. A `VerifyInfraError` instead whenever a read could not
 * answer — "could not tell" must never read as "the test is not there", because the
 * first is a machine to re-run and the second is an issue to fix.
 *
 * Three reads, because there are three places the bytes can differ: the base
 * commit, HEAD, and the working file. The third is what an index trick hides —
 * `git update-index --assume-unchanged` keeps `git status` silent about a file
 * somebody rewrote on disk, so a tier that trusted the porcelain would run it. The
 * hash covers the bytes the runner is about to load, and they must equal the base's.
 */
async function unchangedFileProblem(
  exec: VerifyExec,
  wt: string,
  baseSha: string,
  rel: string,
  accepted: { oid: string },
): Promise<string | undefined> {
  accepted.oid = "";
  const base = await treeEntry(exec, wt, baseSha, rel);
  const head = await treeEntry(exec, wt, "HEAD", rel);
  if (base === "") return `${rel} does not exist at base`;
  if (head === "") return `${rel} changed since base`;
  const atBase = parseTreeLine(base, rel);
  if (atBase.kind !== "file") {
    if (entryUnreadable(atBase)) throw unreadableEntry(rel, wt);
    return entryRefusal(atBase);
  }
  const atHead = parseTreeLine(head, rel);
  if (atHead.kind !== "file") {
    if (entryUnreadable(atHead)) throw unreadableEntry(rel, wt);
    return entryRefusal(atHead);
  }
  // Same mode, same oid: the bytes the base commit held are the bytes HEAD holds,
  // which is the whole claim a preservation criterion makes. A differing oid is a
  // test somebody edited during this run — no longer evidence of what already held.
  if (atBase.oid !== atHead.oid) return `${rel} changed since base`;
  // git vouched for the COMMITTED entry; nothing above the commit is vouched for.
  if ((await workingOid(exec, wt, rel)) !== atBase.oid)
    return `${rel} differs on disk from the base commit`;
  // The file is the base's, byte for byte, on disk: remember which blob that was,
  // so the re-check after the runner compares against this observation rather than
  // a fresh read of whatever the tree now says.
  accepted.oid = atBase.oid;
  return undefined;
}

/**
 * Why a `command` criterion's `command` is not a path this gate may execute, or
 * `undefined` when it is one.
 *
 * The raw string is validated BEFORE trimming: a command padded with spaces or
 * newlines is a string someone meant to be run as something other than a path, and
 * silently trimming it would let `" rm -rf / "` through the shape check on its way
 * to a runner. A shell metacharacter, a space or a newline is refused HERE rather
 * than left to the existence check: an executable name may legitimately contain
 * none of them, so a string carrying one is a command someone meant to be run —
 * the exact thing this gate must never do — and `pathProblem` alone would pass
 * `sh -c 'exit 1'` (`sh` is a plain segment) before existence dropped it. An
 * explicit refusal makes the rule readable at the call site instead of an accident
 * of which path happens to exist.
 */
export function commandCriterionProblem(command: string | undefined): string | undefined {
  if (command === undefined || command === "") return "a command criterion carries no command";
  // The raw form, untrimmed: see above. `command.trim() === ""` is the one trim
  // this function performs, and it is a refusal rather than a repair.
  if (command.trim() === "") return "a command criterion carries no command";
  if (
    command.startsWith("/") ||
    command.startsWith("\\") ||
    command.includes("\\") ||
    /^[a-zA-Z]:[\\/]/.test(command)
  )
    return `command is not a repo-relative path: ${quoted(command)}`;
  // One word, no shell, no whitespace: a `command` is a FILE, never a command line.
  if (!/^[A-Za-z0-9._/-]+$/.test(command))
    return `command is not a plain repo-relative file path: ${quoted(command)}`;
  const rel = normaliseRelPath(command);
  if (rel !== command) return `command is not in normalised git-relative form: ${quoted(command)}`;
  // `pathProblem` interpolates the path it refused, and that path is untrusted text
  // of any length: a `../x…` of a few thousand characters is a valid refusal whose
  // reason would then be too long for the record that has to store it
  // (`state-outcome`'s 300), which refuses the whole outcome rather than the one
  // criterion. The refusal is re-worded around the clipped command rather than
  // trusting the callee's bound.
  const shape = pathProblem(rel);
  if (shape !== undefined) return `command is not a path this gate may execute: ${quoted(command)}`;
  return undefined;
}

/**
 * Execute every `command` criterion through the project's per-file runner.
 *
 * Every runnable criterion runs, in spec order, because a gate that stopped at
 * the first failure would report a different reason tomorrow for a different
 * criterion (the reasoning `frozenTestFailure` gives for running every frozen
 * file). Each must exit **0**: green is the pass condition for a preservation
 * criterion, and a non-zero exit is the regression it exists to catch.
 *
 * The tier is bounded twice over. At `COMMAND_CRITERION_MAX` criteria run — more
 * than that in one spec is a spec nobody can review, and the count is named rather
 * than silently truncated. And the whole tier shares `COMMAND_TIER_BUDGET_MS`:
 * each run's timeout is the time the budget still has, so thirty slow files cannot
 * add up to an hour the gate never agreed to wait.
 *
 * The runner gets the driver's SCRUBBED env (`verifyChildEnv()`) exactly as the
 * project tiers do: the thing under test is the project's own test file, and a
 * headless driver's knobs must not decide what it sees.
 */
export async function commandCriteriaOutcome(
  criteria: Criterion[],
  template: string | undefined,
  wt: string,
  baseSha: string,
  exec: VerifyExec,
  timeoutMs?: number,
  env?: NodeJS.ProcessEnv,
): Promise<CommandCriteriaOutcome> {
  const wanted = criteria.filter((c) => c.verify === "command");
  if (wanted.length === 0) return { executed: {}, notRunnable: {} };
  if (wanted.length > COMMAND_CRITERION_MAX)
    throw new VerifyInfraError(
      `the spec carries ${wanted.length} command criteria, more than the ${COMMAND_CRITERION_MAX} this gate will run`,
    );
  if (template === undefined)
    throw new VerifyInfraError(
      "no verify.test runner template is configured for the spec's command criteria",
    );
  const started = Date.now();
  const executed: Record<string, CommandCriterionRecord> = {};
  const notRunnable: Record<string, string> = {};
  let failed: string | undefined;
  for (const c of wanted) {
    const left = COMMAND_TIER_BUDGET_MS - (Date.now() - started);
    if (left <= 0) throw new VerifyInfraError("command criteria exceeded 600s");
    const problem = commandCriterionProblem(c.command);
    // A string that is not a path at all is the spec's own defect: never
    // executed, never a verdict, and carried to the PR body so the omission is
    // legible to the operator without a trace log.
    if (problem !== undefined) {
      notRunnable[c.id] = problem;
      trace(`lean/verify: command criterion ${c.id} not run — ${problem}`);
      continue;
    }
    // The text rule passed, so `command` is a normalised repo-relative path.
    const rel = normaliseRelPath(c.command as string);
    const accepted = { oid: "" };
    const treeProblem = await unchangedFileProblem(exec, wt, baseSha, rel, accepted);
    if (treeProblem !== undefined) {
      notRunnable[c.id] = treeProblem;
      trace(`lean/verify: command criterion ${c.id} not run — ${treeProblem}`);
      continue;
    }
    // The on-disk check is the frozen tier's own — a symlink, a hard link or
    // a path whose realpath leaves the worktree is refused before a byte of it
    // reaches the runner.
    const diskProblem = fileProblem(wt, rel);
    if (diskProblem !== undefined) {
      notRunnable[c.id] = diskProblem;
      trace(`lean/verify: command criterion ${c.id} not run — ${diskProblem}`);
      continue;
    }
    const proof = await runTestFile(exec, {
      wt,
      template,
      file: rel,
      limits: {
        // Always a share of what the tier's budget still has, never the runner's
        // default: a caller that gave no timeout is not licence for the last run
        // of a late tier to sit out the full 120s past the 600s the gate agreed to
        // wait. With no time left the run gets 1ms and dies on the timeout, which
        // `runTestFile` classifies as infra — the tier says so rather than
        // silently outliving the gate that trusts it.
        timeoutMs: Math.max(1, Math.min(timeoutMs ?? TEST_TIMEOUT_MS, left)),
        ...(env === undefined ? {} : { env }),
      },
    });
    if (proof.kind === "infra")
      throw new VerifyInfraError(
        `the command criterion ${c.id} could not be judged: ${proof.detail}`,
      );
    if (proof.kind === "green") {
      executed[c.id] = { kind: "passed", oid: accepted.oid, rel };
      continue;
    }
    // `red` and `unclear` both mean the file did not exit 0. Unlike a frozen
    // test, this file was never proven red at freeze time — a command criterion
    // is never frozen — so a non-zero exit is the regression the criterion
    // states against, whether or not the output named the path.
    failed ??= `criterion ${c.id} (command ${rel}) failed: ${proof.detail}`;
  }
  return {
    ...(failed === undefined ? {} : { failed }),
    notRunnable,
    executed,
  };
}

/**
 * Re-read the checks that licensed a run, after the runner has had the tree.
 *
 * A test file is code, and code may write: a criterion whose own `sh` script
 * rewrote the file it was named for, or chmod'd it, would otherwise leave the gate
 * recording a preservation criterion about bytes it never observed. The same reads
 * as before the run — the on-disk shape, the base tree entry, the working hash —
 * and any difference is a RED: the tier disturbed what it was meant to leave alone.
 * An entry that has become unreadable is infrastructure, as it was before.
 */
export async function commandCriteriaTouched(
  executed: Record<string, CommandCriterionRecord>,
  wt: string,
  baseSha: string,
  exec: VerifyExec,
): Promise<string | undefined> {
  for (const record of Object.values(executed)) {
    const rel = record.rel;
    const diskProblem = fileProblem(wt, rel);
    if (diskProblem !== undefined) return `command criteria changed the tree: ${diskProblem}`;
    const base = await treeEntry(exec, wt, baseSha, rel);
    if (base === "") return `command criteria changed the tree: ${rel} does not exist at base`;
    const entry = parseTreeLine(base, rel);
    if (entry.kind !== "file") {
      if (entryUnreadable(entry)) throw unreadableEntry(rel, wt);
      return `command criteria changed the tree: ${entryRefusal(entry)}`;
    }
    // Compared against the oid the PRE-run check accepted, not a freshly-read one:
    // a tier that rewrote the base tree itself must not have its own change serve as
    // the expectation the file is judged against.
    if (entry.oid !== record.oid)
      return `command criteria changed the tree: ${rel} changed since base`;
    if ((await workingOid(exec, wt, rel)) !== record.oid)
      return `command criteria changed the tree: ${rel} differs on disk from the base commit`;
  }
  return undefined;
}

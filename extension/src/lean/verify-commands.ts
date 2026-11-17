/**
 * lean/verify-commands — the `command` criteria tier of the verify gate.
 *
 * A `command` criterion is the only place a `pi-spec` carries text the pipeline is meant to RUN, and the
 * only kind whose pass condition is GREEN: it states behaviour that already holds, so it belongs at the
 * gate, not at the freeze.
 *
 * **A residual the reader must not misread as isolation.** The test FILE is pinned to the base commit, but
 * the CODE it loads is HEAD's, by design: a preservation criterion asks whether the new code still holds
 * the old contract.
 *
 * Six rules make running text out of an issue body safe enough to try:
 *
 *   1. **A `command` is a FILE, never a command line.** Accepted only as a plain repo-relative path, checked
 *      by the frozen tests' own path rule plus a no-whitespace/no-shell-metacharacter test, then handed to
 *      `verify.test` through `runTestFile` in **argv form** — no shell ever parses it.
 *   2. **A `command` names an EXISTING test, unchanged since the base — in the commit AND on disk.**
 *      `git ls-tree` answers for both trees and `git hash-object` for the working file, since
 *      `--assume-unchanged` keeps `git status` quiet about a changed blob. Checking the working tree with
 *      `existsSync` FOLLOWS symlinks, which is why the on-disk check exists alongside the tree reads; and
 *      checking HEAD alone would let a developer author a destructive script, exit 0, and record it as
 *      preservation.
 *   3. **Not-runnable is not a verdict.** A refused criterion is absent from the record — no throw, no red
 *      — with its reason in `notRunnable[id]`, treated like `manual`. As red it punishes the developer for
 *      the spec's defect; as passed it is the lie.
 *   4. **An unrunnable runner is infrastructure.** A killed, timed-out or un-startable run THROWS, as
 *      `frozenTestFailure` does. So does a tier that cannot finish inside its budget.
 *   5. **The tier is bounded.** {@link COMMAND_CRITERION_MAX} criteria per gate, all sharing
 *      {@link COMMAND_TIER_BUDGET_MS}; each run's timeout is what the budget still has.
 *   6. **The `command` text is untrusted.** Every reason interpolates the clipped {@link quoted} form and is
 *      clipped again by {@link reason} — a legal path can overshoot the record's bound and refuse the whole
 *      outcome rather than one criterion.
 */

import { trace } from "../trace.ts";
import type { Criterion } from "./spec.ts";
import { fileProblem, normaliseRelPath, pathProblem } from "./specify-path.ts";
import { TEST_TIMEOUT_MS, runTestFile } from "./specify-proof.ts";
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

/**
 * The outcome of one executed `command` criterion, kept for the record.
 */
interface CommandCriterionRecord {
  /** `passed` — the criterion ran through the gate's own runner and exited 0. */
  kind: "passed";
  /**
   * The base blob the pre-run check accepted, so the post-run re-check has its own expectation: read from
   * the tree again afterwards, an oid would agree with itself whatever the tier did.
   */
  oid: string;
  /** The repo-relative path, so the re-check can find the file by more than its id. */
  rel: string;
}

/** How many `command` criteria one gate run may execute. */
export const COMMAND_CRITERION_MAX = 32;

/** Wall clock the whole command tier gets, shared across every run in it. */
const COMMAND_TIER_BUDGET_MS = 600_000;

/**
 * How much of a `command` a refusal may quote. The text is untrusted out of the issue body and every
 * refusal quotes it, so the bound lives here rather than at each interpolation.
 */
const COMMAND_QUOTE_MAX = 80;

/** The `command` as this module may quote it: one line, at most {@link COMMAND_QUOTE_MAX}. */
const quoted = (command: string): string => oneLine(command, COMMAND_QUOTE_MAX);

/**
 * The longest reason either tier may produce for one criterion. Past `state-outcome-maps.ts`'s
 * `RECORD_REASON_MAX_CHARS` the whole verify outcome is unloadable rather than clipped, so every
 * interpolation is clipped here first.
 */
const REASON_MAX = 280;

/** A reason built by interpolating a path: clipped, so the record can store it. */
const reason = (text: string): string => oneLine(text, REASON_MAX);

/**
 * The path a tree reason may name: `parseTreeLine` interpolates the `rel` it was handed, so this puts both
 * halves of every reason through {@link quoted}.
 */
const reasonPath = (text: string): string => reason(quoted(text));

export interface CommandCriteriaOutcome {
  /** First failure's reason, for a red; absent when nothing failed. */
  failed?: string;
  /** Every criterion the gate actually ran and that held, keyed by id. */
  executed: Record<string, CommandCriterionRecord>;
  /**
   * Why the gate did NOT run a criterion, keyed by id — per criterion, because a spec can carry three
   * command criteria with three problems and the operator must fix each.
   */
  notRunnable: Record<string, string>;
}

/**
 * Why this `command` criterion's file is not an unchanged regular test of the base, or `undefined` when it
 * is. A `VerifyInfraError` instead whenever a read could not answer — "could not tell" must never read as
 * "the test is not there". Three reads: base commit, HEAD, working file.
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
  if (base === "") return reasonPath(`${rel} does not exist at base`);
  if (head === "") return reasonPath(`${rel} changed since base`);
  const atBase = parseTreeLine(base, rel);
  if (atBase.kind !== "file") {
    if (entryUnreadable(atBase)) throw unreadableEntry(rel, wt);
    return reason(entryRefusal(atBase));
  }
  const atHead = parseTreeLine(head, rel);
  if (atHead.kind !== "file") {
    if (entryUnreadable(atHead)) throw unreadableEntry(rel, wt);
    return reason(entryRefusal(atHead));
  }
  // Same mode and oid: the bytes the base held are the bytes HEAD holds.
  if (atBase.oid !== atHead.oid) return reasonPath(`${rel} changed since base`);
  // git vouched for the COMMITTED entry; nothing above the commit has.
  if ((await workingOid(exec, wt, rel)) !== atBase.oid)
    return reasonPath(`${rel} differs on disk from the base commit`);
  // Remember which blob, so the re-check compares against this observation.
  accepted.oid = atBase.oid;
  return undefined;
}

/**
 * Why a `command` criterion's `command` is not a path this gate may execute, or `undefined` when it is.
 *
 * The raw string is validated BEFORE trimming: a shell metacharacter, space or newline is refused here,
 * where `pathProblem` alone would pass a shell-shaped string.
 */
export function commandCriterionProblem(command: string | undefined): string | undefined {
  if (command === undefined || command === "") return "a command criterion carries no command";
  // The raw form, untrimmed — the only trim performed, and only as a refusal.
  if (command.trim() === "") return "a command criterion carries no command";
  if (
    command.startsWith("/") ||
    command.startsWith("\\") ||
    command.includes("\\") ||
    /^[a-zA-Z]:[\\/]/.test(command)
  )
    return `command is not a repo-relative path: ${quoted(command)}`;
  // One word, no shell: a `command` is a FILE, never a command line.
  if (!/^[A-Za-z0-9._/-]+$/.test(command))
    return `command is not a plain repo-relative file path: ${quoted(command)}`;
  const rel = normaliseRelPath(command);
  if (rel !== command) return `command is not in normalised git-relative form: ${quoted(command)}`;
  // `pathProblem` interpolates the path it refused — untrusted text of any length — so the refusal is
  // re-worded around the clipped command rather than trusting the callee.
  const shape = pathProblem(rel);
  if (shape !== undefined) return `command is not a path this gate may execute: ${quoted(command)}`;
  return undefined;
}

/**
 * Execute every `command` criterion through the project's per-file runner.
 *
 * Every runnable criterion runs, in spec order — a gate that stopped at the first failure would report a
 * different reason tomorrow for a different criterion. Each must exit **0**.
 *
 * Bounded twice over: `COMMAND_CRITERION_MAX` criteria, and the tier shares `COMMAND_TIER_BUDGET_MS`. The
 * runner gets the driver's SCRUBBED env, as the project tiers do.
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
    // A string that is not a path at all is the spec's own defect: never executed, never a verdict, and
    // carried to the PR body so the omission is legible without a trace log.
    if (problem !== undefined) {
      notRunnable[c.id] = reason(problem);
      trace(`lean/verify: command criterion ${c.id} not run — ${problem}`);
      continue;
    }
    const rel = normaliseRelPath(c.command as string);
    const accepted = { oid: "" };
    const treeProblem = await unchangedFileProblem(exec, wt, baseSha, rel, accepted);
    if (treeProblem !== undefined) {
      notRunnable[c.id] = reason(treeProblem);
      trace(`lean/verify: command criterion ${c.id} not run — ${treeProblem}`);
      continue;
    }
    // The frozen tier's on-disk check: a symlink, a hard link or a path whose realpath leaves the worktree
    // is refused before a byte reaches the runner.
    const diskProblem = fileProblem(wt, rel);
    if (diskProblem !== undefined) {
      notRunnable[c.id] = reasonPath(diskProblem);
      trace(`lean/verify: command criterion ${c.id} not run — ${diskProblem}`);
      continue;
    }
    const proof = await runTestFile(exec, {
      wt,
      template,
      file: rel,
      limits: {
        // Always a share of what the tier's budget still has, never the runner's default: no timeout from
        // the caller is not licence for the last run to sit out the full default past the budget. With no
        // time left the run gets 1ms and dies as infra.
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
    // `red` and `unclear` both mean the file did not exit 0. Unlike a frozen test this was never proven
    // red at freeze time, so a non-zero exit is the regression itself.
    failed ??= reason(`criterion ${c.id} (command ${quoted(rel)}) failed: ${proof.detail}`);
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
 * A test file is code, and code may write: a criterion whose own script rewrote the file it was named for
 * would be recorded as preservation of bytes the gate never observed. Any difference is a RED.
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
    if (diskProblem !== undefined)
      return reason(`command criteria changed the tree: ${reasonPath(diskProblem)}`);
    const base = await treeEntry(exec, wt, baseSha, rel);
    if (base === "")
      return reasonPath(`command criteria changed the tree: ${rel} does not exist at base`);
    const entry = parseTreeLine(base, rel);
    if (entry.kind !== "file") {
      if (entryUnreadable(entry)) throw unreadableEntry(rel, wt);
      return reason(`command criteria changed the tree: ${entryRefusal(entry)}`);
    }
    // Against the oid the PRE-run check accepted: a tier that rewrote the base tree cannot have its own
    // change serve as the expectation.
    if (entry.oid !== record.oid)
      return reasonPath(`command criteria changed the tree: ${rel} changed since base`);
    if ((await workingOid(exec, wt, rel)) !== record.oid)
      return reasonPath(
        `command criteria changed the tree: ${rel} differs on disk from the base commit`,
      );
  }
  return undefined;
}

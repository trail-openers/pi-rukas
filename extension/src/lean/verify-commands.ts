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
 * Four rules make that safe enough to run text that came out of an issue body:
 *
 *   1. **A `command` is a FILE, never a command line.** It is accepted only as a
 *      plain repo-relative path, checked by the frozen tests' own path rule
 *      (`specify-tree`'s `normaliseRelPath` + `pathProblem`) plus a
 *      no-whitespace/no-shell-metacharacter test, and it is then handed to the
 *      project's `verify.test` template through `runTestFile` in **argv form** —
 *      so no shell ever parses it, and a traversal, an absolute path, `.git`,
 *      `.pi` or `node_modules` is refused before anything is spawned.
 *   2. **A `command` names an EXISTING test that has not changed since the base.**
 *      The criterion claims behaviour that already held before this run began, so
 *      the only file that can evidence it is one the base commit already held,
 *      byte for byte. `git ls-tree` answers that for both trees — base and HEAD —
 *      and a criterion whose entry is missing at base, whose mode is not a
 *      regular-file mode (100644/100755 — never a 120000 symlink, never a tree),
 *      or whose blob oid differs between the two, is not a test the base had.
 *      Checking the working tree instead (a plain `existsSync`) FOLLOWS symlinks,
 *      so a committed mode-120000 entry pointing outside the worktree was
 *      porcelain-clean and got executed; checking HEAD alone let a developer
 *      author `src/wipe.sh`, exit 0, and have it recorded as a preservation
 *      criterion on a ready PR.
 *   3. **Not-runnable is not a verdict.** A criterion refused by either rule above
 *      is absent from the record — no throw, no red — with its own reason in
 *      `notRunnable[id]`: the criterion is treated like `manual`, `publish` keeps
 *      the PR a draft, and the body prints that reason on the criterion's own row.
 *      Reading it as a red would punish the developer for the spec's own defect;
 *      reading it as passed would be the lie this module exists to prevent.
 *   4. **An unrunnable runner is infrastructure.** A killed, timed-out or
 *      un-startable run THROWS, exactly as `frozenTestFailure` does — a verdict
 *      nobody observed is not evidence that the code is wrong.
 */

import { trace } from "../trace.ts";
import type { Criterion } from "./spec.ts";
import { runTestFile } from "./specify-proof.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import { fileProblem, normaliseRelPath, pathProblem } from "./specify-tree.ts";
import { type VerifyExec, VerifyInfraError } from "./verify-types.ts";

/** The outcome of one executed `command` criterion, kept for the record. */
export interface CommandCriterionRecord {
  /** `passed` — the criterion ran through the gate's own runner and exited 0. */
  kind: "passed";
}

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

/** A git blob oid, the only form whose equality means anything. */
const BLOB_OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * One `git ls-tree <ref> -- <rel>` in argv form, with the same hook and fsmonitor
 * guard every other lean git read carries.
 *
 * `-- <rel>` is what makes this a path question rather than a revision question:
 * without the separator a `rel` that also names a ref would answer a different
 * query. `undefined` means git refused, `""` means git answered "this tree holds
 * no such entry" — the two are NOT the same fact, and collapsing them would let a
 * broken git read look like an absent test.
 */
async function treeEntry(
  exec: VerifyExec,
  wt: string,
  ref: string,
  rel: string,
): Promise<string | undefined> {
  const r = await exec("git", {
    argv: [...NO_HOOKS, "ls-tree", ref, "--", rel],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
  if (r === undefined) return undefined;
  return (r.stdout ?? "").trim();
}

/**
 * Why a tree entry is not a regular file this gate may run, or `undefined`.
 *
 * The `{mode} blob <oid> <path>` form is what `ls-tree` prints for a file; anything
 * else is a fact this gate must not run past. A SYMLINK is mode 120000 — whose
 * target lives anywhere on the host, and the exact shape that used to reach the
 * runner because an existence probe follows links — and a directory is mode 040000
 * with type `tree`. The MODE is what decides: git prints `blob` for a symlink too,
 * so reading the type alone would let one through. A line whose path is not the one
 * asked for is refused too, because the query was for one exact entry.
 */
function entryProblem(line: string, rel: string): string | undefined {
  const parts = line.split(/\s+/);
  const mode = parts[0];
  if (mode === "tree" || mode === "040000") return `${rel} is a directory`;
  // Every mode that is not one of the two regular-file modes is refused, so a git
  // that reported some other object type under a file mode is declined, not run.
  if (mode !== "100644" && mode !== "100755") return `${rel} is a symlink`;
  if (parts[1] !== "blob" || !BLOB_OID.test(parts[2] ?? "")) return `${rel} is a symlink`;
  if (parts[3] !== rel) return `${rel} is not an exact path in the tree`;
  return undefined;
}

/** Does this line pass `entryProblem`'s shape rules on its own? */
function regularEntry(line: string): boolean {
  const parts = line.split(/\s+/);
  return (
    (parts[0] === "100644" || parts[0] === "100755") &&
    parts[1] === "blob" &&
    BLOB_OID.test(parts[2] ?? "")
  );
}

/** The blob oid of a tree entry already known to describe a regular file. */
function oidAt(line: string): string {
  return line.split(/\s+/)[2] ?? "";
}

/**
 * Why this `command` criterion's file is not an unchanged regular test of the base,
 * or `undefined` when it is.
 *
 * `undefined` from a git read is infrastructure — "could not tell" must never read
 * as "the test is not there", because the first is a machine to re-run and the
 * second is an issue to fix.
 */
async function unchangedFileProblem(
  exec: VerifyExec,
  wt: string,
  baseSha: string,
  rel: string,
): Promise<string | undefined> {
  const base = await treeEntry(exec, wt, baseSha, rel);
  const head = await treeEntry(exec, wt, "HEAD", rel);
  if (base === undefined || head === undefined)
    throw new VerifyInfraError(`could not read the tree entry for ${rel} in ${wt}`);
  if (base === "") return `${rel} does not exist at base`;
  if (head === "") return `${rel} changed since base`;
  const atBase = entryProblem(base, rel);
  if (atBase !== undefined) return atBase;
  if (!regularEntry(base))
    throw new VerifyInfraError(`could not read the tree entry for ${rel} in ${wt}`);
  const atHead = entryProblem(head, rel);
  if (atHead !== undefined) return atHead;
  if (!regularEntry(head))
    throw new VerifyInfraError(`could not read the tree entry for ${rel} in ${wt}`);
  // Same mode, same oid: the bytes the base commit held are the bytes HEAD holds,
  // which is the whole claim a preservation criterion makes. A differing oid is a
  // test somebody edited during this run — no longer evidence of what already held.
  if (oidAt(base) !== oidAt(head)) return `${rel} changed since base`;
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
    return `command is not a repo-relative path: ${command}`;
  // One word, no shell, no whitespace: a `command` is a FILE, never a command line.
  if (!/^[A-Za-z0-9._/-]+$/.test(command))
    return `command is not a plain repo-relative file path: ${command}`;
  const rel = normaliseRelPath(command);
  if (rel !== command) return `command is not in normalised git-relative form: ${command}`;
  return pathProblem(rel);
}

/**
 * Execute every `command` criterion through the project's per-file runner.
 *
 * Every runnable criterion runs, in spec order, because a gate that stopped at
 * the first failure would report a different reason tomorrow for a different
 * criterion (the reasoning `frozenTestFailure` gives for running every frozen
 * file). Each must exit **0**: green is the pass condition for a preservation
 * criterion, and a non-zero exit is the regression it exists to catch.
 */
export async function commandCriteriaOutcome(
  criteria: Criterion[],
  template: string | undefined,
  wt: string,
  baseSha: string,
  exec: VerifyExec,
  timeoutMs?: number,
): Promise<CommandCriteriaOutcome> {
  const wanted = criteria.filter((c) => c.verify === "command");
  if (wanted.length === 0) return { executed: {}, notRunnable: {} };
  if (template === undefined)
    throw new VerifyInfraError(
      "no verify.test runner template is configured for the spec's command criteria",
    );
  const executed: Record<string, CommandCriterionRecord> = {};
  const notRunnable: Record<string, string> = {};
  let failed: string | undefined;
  for (const c of wanted) {
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
    const treeProblem = await unchangedFileProblem(exec, wt, baseSha, rel);
    if (treeProblem !== undefined) {
      notRunnable[c.id] = treeProblem;
      trace(`lean/verify: command criterion ${c.id} not run — ${treeProblem}`);
      continue;
    }
    // git vouched for the COMMITTED entry; nothing above the commit is vouched
    // for. The on-disk check is the frozen tier's own — a symlink, a hard link or
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
      ...(timeoutMs === undefined ? {} : { limits: { timeoutMs } }),
    });
    if (proof.kind === "infra")
      throw new VerifyInfraError(
        `the command criterion ${c.id} could not be judged: ${proof.detail}`,
      );
    if (proof.kind === "green") {
      executed[c.id] = { kind: "passed" };
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

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
 * Three rules make that safe enough to run text that came out of an issue body:
 *
 *   1. **A `command` is a FILE, never a command line.** It is accepted only as a
 *      plain repo-relative path to an existing file, checked by the frozen tests'
 *      own path rule (`specify-tree`'s `normaliseRelPath` + `pathProblem`) plus a
 *      no-whitespace/no-shell-metacharacter test, and it is then handed to the
 *      project's `verify.test` template through `runTestFile` in **argv form** —
 *      so no shell ever parses it, and a traversal, an absolute path, `.git`,
 *      `.pi` or `node_modules` is refused before anything is spawned.
 *   2. **Not-runnable is not a verdict.** A `command` that fails the path rule,
 *      or names a file the worktree does not hold, is simply absent from the
 *      record: the criterion is treated like `manual`, `publish` keeps the PR a
 *      draft, and the body says `not runnable (command is not a repo test path)`.
 *      Reading it as a red would punish the developer for the spec's own defect;
 *      reading it as passed would be the lie this module exists to prevent.
 *   3. **An unrunnable runner is infrastructure.** A killed, timed-out or
 *      un-startable run THROWS, exactly as `frozenTestFailure` does — a verdict
 *      nobody observed is not evidence that the code is wrong.
 *
 * A missing `verify.test` template with command criteria present also throws:
 * the spec asked for checks the project cannot run, which is the machine's
 * fault, and quietly treating them as manual would let a run go green on criteria
 * nothing executed.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { trace } from "../trace.ts";
import type { Criterion } from "./spec.ts";
import { runTestFile } from "./specify-proof.ts";
import { normaliseRelPath, pathProblem } from "./specify-tree.ts";
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
}

/**
 * Why a `command` criterion's `command` is not a path this gate may execute, or
 * `undefined` when it is one.
 *
 * A shell metacharacter, a space or a newline is refused HERE rather than left
 * to the existence check: an executable name may legitimately contain none of
 * them, so a string carrying one is a command someone meant to be run — the exact
 * thing this gate must never do — and `pathProblem` alone would pass
 * `sh -c 'exit 1'` (`sh` is a plain segment) before existence dropped it. An
 * explicit refusal makes the rule readable at the call site instead of an
 * accident of which path happens to exist.
 */
export function commandCriterionProblem(command: string | undefined): string | undefined {
  if (command === undefined || command.trim() === "")
    return "a command criterion carries no command";
  const raw = command.trim();
  if (
    raw.startsWith("/") ||
    raw.startsWith("\\") ||
    raw.includes("\\") ||
    /^[a-zA-Z]:[\\/]/.test(raw)
  )
    return `command is not a repo-relative path: ${raw}`;
  // One word, no shell, no whitespace: a `command` is a FILE, never a command line.
  if (!/^[A-Za-z0-9._/-]+$/.test(raw))
    return `command is not a plain repo-relative file path: ${raw}`;
  const rel = normaliseRelPath(raw);
  if (rel !== raw) return `command is not in normalised git-relative form: ${raw}`;
  return pathProblem(rel);
}

/** Is `rel` an existing file in `wt`? A missing path is not runnable, so no. */
function isFileIn(wt: string, rel: string): boolean {
  try {
    return existsSync(path.join(wt, rel));
  } catch {
    return false;
  }
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
  exec: VerifyExec,
  timeoutMs?: number,
): Promise<CommandCriteriaOutcome> {
  const wanted = criteria.filter((c) => c.verify === "command");
  if (wanted.length === 0) return { executed: {} };
  if (template === undefined)
    throw new VerifyInfraError(
      "no verify.test runner template is configured for the spec's command criteria",
    );
  const executed: Record<string, CommandCriterionRecord> = {};
  let failed: string | undefined;
  for (const c of wanted) {
    const problem = commandCriterionProblem(c.command);
    // A string that is not a path at all is the spec's own defect: never
    // executed, never a verdict, and traced so the omission has a record behind
    // the body line.
    if (problem !== undefined) {
      trace(`lean/verify: command criterion ${c.id} not run — ${problem}`);
      continue;
    }
    const rel = normaliseRelPath((c.command as string).trim());
    if (!isFileIn(wt, rel)) {
      trace(`lean/verify: command criterion ${c.id} not run — ${rel} is not a file at HEAD`);
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
  return { ...(failed === undefined ? {} : { failed }), executed };
}

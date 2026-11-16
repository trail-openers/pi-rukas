/**
 * lean/submodule-reads — the two shapes of git call this step makes, and the difference
 * between them that matters: a read may answer nothing, a write may not.
 *
 * `ask` is a probe and never throws: a step that could not ask a question about a tree it
 * does not own reports “no expectation” rather than failing a run over a read, because an
 * absent answer is information and a thrown read is an outage. `run` is a mutation and
 * surfaces the child's own words instead of throwing, so both arms of the submodule pass
 * report alike and the caller decides whether the failure is the handback it must raise or a
 * note it can carry. Every argv arrives with `NO_HOOKS` from its caller: a worktree being
 * populated is not a place for the repository's own hooks to run.
 */

import type { ExecFn } from "../worktree.ts";
import { trim } from "./specify-proof.ts";
import { SpecifyInfraError } from "./specify-reset.ts";
import { describe } from "./submodule-verify.ts";

/** The wall clock on the short reads that decide where a submodule comes from. */
const QUICK_GIT_MS = 30_000;
/** The wall clock on a submodule initialisation, which may reach the network. */
const SUBMODULE_TIMEOUT_MS = 5 * 60_000;

/** A read that must not fail the run: git's answer, or `undefined` when it had none. */
export async function ask(
  exec: ExecFn,
  cwd: string,
  argv: string[],
): Promise<{ stdout?: string } | undefined> {
  const ran = await exec("git", {
    argv,
    cwd,
    timeout: QUICK_GIT_MS,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
  return ran as { stdout?: string } | undefined;
}

/** The call itself, with the failure surfaced rather than thrown — so both arms report alike. */
export async function run(exec: ExecFn, wt: string, argv: string[]): Promise<unknown | undefined> {
  const ran = await exec("git", {
    argv,
    cwd: wt,
    timeout: SUBMODULE_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  }).catch((err: unknown) => ({ __err: err }) as never);
  return (ran as { __err?: unknown })?.__err;
}

/** The handback, whose words are the release's own: an offline trial must read as infrastructure. */
export function handback(wt: string, failed: unknown, command: string): SpecifyInfraError {
  return new SpecifyInfraError(
    `the worktree's submodules could not be initialised in ${wt}: ${command} — ${trim(describe(failed))}`,
  );
}

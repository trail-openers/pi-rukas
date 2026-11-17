/**
 * lean/submodule-reads — the two shapes of git call this step makes: a read may answer nothing, a
 * write may not. `ask` never throws — an absent answer is information, a thrown read an outage —
 * while `run` surfaces the child's own words instead of throwing, so both arms of the pass report
 * alike and the caller decides whether it is the handback to raise or a note to carry. Every argv
 * arrives with `NO_HOOKS` from its caller.
 */
import type { ExecFn } from "../worktree.ts";
import { trim } from "./specify-proof.ts";
import { SpecifyInfraError } from "./specify-reset.ts";
import { describe } from "./submodule-verify.ts";

/** The wall clock on the short reads that decide where a submodule comes from. */
const QUICK_GIT_MS = 30_000;
/** The git flags every lean step's git calls carry: a repository's own hooks are somebody else's
 *  policy and a repo-supplied fsmonitor is a program git runs on every status, either of which
 *  could write into a commit the step never captured. A leaf so the submodule modules carry it
 *  without importing `specify-reset.ts`, which imports them. */
export const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] as const;
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

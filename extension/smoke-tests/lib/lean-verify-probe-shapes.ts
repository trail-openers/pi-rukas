/**
 * lib/lean-verify-probe-shapes — how a case tells the exec stub what the BASE looked like.
 *
 * The baseline probe asks the base two questions (what bytes does it hold at the run's
 * frozen paths, and what does the tier do there), and a case must be able to answer either
 * without rewriting a commit. These are the option shapes that carry those answers, plus the
 * one predicate that recognises the probe's blob read among the step's git calls. They live
 * apart from `lean-verify-exec.ts` because they are the probe's vocabulary, not the stub's
 * dispatch: a case reads them as documentation of what it declared.
 */

import type { VerifyExec } from "../../src/lean/verify-types.ts";

/** The probe's base-side shapes a case may declare, as a subset of `VerifyOpts`. */
export interface ProbeShapeOpts {
  /**
   * Make the probe's TIER run at the base hang until the executor's own group kill fires
   * — the shape a base run that timed out really leaves behind (`killed`, `timedOutKill`,
   * `code: null`, no numeric exit at all).
   *
   * The BASE is the only place this shape is observable: a kill in the run's own worktree
   * is caught by `runTier` and throws as infrastructure before any probe. A base run with
   * no exit code is the one a classification order gets wrong — an exit-code test asked
   * before the observation test reads the absence as "no non-zero exit", i.e. a GREEN
   * base. A run nobody watched has no colour at all, so the tier's own red must stand.
   */
  baseRunTimesOut?: boolean;
  /**
   * Make the probe's TIER run at the base exceed its output bound — the executor's own
   * overflow shape (`overflow` stamped, `killed` true, `timedOutKill` NOT set). A run
   * whose output was truncated holds no evidence, so like a kill it has no colour and the
   * tier's own red must stand.
   */
  baseRunOverflows?: boolean;
  /**
   * Make the probe's base-blob read (`git show <base>:<frozen path>`) reject with a
   * NON-128 code — a timeout or an overflow, not git's "this commit holds no such path".
   * "I could not look" is not "it was not there", and it is not a colour either: the
   * could-not-look arm must not excuse the tier, so the run stays red with the tier's own
   * output and no `baseline red:` reason.
   */
  baseBlobReadFails?: boolean;
  /**
   * The bytes the probe's `git show <base>:<frozen path>` answers with, for the cases that
   * must get PAST the contract arm to reach the tier classifier. Any non-empty string that
   * is not what the run froze is the base holding other bytes at the run's frozen path — a
   * mainline whose own copy of that test does not satisfy the run's contract, which is what
   * makes a red at the base something the probe can actually see.
   */
  baseBlobBytes?: string;
  /**
   * Commit a `.pi/worktree-setup` hook AT THE BASE that writes a marker into `marksDir`
   * naming the tree it was run against. The probe must never execute it: a throwaway base
   * checkout is a directory another process's shell can reach, and the hook is the
   * project's arbitrary code. `marksDir` is the case's own temp dir, read back afterwards.
   */
  hookAtBase?: { script: string; marksDir: string };
}

/**
 * Is this exec call the probe reading the base's bytes at a frozen path?
 *
 * `probeTierAtBase` runs that `git show` with `cwd: repoRoot` and a `<baseSha>:<path>`
 * argument, so the tree-naming test in `lean-verify-exec.ts` cannot see it — the probe's own
 * base sha can. Only the cases that declare a blob shape use this, and the sha is the run's,
 * so no other call in the step carries it.
 */
export function isProbeBlobRead(
  o2: Parameters<VerifyExec>[1] | undefined,
  baseSha?: string,
): boolean {
  return (
    baseSha !== undefined &&
    Array.isArray(o2?.argv) &&
    o2.argv.some((a) => typeof a === "string" && a.startsWith(`${baseSha}:`))
  );
}

/**
 * The NON-128 rejection a case asks the probe's base-blob read to produce.
 *
 * The executor's own timeout shape (`timedOutKill`, no numeric `code`), which
 * `gitPathAbsent` cannot mistake for git's "no such path" (exit 128 plus its wording), and
 * which must not be read as a colour. With no `stdout` own-property the contract's reader
 * cannot inspect any bytes, so the probe is answered by its could-not-look arm rather than
 * by the base commit — which is what that case is about.
 */
export function probeBlobReadTimeoutError(): Error {
  return Object.assign(new Error("git show: timed out"), {
    killed: true,
    timedOutKill: true,
    signal: "SIGKILL",
  });
}

/**
 * The hung/chatty base TIER command a case asks for, built from the configured tier's own
 * marker so the red the case reads back is the tier's, not the harness's.
 *
 * A `sleep` past the bound and a `yes` past its `maxBuffer` are the two shapes the executor
 * really produces; both are returned here rather than at the call site so the pair stays in
 * one place and the stub's dispatch keeps reading as dispatch.
 */
export function baseTierHangCommand(
  tiers: string[],
  overflow: boolean,
): { cmd: string; maxBuffer: number } {
  const marker = (tiers[0] ?? "").match(/tier-said-([a-z0-9-]+)/)?.[1] ?? "base";
  return overflow
    ? {
        cmd: `sh -c 'echo tier-said-${marker} 1>&2; yes x'`,
        maxBuffer: 8 * 1024,
      }
    : {
        cmd: `sh -c 'echo tier-said-${marker} 1>&2; exec sleep 60'`,
        maxBuffer: 16 * 1024 * 1024,
      };
}

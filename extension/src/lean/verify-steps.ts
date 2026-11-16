/**
 * lean/verify-steps — the three things the verify step EXECUTES, and the boundary between
 * "the code failed" and "the machine could not answer".
 *
 * That boundary is the whole design of this step. A tier that exits non-zero is a verdict about the
 * work and comes back as `red` with the output tail that says why. A tier that was killed, timed out,
 * or could not be started is not a verdict at all — it is the environment refusing to answer, and the
 * step throws so the engine hands the run back rather than routing a build round on a result nobody
 * observed.
 *
 * Three executors, three reasons for their options:
 *
 *   - **the toolchain canary** runs first, before any verdict is recorded: a type-checker stubbed to
 *     `exit 0` produces exactly the green this step must never report;
 *   - **the frozen tests** run through `runTestFile`, which classifies a kill or an un-startable
 *     runner as `infra`; of those, only a runner that could not be started becomes a throw — a frozen
 *     file the head hangs is graded red, because the freeze already proved it red against the base
 *     (see `frozenTestFailure`);
 *   - **the project tiers** run as shell commands with the driver's knobs scrubbed out of the child
 *     env (`verifyChildEnv`), in their own process group (`killGroup`) so a timeout actually kills the
 *     tree of processes a build spawns, and under a wall clock.
 */

import { guardCompilerIntegrity, packageDirFor } from "../work-driver-toolchain-canary.ts";
import { verifyChildEnv } from "../work-driver-verify-cmd.ts";
import { neverStarted, runTestFile, wasKilled } from "./specify-proof.ts";
import { type VerifyExec, VerifyInfraError, type VerifyTiers } from "./verify-types.ts";

/** A tier gets half an hour; a suite that needs longer is a project bug. */
export const TIER_TIMEOUT_MS = 30 * 60_000;

/** The last lines of a tier's output — the part that says what actually broke. */
export const TIER_TAIL_LINES = 40;

/**
 * What one executed thing said about the work.
 *
 * `fail` is a VERDICT — something observed the code and the code did not hold. `infra` is not a
 * verdict at all: nothing was observed, and the caller turns it into a throw so the engine hands the
 * run back. Keeping the two apart in the type is what stops a "could not tell" from being read as an
 * `undefined` and then as a green.
 *
 * What counts as "nothing was observed" is narrower than it looks, and `frozenTestFailure` is where
 * the line sits: a frozen test that exits non-zero without echoing its own path is a `fail` (it was
 * proven red at freeze time), and so is one the head's code made HANG. The shapes that stay `infra`
 * are the ones where nothing was ever run. The shell's 126 and 127 are NOT a third shape: a real test
 * can exit 127 after printing its own failure, so routing those on the number alone hides genuine
 * reds.
 */
export type Executed =
  | { kind: "pass" }
  | { kind: "fail"; reason: string }
  | { kind: "infra"; reason: string };

/** An exit status for a reason string; a kill or kill-before-exec has none. */
function exitLabel(code: number | undefined): string {
  return code === undefined ? "no exit status" : `exit ${code}`;
}

/** Join whatever a command printed into one block for a tail. */
function outputOf(parts: Array<string | undefined>): string {
  return parts.filter((s): s is string => typeof s === "string" && s !== "").join("\n");
}

/** The last `n` non-empty lines, so a stack of blank padding is not a tail. */
export function tailLines(out: string, n: number = TIER_TAIL_LINES): string {
  const lines = out.split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/**
 * Did the toolchain canary PROVE the compiler unsound?
 *
 * Only `failure` is a throw: `guardCompilerIntegrity` reports an unaskable canary as a `note`, so
 * "could not look" never accuses a compiler.
 */
async function canaryReason(
  cmd: string,
  cwd: string,
  exec: VerifyExec,
): Promise<string | undefined> {
  const guarded = await guardCompilerIntegrity({
    cmd,
    cwd,
    where: `the lean verify step in ${cwd}`,
    run: exec,
  });
  return guarded?.failure;
}

/**
 * Run every configured tier's compiler-integrity canary.
 *
 * Each tier is canaried at the directory ITS command resolves the pinned compiler against
 * (`packageDirFor`): a tier that opens with `cd extension` runs a different compiler than one that
 * runs at the root.
 */
export async function canaryFailure(
  tiers: string[],
  wt: string,
  exec: VerifyExec,
): Promise<string | undefined> {
  for (const cmd of tiers) {
    const dir = packageDirFor(cmd, wt);
    const failure = await canaryReason(cmd, dir, exec);
    if (failure !== undefined) return failure;
  }
  return undefined;
}

/**
 * The head's code may hang, named first in the reason and never only in its tail.
 *
 * The red reason is clipped to `RED_REASON_CLIP` and pasted into the next build child's prompt; a
 * reason whose only mention of the hang sat at the end could be clipped away.
 */export const FROZEN_TIMEOUT_HEAD = "frozen tests timed out (the head's code may hang):";

/**
 * Run the frozen acceptance tests with the project's per-file runner template.
 *
 * EVERY plain verdict is collected: a step that stopped at the first failure would report a different
 * reason tomorrow for a different file, and the fix round would learn about the second failure only
 * after paying for the first. A HANG is the exception, and the exception is a cost bound: after the
 * first wall-clock kill nothing further runs, so a hang costs at most ONE bound per verify.
 *
 * A wall-clock kill is a RED here, reported with the plain failures already observed. Every file in
 * the contract was proved red against the base before `runTestPipeline` committed it — the only way a
 * file gets frozen — so a head that now hangs it is the code under build failing. The other `infra`
 * shapes stay throws: a runner that never started, a template with nothing to run, and a run whose
 * output flooded past the executor's bound all observed nothing. A flood is not a hang.
 */
export async function frozenTestFailure(
  frozen: Record<string, string>,
  template: string | undefined,
  wt: string,
  exec: VerifyExec,
  timeoutMs?: number,
): Promise<Executed> {
  if (template === undefined)
    throw new VerifyInfraError("no verify.test runner template is configured for the frozen tests");
  const failures: string[] = [];
  const files = Object.keys(frozen);
  for (const [i, file] of files.entries()) {
    const proof = await runTestFile(exec, {
      wt,
      template,
      file,
      ...(timeoutMs === undefined ? {} : { limits: { timeoutMs } }),
    });
    if (proof.kind === "infra") {
      // Switched on the classifier's own `infraShape` rather than re-derived here, so the halves
      // cannot disagree about a hang. The `default` is the exhaustiveness check.
      switch (proof.infraShape) {
        case "killed": {
          // One bound per verify: the files this kill stopped short of are counted, not run.
          const skipped = files.length - i - 1;
          const parts = [`${FROZEN_TIMEOUT_HEAD} ${file}`];
          if (failures.length > 0) parts.push(`frozen tests failing: ${failures.join(", ")}`);
          if (skipped > 0)
            parts.push(`${skipped} other frozen file${skipped === 1 ? "" : "s"} not run`);
          return { kind: "fail", reason: parts.join(" — ") };
        }
        case "overflowed":
        case "never-started":
        case "nothing-to-run":
          // Each observed nothing, so each throws; `continue` lives in the `default` below, the
          // only way out of the switch that keeps running the loop.
          throw new VerifyInfraError(
            `the frozen test ${file} could not be judged: ${proof.detail}`,
          );
        default: {
          const unhandled: never = proof.infraShape;
          throw new VerifyInfraError(`unhandled infra shape ${String(unhandled)}`);
        }
      }
    }
    // A non-zero exit whose output never named this file is a RED, not infrastructure: the file was
    // proven red-and-named at freeze time.
    if (proof.kind === "unclear")
      return {
        kind: "fail",
        reason: `frozen test ${file} failed (${exitLabel(proof.code)}; output did not name it)`,
      };
    if (proof.kind !== "green") failures.push(`${file} (${proof.detail})`);
  }
  if (failures.length === 0) return { kind: "pass" };
  return { kind: "fail", reason: `frozen tests failing: ${failures.join(", ")}` };
}

/**
 * Run one project verify tier as a shell command in the worktree.
 *
 * `env` is the scrubbed child env: the driver's own knobs are stripped so a headless runner's
 * configuration cannot flip behaviour inside the project's tests. `killGroup` is what makes the
 * timeout real — a build that spawns a grandchild holding stdout keeps the pipe open past Node's own
 * kill.
 */
export async function runTier(
  name: string,
  cmd: string,
  wt: string,
  exec: VerifyExec,
  timeoutMs: number = TIER_TIMEOUT_MS,
): Promise<Executed> {
  const ran = await exec(cmd, {
    cwd: wt,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    killGroup: true,
    env: verifyChildEnv(),
  }).catch((err: unknown) => ({ __err: err }) as never);
  const err = (ran as { __err?: unknown })?.__err;
  if (err === undefined) return { kind: "pass" };
  const e = err as {
    code?: unknown;
    stdout?: string;
    stderr?: string;
    message?: string;
    overflow?: string;
  };
  const out = outputOf([e.stdout, e.stderr, e.message]);
  // A kill or a timeout means nobody observed the work, so no verdict may be recorded.
  if (wasKilled(err))
    throw new VerifyInfraError(
      `the verify.${name} tier was killed or timed out at ${timeoutMs}ms: ${cmd}`,
    );
  // `execp` stamps `overflow` on the maxBuffer path and does NOT stamp `timedOutKill`, so a chatty
  // tier is not mistaken for a hung one. Nor is it a verdict: the output was truncated.
  if (e.overflow !== undefined)
    throw new VerifyInfraError(
      `the verify.${name} tier exceeded its output bound on ${e.overflow}: ${cmd}`,
    );
  // A command that never started (ENOENT, EACCES) rejects with a string code and no exit status.
  if (neverStarted(err))
    throw new VerifyInfraError(
      `the verify.${name} tier could not be started: ${cmd}: ${out.slice(0, 300)}`,
    );
  return {
    kind: "fail",
    reason: `verify.${name} exited ${e.code}: ${cmd}\n${tailLines(out)}`,
  };
}

/**
 * The tiers this run executes, in order: the configured `fast` then `full`, or the repo's committed
 * `.pi/verify-cmd` when neither is configured.
 *
 * `verify.full` alone is not a fallback target here — `loadWorkConfig` already fills it from
 * `.pi/verify-cmd` when there is no `.pi/work.json` at all.
 */
export function tiersOf(
  configured: VerifyTiers,
  verifyCmd: string | undefined,
): [string, string][] {
  const tiers: [string, string][] = [];
  if (configured.fast !== undefined && configured.fast.trim() !== "")
    tiers.push(["fast", configured.fast]);
  if (configured.full !== undefined && configured.full.trim() !== "")
    tiers.push(["full", configured.full]);
  if (tiers.length > 0) return tiers;
  if (verifyCmd !== undefined && verifyCmd.trim() !== "") return [["verify-cmd", verifyCmd]];
  return [];
}

/**
 * lean/verify-steps — the three things the verify step EXECUTES, and the
 * boundary between "the code failed" and "the machine could not answer".
 *
 * That boundary is the whole design of this step. A tier that exits non-zero is
 * a verdict about the work and comes back as `red` with the output tail that
 * says why. A tier that was killed, timed out, or could not be started is not a
 * verdict at all — it is the environment refusing to answer, and the step
 * throws so the engine hands the run back rather than routing a build round on
 * a result nobody observed. Reading a timeout as a red would send a developer
 * back to "fix" code that was never judged.
 *
 * Three executors, three reasons for their options:
 *
 *   - **the toolchain canary** runs first, before any verdict is recorded:
 *     a type-checker that has been stubbed to `exit 0` produces exactly the
 *     green this step must never report;
 *   - **the frozen tests** run through `runTestFile`, which classifies kills
 *     and un-startable runners as `infra` for this module to turn into a throw;
 *   - **the project tiers** run as shell commands with the driver's knobs
 *     scrubbed out of the child env (`verifyChildEnv`), in their own process
 *     group (`killGroup`) so a timeout actually kills the tree of processes a
 *     build spawns, and under a wall clock so a hung suite is an observed
 *     timeout rather than a wedged run.
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
 * `fail` is a VERDICT — something observed the code and the code did not hold.
 * `infra` is not a verdict at all: nothing was observed, and the caller turns
 * it into a throw so the engine hands the run back rather than routing a build
 * round on a result nobody saw. Keeping the two apart in the type is what stops
 * a "could not tell" from being read as an `undefined` and then as a green.
 *
 * What counts as "nothing was observed" is narrower than it looks, and
 * `frozenTestFailure` is where the line sits: a frozen test that exits non-zero
 * without echoing its own path is a `fail` (it was proven red at freeze time,
 * so a later non-zero exit is that failure continuing), while a runner that was
 * killed, timed out or never started is `infra` — that one never ran. The 126
 * and 127 the shell reports for "not executable" and "not found" belong with
 * the latter: the shell answered, but nothing that could judge the code ever
 * existed, so accusing the work of it sends a developer to fix code nobody ran.
 */
export type Executed =
  | { kind: "pass" }
  | { kind: "fail"; reason: string }
  | { kind: "infra"; reason: string };

/**
 * The shell's "I could not run this" exit statuses: 126 is not executable,
 * 127 is not found. Both mean the command line named something that never
 * became a process, so neither carries a verdict about the code under test.
 */
const UNRUNNABLE_EXIT: ReadonlySet<number | undefined> = new Set([126, 127]);

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
 * Only `failure` is a throw. `guardCompilerIntegrity` reports an unaskable
 * canary as a `note` — "could not look" never accuses a compiler, and the
 * tier's own command is what reports a dependency tree that is not installed.
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
 * Each tier is canaried at the directory ITS command resolves the pinned
 * compiler against (`packageDirFor`), which is where that command would have
 * found it: a tier that opens with `cd extension` runs a different compiler
 * than one that runs at the root, and asking at the root would probe a compiler
 * the tier never executes.
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
 * Run the frozen acceptance tests with the project's per-file runner template.
 *
 * EVERY frozen file runs: a step that stopped at the first failure could report
 * the same reason tomorrow for a different file, and the fix round would only
 * learn about the second failure after paying for the first.
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
  for (const file of Object.keys(frozen)) {
    const proof = await runTestFile(exec, {
      wt,
      template,
      file,
      ...(timeoutMs === undefined ? {} : { limits: { timeoutMs } }),
    });
    if (proof.kind === "infra")
      throw new VerifyInfraError(`the frozen test ${file} could not be judged: ${proof.detail}`);
    // 126/127 are the SHELL's own refusal to run anything: "not executable" and
    // "not found". The exit status is real, so `neverStarted` (which asks for a
    // non-numeric code) cannot see it, and the runner never existed to judge the
    // code. That is the machine, not a verdict: throwing hands the run back, a
    // red would send a developer to fix code nothing ever executed.
    if (proof.kind === "unclear" && UNRUNNABLE_EXIT.has(proof.code))
      throw new VerifyInfraError(
        `the frozen test runner could not run ${file} (${exitLabel(proof.code)}): ${proof.detail}`,
      );
    // A non-zero exit whose output never named this file is a RED, not
    // infrastructure (the PM's call, reversing the earlier reading). The file
    // was proven red-and-named at freeze time, so it was a real failing test on
    // the base commit; a later non-zero exit is that test still failing, and the
    // only thing missing is the runner's own echo of the path. Treating it as
    // infra handed the run back for a test failure the developer can act on.
    // Only the shapes where nobody ran anything — killed, timed out, never
    // started — stay throws, because those observed nothing.
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
 * `env` is the scrubbed child env: the driver's own knobs are stripped so a
 * headless runner's configuration cannot flip behaviour inside the project's
 * tests. `killGroup` is what makes the timeout real — a build that spawns a
 * grandchild holding stdout keeps the pipe open past Node's own kill, and the
 * run would then neither finish nor time out.
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
  // A kill or a timeout means nobody observed the work, so no verdict may be
  // recorded. Both classifiers below are specify-proof's, imported rather than
  // re-derived here: two definitions of "was it killed" in one pipeline is how
  // the halves start disagreeing about a tier that exited 1.
  if (wasKilled(err))
    throw new VerifyInfraError(
      `the verify.${name} tier was killed or timed out at ${timeoutMs}ms: ${cmd}`,
    );
  // #1414 — `execp` stamps `overflow` on the maxBuffer path and deliberately
  // does NOT stamp `timedOutKill`, so a chatty tier is not mistaken for a hung
  // one. Nor is it a verdict: the output was truncated, so the evidence the
  // tier would have given is not in hand.
  if (e.overflow !== undefined)
    throw new VerifyInfraError(
      `the verify.${name} tier exceeded its output bound on ${e.overflow}: ${cmd}`,
    );
  // A command that never started (ENOENT, EACCES) rejects with a string code
  // and no exit status; a command that ran and failed always carries a number.
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
 * The tiers this run executes, in order: the configured `fast` then `full`, or
 * the repo's committed `.pi/verify-cmd` when neither is configured.
 *
 * `verify.full` alone is not a fallback target here — `loadWorkConfig` already
 * fills it from `.pi/verify-cmd` when there is no `.pi/work.json` at all, so
 * "neither set" genuinely means the repository named nothing.
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

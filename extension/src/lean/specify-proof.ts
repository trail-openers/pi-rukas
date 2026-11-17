/**
 * lean/specify-proof — runs one captured test file and reads its verdict.
 *
 * The step's claim is "these tests are red on the code as it stands", and that is worth
 * nothing unless something executed the file. This module runs the project's `verify.test`
 * template with `{file}` replaced and classifies the result. Four kinds, and they do NOT
 * all mean the same thing:
 *
 *   - `red`     — non-zero exit AND the output named this file (path or basename). The
 *                 only kind that counts as proof.
 *   - `green`   — exit 0 on the base commit. Not a test of the feature, so the file is
 *                 dropped and its criterion goes uncovered.
 *   - `unclear` — non-zero without naming the file. Dropped with a reason.
 *   - `infra`   — the ONLY kind that throws: killed by the wall clock (`"killed"`),
 *                 flooded its output past the executor's bound (`"overflowed"` — a
 *                 chatty run, not a hung one), could not be STARTED (non-numeric
 *                 `code`), or the template named nothing to run.
 *
 * There is deliberately no fifth shape: a classifier that threw on any output containing
 * `Cannot find module` would punish the canonical TDD red — what a test prints when it
 * imports a module not written yet. Whether the TOOLCHAIN works at all is answered once,
 * before the child is dispatched, by the base-health check in specify.ts.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import type { VerifyExecFn } from "../work-driver-git.ts";
import { TEST_RUNNER_PLACEHOLDER } from "./config.ts";

/** How long one test file gets before the step calls it an environment fault. */
export const TEST_TIMEOUT_MS = 120_000;

/**
 * The ceiling for one run, overridable so a test can inject a short one —
 * production never sets them.
 */
export interface TestRunLimits {
  timeoutMs?: number;
  /**
   * The run's output ceiling, for a case that wants to watch the executor's own
   * overflow kill: a test that could not shrink the bound could not reach the
   * maxBuffer path without printing eight megabytes.
   */
  maxBuffer?: number;
  /**
   * The child's environment. The command-criteria tier passes the driver's
   * scrubbed env (`verifyChildEnv()`) so a headless runner's own knobs cannot
   * change what the project's tests see; absent, the ambient env — what the
   * freeze-time proof runs want, since they judge the tree as the developer sees
   * it.
   */
  env?: NodeJS.ProcessEnv;
}

/** Output ceiling for one test run; overflow is an infra fault, not a red. */
const TEST_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * The shape of a run that produced no verdict, as `runTestFile` classified it.
 *
 * The four say different things to the caller and must not be collapsed: a
 * wall-clock kill means the code under test never returned (and for a FROZEN file
 * already proven red at freeze time, that is a verdict — `frozenTestFailure` in
 * `verify-steps.ts`), while an output flood, a runner that could not be started and
 * a template that named nothing observed nothing at all. An overflow is a kill
 * (`killed: true`) but NOT a hang.
 *
 * The shape is carried out REQUIRED: a caller that re-derived it from the returned
 * `Proof` would find no `killed`/`timedOutKill`/`code` on it and would read every
 * kill as a template problem.
 */
type ProofInfraShape = "killed" | "overflowed" | "never-started" | "nothing-to-run";

/** What any proof carries, whatever it concluded. */
interface ProofBase {
  /** The runner command as run, for the outcome reason. */
  cmd: string;
  /** The classification's evidence, verbatim. */
  detail: string;
}

/** A run that ended with an exit status the caller reads as a verdict about the code. */
interface ProofVerdict extends ProofBase {
  kind: "red" | "green" | "unclear";
  /** Exit status; undefined for a timeout/kill or a runner that never started. */
  code?: number;
}

/** A run that observed nothing. Which refusal it was is not optional. */
interface ProofInfra extends ProofBase {
  kind: "infra";
  infraShape: ProofInfraShape;
}

export type Proof = ProofVerdict | ProofInfra;

/** Was this rejection a timeout or a signal rather than a non-zero exit? */
export function wasKilled(err: unknown): boolean {
  const e = err as { killed?: boolean; signal?: string | null; timedOutKill?: boolean };
  // `killed` AND `timedOutKill` are only decisive on their own: Node's execFile rejection
  // for an ordinary non-zero exit carries `signal: null` as an OWN property, so a plain
  // `exit 1` would otherwise be read as a kill and throw the whole step away.
  if (e?.killed === true || e?.timedOutKill === true) return true;
  return e?.signal !== undefined && e.signal !== null;
}

/**
 * Did this rejection come from the executor's OUTPUT bound rather than its clock?
 *
 * `execp` stamps `overflow` with the stream that broke its bound on that path and
 * leaves `timedOutKill` false, so an overflow is a kill that is not a hang. Asked
 * before `wasKilled`, whose answer is true for both.
 */
function outputOverflowed(err: unknown): boolean {
  return (err as { overflow?: unknown })?.overflow !== undefined;
}

/** Exit status from a rejected exec, or undefined when there was none. */
function exitCodeOf(err: unknown): number | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "number" ? code : undefined;
}

/**
 * Did the runner process even start? `ENOENT` (no such executable), `EACCES`
 * (not executable) and their ilk reject with a STRING code and no exit
 * status; a command that ran and failed always carries a numeric status.
 */
export function neverStarted(err: unknown): boolean {
  return typeof (err as { code?: unknown })?.code === "string" && exitCodeOf(err) === undefined;
}

function outputOf(out: string | undefined, err: unknown): string {
  const e = err as { stdout?: unknown; stderr?: unknown };
  const parts = [
    out ?? "",
    typeof e?.stdout === "string" ? e.stdout : "",
    typeof e?.stderr === "string" ? e.stderr : "",
  ];
  return parts.join("\n");
}

/** Replace every `{file}` in the template with the test path. */
export function renderTestCommand(template: string, file: string): string {
  return template.split(TEST_RUNNER_PLACEHOLDER).join(file);
}

/**
 * Run one test file in `wt` and classify the outcome.
 *
 * Never throws: a kill, a timeout and a runner that could not be started all come
 * back as `kind: "infra"`, and the caller decides whether throwing is the right
 * response to a toolchain it cannot trust.
 *
 * `killGroup` is what makes a timeout classify at all: the runner is spawned in its own
 * process group so the timeout SIGKILLs the whole group and stamps the rejection `killed` +
 * `timedOutKill`. Without it, Node kills only the direct child — and when that child is `sh`
 * running a script that spawned something holding stdout, the callback never fires. Either way
 * a hang must be infra, never read as a red or a green.
 */
export async function runTestFile(
  exec: VerifyExecFn,
  opts: { wt: string; template: string; file: string; limits?: TestRunLimits },
): Promise<Proof> {
  const cmd = renderTestCommand(opts.template, opts.file);
  const timeout = opts.limits?.timeoutMs ?? TEST_TIMEOUT_MS;
  // argv form: the template is read as the executable plus its arguments, so the project's
  // runner never reaches a shell that would re-parse the worktree's path.
  const [bin, ...args] = cmd.split(/\s+/).filter((w) => w !== "");
  if (bin === undefined || args.length === 0) {
    // A template with no arguments cannot name a file to run; config.ts rejects the shape at
    // load and this refuses it at the run.
    return {
      kind: "infra",
      cmd,
      detail: `runner template has nothing to run: ${cmd}`,
      infraShape: "nothing-to-run",
    };
  }
  const base = path.basename(opts.file);
  const ran = await exec(bin, {
    argv: args,
    cwd: opts.wt,
    timeout,
    maxBuffer: opts.limits?.maxBuffer ?? TEST_MAX_BUFFER,
    killGroup: true,
    ...(opts.limits?.env === undefined ? {} : { env: opts.limits.env }),
  }).catch((err: unknown) => ({ __err: err }) as never);
  const err = (ran as { __err?: unknown })?.__err;
  if (err === undefined) return { kind: "green", cmd, code: 0, detail: "exited 0 on base" };
  const out = outputOf((ran as { stdout?: string })?.stdout, err);
  // Overflow is asked before the kill, because an overflow IS a kill: `killed: true`
  // with `timedOutKill: false` and the stream named in `overflow`.
  if (outputOverflowed(err))
    return {
      kind: "infra",
      cmd,
      detail: `the runner's output passed the executor's bound on ${String((err as { overflow?: unknown }).overflow)}`,
      infraShape: "overflowed",
    };
  if (wasKilled(err))
    return {
      kind: "infra",
      cmd,
      detail: `the runner was killed or timed out at ${timeout}ms`,
      infraShape: "killed",
    };
  if (neverStarted(err))
    return {
      kind: "infra",
      cmd,
      detail: `the runner could not be started: ${trim(out)}`,
      infraShape: "never-started",
    };
  const code = exitCodeOf(err);
  // The submitted PATH is what a runner echoes when it could not run the file at all, the
  // BASENAME what it echoes when the file ran and its assertions failed. Either counts as
  // "the output named this file".
  if (!out.includes(base) && !out.includes(opts.file))
    return { kind: "unclear", cmd, code, detail: `exited ${String(code)} without naming ${base}` };
  return { kind: "red", cmd, code, detail: `exited ${String(code)}` };
}

/** A short, single-line excerpt of runner output for a reason string. */
export function trim(out: string): string {
  return out.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** sha256 of a Buffer or a string, hex, no padding. */
export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

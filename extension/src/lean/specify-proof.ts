/**
 * lean/specify-proof — runs one captured test file and reads its verdict.
 *
 * The step's whole claim is "these tests are red on the code as it stands",
 * and that claim is only worth anything if something executed the file. This
 * module runs the project's `verify.test` template with `{file}` replaced and
 * classifies the result. There are four kinds and they do NOT all mean the
 * same thing to the caller:
 *
 *   - `red`    — non-zero exit AND the output named this file (its path or
 *                its basename). The only kind that counts as proof.
 *   - `green`  — exit 0 on the base commit. Not a test of the feature, so the
 *                file is dropped and its criterion goes uncovered.
 *   - `unclear`— non-zero without naming the file: something else failed and
 *                the output never mentioned this test. Dropped with a reason.
 *   - `infra`  — the ONLY kind that throws, and only two shapes of it: the
 *                runner was killed or timed out, or the runner could not be
 *                STARTED at all (the rejection carries a non-numeric `code`
 *                and no exit status — `ENOENT`, `EACCES`).
 *
 * There is deliberately no third `infra` shape any more. The classifier that
 * used to live here threw the whole run on any output containing
 * `node_modules` or `Cannot find module`, which is precisely what the
 * canonical TDD red prints when a test imports a module the implementation
 * has not written yet — so the step punished the one test shape it exists to
 * collect. A missing module in a test's own output is a legitimate red.
 * Whether the TOOLCHAIN works at all is answered once, before the child is
 * dispatched, by the base-health check in specify.ts; a red never has to
 * answer that question for itself.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import type { VerifyExecFn } from "../work-driver-git.ts";
import { TEST_RUNNER_PLACEHOLDER } from "./config.ts";

/** How long one test file gets before the step calls it an environment fault. */
export const TEST_TIMEOUT_MS = 120_000;

/**
 * The ceiling for one run, overridable so a test can inject a short one.
 * Production never sets it; a sleeper would otherwise cost the real two
 * minutes and the case asserting "a timeout is infra, never red" would be
 * untestable.
 */
export interface TestRunLimits {
  timeoutMs?: number;
  /**
   * The child's environment. The command-criteria tier passes the driver's
   * scrubbed env (`verifyChildEnv()`) so a headless runner's own knobs cannot
   * change what the project's tests see; absent, the ambient env — which is what
   * the freeze-time proof runs want, since they judge the tree as the developer
   * sees it.
   */
  env?: NodeJS.ProcessEnv;
}

/** Output ceiling for one test run; overflow is an infra fault, not a red. */
export const TEST_MAX_BUFFER = 8 * 1024 * 1024;

export type ProofKind = "red" | "green" | "unclear" | "infra";

export interface Proof {
  kind: ProofKind;
  /** The runner command as run, for the outcome reason. */
  cmd: string;
  /** Exit status; undefined for a timeout/kill or a runner that never started. */
  code?: number;
  /** The classification's evidence, verbatim. */
  detail: string;
}

/** Was this rejection a timeout or a signal rather than a non-zero exit? */
export function wasKilled(err: unknown): boolean {
  const e = err as { killed?: boolean; signal?: string | null; timedOutKill?: boolean };
  // `killed` AND `timedOutKill` are only decisive on their own: Node's
  // execFile rejection for an ordinary non-zero exit carries `signal: null`
  // as an OWN property, so `?? null` never falls through and a plain `exit 1`
  // would otherwise be read as a kill and throw the whole step away.
  if (e?.killed === true || e?.timedOutKill === true) return true;
  return e?.signal !== undefined && e.signal !== null;
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
 * Never throws: a kill, a timeout and a runner that could not be started all
 * come back as `kind: "infra"`, and it is the caller that decides throwing is
 * the right response to a toolchain it cannot trust.
 *
 * `killGroup` is what makes a timeout classify at all: the runner is spawned
 * in its own process group so the timeout SIGKILLs the whole group and stamps
 * the rejection `killed` + `timedOutKill`. Without it, Node's plain exec
 * timeout kills only the direct child — and when that child is `sh` running a
 * script that itself spawned something holding stdout, the callback never
 * fires, so the run neither times out nor finishes. Either way a hang must be
 * infra, never read as a red or a green.
 */
export async function runTestFile(
  exec: VerifyExecFn,
  opts: { wt: string; template: string; file: string; limits?: TestRunLimits },
): Promise<Proof> {
  const cmd = renderTestCommand(opts.template, opts.file);
  const timeout = opts.limits?.timeoutMs ?? TEST_TIMEOUT_MS;
  // argv form: the template is read as the executable plus its arguments, so
  // the project's runner never reaches a shell that would re-parse the
  // worktree's path. config.ts refuses the shell-shaped templates that would
  // want otherwise.
  const [bin, ...args] = cmd.split(/\s+/).filter((w) => w !== "");
  if (bin === undefined || args.length === 0) {
    // A template with no arguments cannot name a file to run: the placeholder
    // check in config.ts rejects the shape, and this refuses it at the run.
    return { kind: "infra", cmd, detail: `runner template has nothing to run: ${cmd}` };
  }
  const base = path.basename(opts.file);
  const ran = await exec(bin, {
    argv: args,
    cwd: opts.wt,
    timeout,
    maxBuffer: TEST_MAX_BUFFER,
    killGroup: true,
    ...(opts.limits?.env === undefined ? {} : { env: opts.limits.env }),
  }).catch((err: unknown) => ({ __err: err }) as never);
  const err = (ran as { __err?: unknown })?.__err;
  if (err === undefined) return { kind: "green", cmd, code: 0, detail: "exited 0 on base" };
  const out = outputOf((ran as { stdout?: string })?.stdout, err);
  if (wasKilled(err))
    return {
      kind: "infra",
      cmd,
      detail: `the runner was killed or timed out at ${timeout}ms`,
    };
  if (neverStarted(err))
    return { kind: "infra", cmd, detail: `the runner could not be started: ${trim(out)}` };
  const code = exitCodeOf(err);
  // The submitted PATH is what a runner echoes when it could not run the
  // file at all, and the BASENAME is what it echoes when the file ran and
  // its own assertions failed. Either counts as "the output named this
  // file"; requiring the basename alone read every real test as unclear.
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

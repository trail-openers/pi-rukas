/**
 * fixtures/publish-guard-fixture — the fakes the publish-guard suites drive
 * `assertPublishableBranch` and its three callers with.
 *
 * The guard reads its mainline through the CALLER's exec seam, which is the argv
 * form (`exec("git", { argv: [...] })`). `resolveMainline`'s own probes are shell
 * strings, and `git ls-remote --symref origin HEAD` is one too. A seam that
 * forwards argv-only calls therefore answers NOTHING to the probes and the guard
 * sees an unresolvable mainline — which looks exactly like the fail-open it is
 * meant to catch. So every fake here records BOTH call forms and each suite
 * asserts on the recorder: "the guard refused" is worthless unless the probe
 * actually reached the fake that was meant to answer it.
 */

import { execp } from "../../src/exec.ts";
import { gitTestEnv } from "../lib/git-test-env.ts";

/**
 * The argv-form executor every lean caller holds — the intersection of
 * `ExecFn` and `VerifyExecFn` that `lean/verify-types.ts` calls `VerifyExec`.
 * Stated structurally here so a fixture need not import the production union.
 */
export type GuardCallerExec = (
  cmd: string,
  opts?: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    argv?: string[];
    env?: NodeJS.ProcessEnv;
    killGroup?: boolean;
    stdoutEncoding?: "utf8" | "latin1";
  },
) => Promise<{ stdout: string; stderr?: string }>;

/** One call the fake answered: how it arrived and what it asked for. */
export interface FakeCall {
  form: "argv" | "shell";
  cmd: string;
  argv: string[];
  cwd?: string;
  timeout?: number;
}

/** The joined command line of a recorded call, in either form. */
export function callLine(c: FakeCall): string {
  return [c.cmd, ...c.argv].join(" ");
}

/** What the fake should do with one command line. */
export type FakeAnswer = string | { reject: string } | undefined;

/**
 * The recording fake: answers by command line, and keeps every call it saw.
 *
 * A command line the `answer` map does not name resolves with an EMPTY stdout
 * rather than throwing, because an empty mainline answer is the arm the guard
 * must also refuse — and because a fake whose map was written against a command
 * that never ran then shows up in `calls` as a call nobody answered, which is
 * how a silently-bypassed probe becomes observable instead of invisible.
 */
export function mkGuardExec(
  answer: (line: string) => FakeAnswer = () => undefined,
): {
  exec: GuardCallerExec;
  calls: FakeCall[];
  /** Every call's command line, in arrival order — the recorder. */
  lines: string[];
  /** Did a recorded call's line contain every one of `needles`? */
  saw: (...needles: string[]) => boolean;
} {
  // `lines` is the recorder's own view of `calls` — the same array, so a case can
  // assert on either without the two disagreeing about what was asked.
  const calls: FakeCall[] = [];
  const lines: string[] = [];
  const exec: GuardCallerExec = async (cmd, opts) => {
    const argv = [...(opts?.argv ?? [])];
    const line = [cmd, ...argv].join(" ");
    calls.push({
      form: opts?.argv === undefined ? "shell" : "argv",
      cmd,
      argv,
      cwd: opts?.cwd,
      timeout: opts?.timeout,
    });
    lines.push(line);
    const a = answer(line);
    if (a !== undefined && typeof a === "object") {
      // The node-exec rejection shape, so `causeOf` classifies it as an exit
      // rather than as a rejection nobody stamped.
      throw Object.assign(new Error(a.reject), { code: 1, killed: false, signal: null });
    }
    return { stdout: a ?? "", stderr: "" };
  };
  return {
    exec,
    calls,
    lines,
    saw: (...needles: string[]) => calls.some((c) => needles.every((n) => callLine(c).includes(n))),
  };
}

/** Every lean suite's push argv carries `push`; a refusal must not produce one. */
export function pushCalls(calls: FakeCall[]): FakeCall[] {
  return calls.filter((c) => c.argv.includes("push"));
}

/**
 * A `git ls-remote --symref origin HEAD` reply naming `branch` as origin's HEAD.
 *
 * The real reply is three lines: the symref row, then HEAD and the branch each
 * at their sha. Only the first row matters to the guard, and the sha rows are
 * what make the fake look like git rather than like a guess about git.
 */
export function symrefReply(branch: string): string {
  const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4";
  return [`ref: refs/heads/${branch}\tHEAD`, `${sha}\tHEAD`, `${sha}\trefs/heads/${branch}`].join(
    "\n",
  );
}

/** The command fragments each of the guard's three probes contains. */
export const PROBE = {
  symbolicRef: "symbolic-ref",
  gh: "gh repo view",
  lsRemote: "ls-remote",
} as const;

/** The production executor on the fixture's isolated git view.
 *
 * Same shape as `lean-verified-handback-fixture.ts`'s `exec`: both call forms
 * reach `execp`, and the scrubbed env is what keeps `test-verify-loop-git-env`
 * green for a suite that drives real git through a production seam.
 */
export const guardRealExec: GuardCallerExec = (cmd, opts) =>
  execp(cmd, { ...(opts ?? {}), env: gitTestEnv() });

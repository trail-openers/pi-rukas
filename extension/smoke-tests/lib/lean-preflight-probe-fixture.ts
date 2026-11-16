/**
 * lib/lean-preflight-probe-fixture — drive the runner preflight ALONE.
 *
 * `runSpecify` reaches the probe only as one stage of a whole `specify` run, so a
 * case that wants to know WHICH path the probe was written to has to watch the
 * worktree from the inside. This module calls `assertRunnerCanRunTests` directly on
 * a directory the case made, so the probe's path is read off the argv the step
 * handed the runner: the assertion is the path itself, not an inference from a run
 * that happened to pass.
 *
 * The exec is the fixture's own (`execp` under `gitTestEnv()`), so a stub runner
 * behaves identically on a host with a real `python3` on `PATH` and one without.
 * Split from `lib/lean-specify-fixture.ts` for the AGENTS §12 line cap.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import type { TestLocation } from "../../src/lean/config-test-location.ts";
import type { Proof, TestRunLimits } from "../../src/lean/specify-proof.ts";
import { assertRunnerCanRunTests } from "../../src/lean/specify-preflight.ts";
import type { SpecifyDeps } from "../../src/lean/specify.ts";
import { gitTestEnv } from "./git-test-env.ts";
import type { VerifyExecFn } from "../../src/work-driver-git.ts";
import { ROOTS } from "./lean-specify-fixture.ts";

/** The probe's name at the worktree root, as `specify-preflight.ts` names it today. */
export const PROBE = ".lean-runner-probe.test";

/**
 * The name a Python project's probe carries instead.
 *
 * Two of pytest's refusals are about the NAME rather than the content: a leading
 * dot breaks the default prepend import mode (an empty `.hidden.py` exits 2), and a
 * path pytest cannot match exits 4. A visible, dot-free stem is the shape that
 * reaches collection and reports "collected 0 items" — exit 5.
 */
export const PY_PROBE = "_lean_runner_probe.py";

/**
 * The env entry a real interpreter needs in order to find its own user packages.
 *
 * `gitTestEnv()` isolates git by pointing `HOME` at an empty directory - and
 * CPython derives its *user* site-packages from `$HOME` (`~/.local/lib/pythonX.Y/
 * site-packages`), so an env built from the post-isolation `process.env` cannot
 * import anything the operator installed with `pip install --user`. A real-pytest
 * case then measures `No module named pytest` - exit 1, which the preflight calls
 * a broken bench: it reports the host rather than the probe, and a case whose whole
 * subject is what a real runner answers is then measuring nothing.
 *
 * Restoring `HOME` is the lever, and the only one that works on this shape of
 * CPython:
 *
 *   - `PYTHONUSERBASE` does not. Debian's `site.py` carries its own copy of
 *     `_getuserbase()` and rebuilds the user-site path from `$HOME` whatever the
 *     variable says, while `sysconfig`'s copy reads the variable - so the two
 *     disagree and the site dir ends up OUT of `sys.path`. Measured with `HOME`
 *     isolated: `PYTHONUSERBASE` set to the real home leaves `import pytest` failing
 *     and the site dir absent from `sys.path`; `HOME` restored puts it back and the
 *     import succeeds.
 *   - `PYTHONPATH` aimed at the site dir fails for a subtler reason: that directory
 *     holds `.pth` files (`distutils-precedence.pth` among them) and `PYTHONPATH`
 *     entries are NOT processed as site dirs, so those files never run. That leaves
 *     the interpreter in a state no real project's interpreter is ever in - which is
 *     exactly what a real-runner case must not manufacture.
 *
 * So this entry says what the interpreter was always meant to see: the operator's
 * home, taken from the passwd entry through `userInfo()` - which bun answers from
 * the passwd database, so the isolation `gitTestEnv()` installs cannot hide it (the
 * same reason `linkModelCache` in `git-test-env.ts` reads it that way). Git keeps
 * its isolated view: `runPreflight`'s exec merges `gitTestEnv()` OVER this entry, so
 * a probe run's git calls still see the empty home, and the runner itself is not a
 * git call.
 *
 * A case that names `HOME` in its own `limits.env` wins - its entry is applied
 * first and this one is merged over the caller's `PYTHONPATH`-style additions only.
 * Returns `{}` when no home can be named, leaving the caller's env alone; the case's
 * own skip gate is what decides whether the host can run it at all.
 */
export function pythonUserEnv(): Record<string, string> {
  try {
    const home = userInfo().homedir;
    return home === "" ? {} : { HOME: home };
  } catch {
    // No passwd entry to read: the caller's env stands, and the skip gate says
    // whether the host can run the case.
    return {};
  }
}

/** A temp dir for a probe-only run; recorded so the caller's cleanup removes it. */
export function probeDir(prefix = "lean-preflight-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  ROOTS.push(dir);
  mkdirSync(path.join(dir, "tests"), { recursive: true });
  return dir;
}

/**
 * Commit a `#!/bin/sh` runner into `dir` and return the `verify.test` template that
 * runs it. `body` is the script's statements, each on its own line after the
 * shebang and the echo of the file it was handed.
 */
export function runner(dir: string, name: string, ...body: string[]): string {
  writeFileSync(
    path.join(dir, name),
    ["#!/bin/sh", 'echo "runner: $1" 1>&2', ...body, ""].join("\n"),
    { mode: 0o755 },
  );
  return `sh ${name} {file}`;
}

/**
 * Run the probe against `opts.wt` and report what the runner was handed.
 *
 * `written` collects the last argv word of every exec the step issued, which is the
 * probe's worktree-relative path — `runTestFile` always calls in argv form with the
 * file last. `note` is the disclosure the step recorded for a runner that rejected
 * the probe. A throw comes back as `threw` rather than ending the file, for the same
 * reason `runSpecify` returns `threw`.
 * `opts.throwOnRun` is the seam that lets the RUN call itself fail instead of
 * answering. A record with a `code` is the rejection the real executor answers for a
 * runner that RAN and exited non-zero, so a case can watch the step classify a status
 * it never executed. `{ raises: true }` is the rejection for a call that could not be
 * delivered at all — see {@link RunnerRejection} for why that one has to be raised
 * from inside the run rather than returned by the exec.
 */
export async function runPreflight(opts: {
  wt: string;
  template: string;
  testLocation?: TestLocation;
  limits?: TestRunLimits;
  throwOnRun?: (file: string) => RunnerRejection;
  /**
   * Replace the RUN call itself — the only way a case makes the run RAISE, since
   * {@link runTestFile} folds every exec rejection into a classified `Proof` and is
   * `never throws` by contract.
   */
  run?: (file: string) => Promise<Proof>;
}): Promise<{ threw?: Error; written: string[]; note?: string }> {
  const written: string[] = [];
  // The env every runner of this run gets, built ONCE. `gitTestEnv()` isolates git
  // behind an empty `HOME`, and CPython derives its *user* site-packages from
  // `$HOME`, so a real `pip install --user` pytest is unimportable in that env — see
  // `pythonUserEnv`. Building it once, and spreading that one map into both the exec
  // and the caller's `limits`, is what keeps the runner's env and the exec's fallback
  // the same answer: an env assembled twice is two chances for them to disagree.
  const runnerEnv: NodeJS.ProcessEnv = { ...gitTestEnv(), ...pythonUserEnv() };
  const exec: SpecifyDeps["exec"] = async (cmd, o) => {
    const file = o?.argv?.[o.argv.length - 1] ?? "";
    if (o?.argv !== undefined) written.push(file);
    const raised = opts.throwOnRun?.(file);
    if (raised === undefined) return execp(cmd, { ...o, env: { ...runnerEnv, ...(o?.env ?? {}) } });
    if ("raises" in raised) throw new Error(raised.message);
    // The rejection Node's executor answers for a runner that RAN and exited
    // non-zero: an Error stamped with a numeric `code`, `signal: null`, and the
    // captured streams — the shape `runTestFile` reads as a status rather than a kill.
    throw Object.assign(new Error(`Command failed: ${cmd}`), {
      code: raised.code ?? null,
      signal: null,
      killed: false,
      timedOutKill: false,
      stdout: raised.stdout ?? "",
      stderr: raised.stderr ?? "",
    });
  };
  try {
    const limits =
      opts.limits === undefined
        ? undefined
        : { ...opts.limits, env: { ...runnerEnv, ...opts.limits.env } };
    // A substituted run still records the path it was handed, so `written` answers
    // "where was the probe placed" on the throw path too — which is the half of that
    // question a removal case cannot infer from the absence it is asserting on.
    const run = opts.run;
    const runFile =
      run === undefined
        ? undefined
        : (file: string): Promise<Proof> => {
            written.push(file);
            return run(file);
          };
    const note = await assertRunnerCanRunTests(
      exec,
      {
        wt: opts.wt,
        template: opts.template,
        ...(opts.testLocation === undefined ? {} : { testLocation: opts.testLocation }),
        ...(limits === undefined ? {} : { limits }),
      },
      runFile === undefined ? {} : { runFile },
    );
    return { written, ...(note === undefined ? {} : { note }) };
  } catch (err) {
    return { threw: err as Error, written };
  }
}

/** Was a path written at all? Read after the run, so "removed" and "never there" differ. */
export function exists(wt: string, rel: string): boolean {
  return existsSync(path.join(wt, rel));
}

/**
 * Is there ANY inode at `rel`, including a dangling symlink?
 *
 * `existsSync` follows links and so answers `false` for a symlink whose target is
 * gone — which is exactly the read the write guard must not make. A case that wants
 * to know whether the step touched the NAME asks `lstat`.
 */
export function existsAnyInode(wt: string, rel: string): boolean {
  try {
    lstatSync(path.join(wt, rel));
    return true;
  } catch {
    return false;
  }
}

/**
 * What the exec seam may do instead of running the command.
 *
 * A record with a `code` is what the real executor answers for a runner that RAN and
 * exited non-zero. `{ raises: true }` is the rejection for a call that was never
 * delivered — but an exec that merely REJECTS cannot make the step's run throw, so
 * `runTestFile` swallows it into a classified `Proof`: the function is `never throws`
 * by contract and routes every rejection through `.catch`. A case that wants the run
 * itself to raise therefore passes {@link runPreflight}'s `run` seam, not this.
 */
export type RunnerRejection =
  | { stdout?: string; stderr?: string; code?: number }
  | { raises: true; message: string };

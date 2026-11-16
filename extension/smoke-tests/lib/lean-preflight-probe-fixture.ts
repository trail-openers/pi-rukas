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

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import type { TestLocation } from "../../src/lean/config-test-location.ts";
import type { TestRunLimits } from "../../src/lean/specify-proof.ts";
import { assertRunnerCanRunTests } from "../../src/lean/specify-preflight.ts";
import type { SpecifyDeps } from "../../src/lean/specify.ts";
import { gitTestEnv } from "./git-test-env.ts";
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
 */
export async function runPreflight(opts: {
  wt: string;
  template: string;
  testLocation?: TestLocation;
  limits?: TestRunLimits;
}): Promise<{ threw?: Error; written: string[]; note?: string }> {
  const written: string[] = [];
  const exec: SpecifyDeps["exec"] = async (cmd, o) => {
    if (o?.argv !== undefined) written.push(o.argv[o.argv.length - 1] ?? "");
    return execp(cmd, { ...o, env: { ...gitTestEnv(), ...(o?.env ?? {}) } });
  };
  // The env every runner of this run gets: git's isolated view, plus the one entry a
  // real interpreter needs to find the user site-packages the operator installed
  // (see `pythonUserEnv`) — the isolated `HOME` `gitTestEnv()` installs is exactly
  // what makes `import pytest` fail for a `pip install --user` pytest, and a case
  // that passes no `limits` must not have to know that. A case's own `limits.env`
  // overrides it, and the runner is not a git call, so git isolation stays intact.
  const runnerEnv: NodeJS.ProcessEnv = { ...gitTestEnv(), ...pythonUserEnv() };
  try {
    const limits =
      opts.limits === undefined
        ? undefined
        : { ...opts.limits, env: { ...runnerEnv, ...opts.limits.env, ...pythonUserEnv() } };
    const note = await assertRunnerCanRunTests(exec, {
      wt: opts.wt,
      template: opts.template,
      ...(opts.testLocation === undefined ? {} : { testLocation: opts.testLocation }),
      ...(limits === undefined ? {} : { limits }),
    });
    return { written, ...(note === undefined ? {} : { note }) };
  } catch (err) {
    return { threw: err as Error, written };
  }
}

/** Was a path written at all? Read after the run, so "removed" and "never there" differ. */
export function exists(wt: string, rel: string): boolean {
  return existsSync(path.join(wt, rel));
}

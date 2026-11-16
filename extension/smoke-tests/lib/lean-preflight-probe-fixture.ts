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
  try {
    const note = await assertRunnerCanRunTests(exec, {
      wt: opts.wt,
      template: opts.template,
      ...(opts.testLocation === undefined ? {} : { testLocation: opts.testLocation }),
      ...(opts.limits === undefined ? {} : { limits: opts.limits }),
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

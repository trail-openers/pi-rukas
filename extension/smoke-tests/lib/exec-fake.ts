/**
 * #1283 — the executor a smoke test hands to driver code (`verifyExecFn`,
 * the `execFn` a driver helper takes) when the test wants REAL git.
 *
 * Every production executor honours the argv form (#1279) —
 * `execFn("git", { cwd, argv: [...] })`. A test fake that runs `cmd` through
 * `sh -c` and ignores `argv` turns such a call into a bare `git`: usage on
 * stdout, exit 1. The driver then takes its failure path, and the test
 * passes while exercising something other than what it claims.
 *
 * `realExec` IS the real production executor (src/exec.ts `execp`), re-exported
 * for tests so a test cannot drift from the contract it stands in for: argv
 * form via execFile, string form via the shell. The one addition is rejection
 * normalisation: a spawn failure (ENOENT) carries no `stdout`/`stderr` from
 * execFile, so every rejection here carries string `stdout` and `stderr`, and
 * the stderr text is in its message. Typed against the driver's executor seam
 * (`DriverContext["verifyExecFn"]`); the ExecFn check below pins it to the
 * worktree.ts seam too.
 *
 * A fake that scripts some commands and forwards the rest should match on
 * `commandOf(cmd, opts)` (lib/argv-shell.ts) and forward `opts` unchanged.
 * `test-exec-argv-fakes.ts` fails if a test hands on a shell-only one.
 *
 * Shell strings run via `sh -c` (promisify(exec), non-login). Do NOT switch
 * the test executor to a login shell (`-l`): a login shell sources profile
 * files that may `cd`, so a smoke test would silently run git somewhere else.
 *
 * `opts.shell` names the interpreter for the string form and is NOT forwarded
 * to `execFile`: with `shell` set in its options `execFile` joins its argv
 * into ONE string for that shell, so `execFileP("/bin/sh", ["-c", cmd], { shell })`
 * runs `sh -c git` and git gets no subcommand — usage on stdout, exit 1
 * (#1981). The `argv` form has no shell, so `shell` is dropped there too:
 * forwarding it to an argv `execFile` would hand the same defect to a caller
 * that passes both.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { execp } from "../../src/exec.ts";
import type { ExecOpts } from "../../src/exec.ts";
import type { DriverContext } from "../../src/work-driver-context.ts";
import type { ExecFn } from "../../src/worktree.ts";
import { gitTestEnv } from "./git-test-env.ts";

const execFileP = promisify(execFile);

type VerifyExec = NonNullable<DriverContext["verifyExecFn"]>;

export const realExec: VerifyExec = async (cmd, opts) => {
  try {
    // 8 MiB default: the helpers this replaces ran with that buffer, so a caller
    // that omits maxBuffer keeps the same ceiling instead of execp's 1 MiB.
    //
    // The env is the fixture's scrubbed git view (#1981), under the caller's
    // own keys: this executor re-export IS the production `execp`, and a test
    // that hands it to driver code has no env option of its own to thread, so
    // this is the only place the scrub can go. Without it an inherited `GIT_DIR`
    // retargets every git child here ahead of `cwd` and git exits 0 doing it.
    const env = opts?.env ? { ...gitTestEnv(), ...opts.env } : gitTestEnv();
    if (opts?.killGroup) {
      const groupOpts: ExecOpts = { maxBuffer: 8 * 1024 * 1024, ...opts, env };
      return await execp(cmd, groupOpts);
    }
    // `shell` is this executor's own routing choice, never an execFile option:
    // stripped here so neither branch below can hand it to execFile.
    const { shell, ...fileOpts } = opts ?? {};
    // Both branches run git for real, so both name the scrub in their own text:
    // `test-verify-loop-git-env.ts` credits only a call whose options it can
    // read, and a program name passed as a variable (`execp(cmd, opts)`) hides
    // the whole call from it — which is how an unscrubbed executor survived the
    // first version of this gate.
    const maxBuffer = 8 * 1024 * 1024;
    return opts?.argv
      ? await execFileP(cmd, opts.argv, { maxBuffer, ...fileOpts, env })
      : await execFileP(shell ?? "/bin/sh", ["-c", cmd], { maxBuffer, ...fileOpts, env });
  } catch (e) {
    // A non-Error rejection (a string, a plain object) cannot carry stdout/stderr
    // properties — wrap it so the assignments below cannot throw a TypeError.
    const err: Error & { stdout?: unknown; stderr?: unknown } =
      e instanceof Error ? e : new Error(String(e));
    const stdout = typeof err.stdout === "string" ? err.stdout : "";
    const stderr = typeof err.stderr === "string" ? err.stderr : "";
    err.stdout = stdout;
    err.stderr = stderr;
    if (stderr.trim() && !err.message.includes(stderr.trim())) {
      err.message = `${err.message}\n${stderr}`;
    }
    throw err;
  }
};

// Compile-time seam check: a drift between this executor and worktree.ts's
// ExecFn fails `tsc` IF smoke-tests are type-checked. They are not: tsconfig.json
// includes src/** and scripts/** only, CI's `bunx tsc --noEmit` and biome both
// skip smoke-tests/, and bun runs these files without type-checking. Until a
// smoke-test tsconfig exists this line is documentation-only.
const _asExecFn: ExecFn = realExec;
void _asExecFn;

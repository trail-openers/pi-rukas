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
 * (`DriverContext["verifyExecFn"]`), so a signature drift fails `tsc`.
 *
 * A fake that scripts some commands and forwards the rest should match on
 * `commandOf(cmd, opts)` (lib/argv-shell.ts) and forward `opts` unchanged.
 * `test-exec-argv-fakes.ts` fails if a test hands on a shell-only one.
 *
 * Shell strings run via `sh -c` (promisify(exec), non-login). Do NOT switch
 * the test executor to a login shell (`-l`): a login shell sources profile
 * files that may `cd`, so a smoke test would silently run git somewhere else.
 */

import { execp } from "../../src/exec.ts";
import type { DriverContext } from "../../src/work-driver-context.ts";

type VerifyExec = NonNullable<DriverContext["verifyExecFn"]>;

export const realExec: VerifyExec = async (cmd, opts) => {
  try {
    return await execp(cmd, opts);
  } catch (e) {
    const err = e as Error & { stdout?: unknown; stderr?: unknown };
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

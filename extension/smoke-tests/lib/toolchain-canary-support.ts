/**
 * test-toolchain-canary-support — shared fixtures and helpers for the two
 * halves of the #1879 compiler-canary test, split out of the test file so both
 * stay under the AGENTS.md §12 file-size cap. Pure move: no behaviour here that
 * was not in the test. Nothing writes into the repo's own `node_modules` or any
 * linked tree — every stub lives in a fixture under `os.tmpdir()`.
 */

import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverExecFn } from "../../src/work-driver-context.ts";
// The executor comes FIRST: lib/exec-fake pulls in the whole driver graph, and
// a module-scope read of `LOCAL_TSC_CMD` in an importer would be a TDZ hit if
// the graph loaded first.
import { realExec } from "./exec-fake.ts";

export const pexec = promisify(execFile);
export const REPO = path.resolve(import.meta.dirname, "..", "..");

const ROOTS: string[] = [];

/** Remove every fixture made this run, on exit, pass or fail. */
export function cleanupOnExit(): void {
  process.on("exit", () => {
    for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
  });
}

/** A scratch tree root, registered for cleanup. */
export function fixtureRoot(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `pi-canary-${tag}-`));
  ROOTS.push(dir);
  return dir;
}

/** Removes one scratch tree. */
export const rmTree = (dir: string) => rmSync(dir, { recursive: true, force: true });

/** The incident's compiler: exits 0 on any input, judges nothing. */
export const STUB = "process.exit(0);\n";
/** The sound control: a real TS2322 line on stderr and exit 2. */
export const SOUND =
  "process.stderr.write(\"canary.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\\n\");\nprocess.exit(2);\n";

/**
 * A package directory whose `node_modules/typescript/bin/tsc` is `body`.
 *
 * `body` is JavaScript, not a shell script: the pinned spelling is
 * `node <path>/tsc`, so node evaluates the file — which is exactly why the
 * incident's `#!/bin/sh / sleep 9.5 / exit 0` stub worked as a compiler (a
 * shell script is a valid CommonJS program whose statements do nothing). Each
 * fixture therefore exits the way the real CLI would: `process.exit(0)` with no
 * output for the stub, a real TS2322 line on stderr and exit 2 for the control.
 */
export function packageWithCompiler(root: string, body: string, mode = 0o755): string {
  const pkg = path.join(root, "extension");
  const bin = path.join(pkg, "node_modules", "typescript", "bin");
  mkdirSync(bin, { recursive: true });
  const tsc = path.join(bin, "tsc");
  writeFileSync(tsc, body, { mode });
  chmodSync(tsc, mode);
  // The CALLER of `toolchainCanary` needs the directory the pinned relative
  // spelling resolves in — the package directory, not the repo root.
  return pkg;
}

/** An exec that records the commands it ran, forwarding everything to the real executor. */
export function recording(): { exec: DriverExecFn; ran: string[] } {
  const ran: string[] = [];
  const exec: DriverExecFn = async (cmd, opts) => {
    ran.push(opts?.argv ? [cmd, ...opts.argv].join(" ") : cmd);
    return realExec(cmd, opts);
  };
  return { exec, ran };
}

export { realExec };

/**
 * A CycleContext-shaped value for the gate seams. Typed through the ci tier's
 * own parameter so the shape cannot drift from what the gate reads.
 */
export const ctxFor = (repoRoot: string) =>
  ({ host: {}, repoRoot, issue: 1879 }) as unknown as Parameters<
    typeof import("../../src/work-driver-ci-verify.ts").runCiVerifyFull
  >[0];

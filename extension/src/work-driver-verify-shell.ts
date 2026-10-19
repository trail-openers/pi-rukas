/**
 * work-driver-verify-shell — the shell-form executor for driver-spawned shell
 * commands: the project's verify, smoke, verify-full and fast-tier commands,
 * and the ci step's verify-full. This is the ONE place the driver-knob scrub
 * (verifyChildEnv) is applied to a shell child, so every caller gets it by
 * construction. The argv form (execFile, no shell) is not here and is never
 * scrubbed. The killGroup form (net git, the checkpoint typecheck) is scrubbed
 * inline in work-driver-verify.ts's execp.
 */

import { type ExecTreeOpts, execTree } from "./exec-tree.ts";
import { verifyChildEnv } from "./work-driver-verify-cmd.ts";

export function shellExecp(
  cmd: string,
  opts?: ExecTreeOpts,
): Promise<{ stdout: string; stderr: string }> {
  return execTree(cmd, { ...opts, env: verifyChildEnv(opts?.env) });
}

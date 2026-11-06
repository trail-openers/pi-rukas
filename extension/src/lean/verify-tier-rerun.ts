/**
 * lean/verify-tier-rerun — the tier re-run whose OUTPUT survives.
 *
 * `verify-baseline.ts` answers "did this tier's second run agree with its first?"
 * and discards what that run printed, because an exit code settles the flake
 * question. The baseline excuse needs a second fact from the same child — WHICH
 * tests it named — and re-spawning the tier a third time to ask would bill the run
 * another full tier for a stream this step already had. So the spawn and the
 * judgement live here, one child call, and the colour rule itself stays in
 * `verify-baseline.ts` so a kill cannot mean two different things in one pipeline.
 */

import { verifyChildEnv } from "../work-driver-verify-cmd.ts";
import type { VerifyExec } from "./verify-types.ts";

/**
 * The same tier command, run once more in the same tree, WITH its output.
 *
 * `confirmTierRed` answers the flake question and throws its stream away; the
 * baseline excuse reads which tests the run named, so `verify` spawns the child
 * through here once and asks `confirmTierRedFrom` for the colour. It is the SAME
 * child call `confirmTierRed` makes — same scrubbed env, same bound, same
 * `killGroup` — so a tier this step excused was run by a real process this step
 * observed, never inferred.
 */
export async function tierRunStream(
  exec: VerifyExec,
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ ran: unknown; stream: string }> {
  const ran = await exec(cmd, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    killGroup: true,
    env: verifyChildEnv(),
  }).catch((err: unknown) => err);
  const e = ran as { stdout?: string; stderr?: string; message?: string } | undefined;
  const stream = [e?.stdout, e?.stderr, e?.message].filter((s) => typeof s === "string").join("\n");
  return { ran, stream };
}

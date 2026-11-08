/**
 * The `ci` step's full verify tier: which command, how long, and what a red means.
 *
 * Split out of `ci.ts` because the step grew a second question to answer about a
 * red tier — was every test it named already red at the base commit, or not — and
 * the two questions have different owners. This file owns running the tier and
 * turning a failed exec into either an infrastructure throw or a red reason;
 * {@link fullTierExcuse} in `ci-excuse.ts` owns the base-commit question, and
 * `ci.ts` decides which answer the step records.
 */
import type { CiDeps } from "./ci-deps.ts";
import type { WorkConfig } from "./config.ts";
import type { HandlerCtx } from "./engine.ts";
import { neverStarted, wasKilled } from "./specify-proof.ts";
import { oneLine } from "./text-fence.ts";
import { clipReason } from "./verify-deps.ts";
import { TIER_TAIL_LINES, tailLines } from "./verify-steps.ts";
import { VerifyInfraError } from "./verify-types.ts";

/**
 * The project config, read ONCE per step by `ciOutcome` and passed down.
 *
 * Three halves of this step want it — the configured full tier, the wait bound
 * and the tier's bound — and all three read it through this one call, so they
 * cannot disagree about which commit's `.pi/work.json` they obeyed.
 */
export async function ciConfig(deps: CiDeps, ctx: HandlerCtx): Promise<WorkConfig> {
  return await deps.loadConfig(ctx.repoRoot, ctx.run.baseSha).catch((err: unknown) => {
    throw new VerifyInfraError(`could not load the project config: ${(err as Error).message}`);
  });
}

/**
 * Run the full tier in the worktree.
 *
 * `undefined` is a pass. A kill, a timeout or a command that never started is an
 * infrastructure fault — the tier never got to answer a question about the code, so
 * the run hands back rather than taking a build round. Anything else that exits
 * non-zero is a real red, returned with both the reason (what a red step records),
 * the combined stream (what the baseline excuse parses test names from) and the
 * executor's own result object (what `ciTierObserved` decides the excuse's admissibility
 * from — the stream alone cannot tell a full run from one truncated at its buffer).
 */
export async function tierFailure(
  deps: CiDeps,
  cmd: string,
  wt: string,
  timeoutMs: number,
): Promise<{ reason: string; stream: string; ran: unknown } | undefined> {
  const ran = await deps
    .exec(cmd, { cwd: wt, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, killGroup: true })
    .then((r) => ({ err: undefined as unknown, out: r }))
    .catch((err: unknown) => ({ err, out: undefined as unknown }));
  if (ran.err === undefined) return undefined;
  const e = ran.err as { code?: unknown; stdout?: string; stderr?: string; message?: string };
  const out = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
  if (wasKilled(ran.err))
    throw new VerifyInfraError(
      `the ci full tier was killed or timed out at ${timeoutMs}ms: ${cmd}`,
    );
  if (neverStarted(ran.err))
    throw new VerifyInfraError(
      `the ci full tier could not be started: ${cmd}: ${oneLine(out, 300)}`,
    );
  // The tail and the bound are `verify`'s own, not a second copy of them: the step
  // log is one JSON document and `build`'s re-entry pastes a red reason into a
  // prompt, so a tail bound alone still lets one very long line — a minified bundle
  // echoed by a failing diff — carry the whole log into the record.
  const tail = tailLines(out, TIER_TAIL_LINES);
  return {
    reason: clipReason(`the full verify tier exited ${String(e.code)}: ${cmd}\n${tail}`),
    stream: out,
    ran: ran.err,
  };
}

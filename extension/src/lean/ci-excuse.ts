/**
 * lean/ci-excuse — a red FULL tier whose failures the base commit already had.
 *
 * When `ci`'s full tier exits non-zero, this module asks whether the base commit
 * already had those failures — in a throwaway sibling checkout of the run's
 * `baseSha` — and excuses only on what that probe printed. `verify`'s recorded base
 * set is not replayed: a comparison should rest on evidence a later reader can
 * re-derive. The accepted cost is one extra full-tier run per red full tier.
 *
 * Neither half may rest on a run that observed nothing: the head side arrives
 * through {@link tierFailure}, which turns a kill, an overflow or an un-startable
 * command into an infrastructure throw, and `classifyBaseRun` is the base side's
 * equivalent guard.
 */

import { frozenFromLog } from "./build.ts";
import type { CiDeps } from "./ci-deps.ts";
import type { HandlerCtx } from "./engine.ts";
import type { PreexistingTierRecord } from "./state-outcome-maps.ts";
import { baselineExcuse } from "./verify-baseline-excuse.ts";
import {
  baselineProbeWorktreePath,
  probeTierAtBase,
  tierExitCode,
  tierObserved,
} from "./verify-baseline.ts";

/** The tier name the full tier's record is keyed by, in `ci`'s own outcome. */
export const CI_FULL_TIER = "full";

/**
 * Did `ci`'s own full-tier run observe the work, or did the harness speak?
 *
 * `tierFailure` already throws for a kill and for a command that never started; what is
 * left is an ordinary non-zero exit and — the one that does not throw on its own — an
 * output BUFFER OVERFLOW. A flooded tier really did fail, but its stream is truncated at
 * the bound, so the omitted half could hold this run's failure: the excuse is refused and
 * the red stands.
 *
 * The observation test is `verify`'s own `tierObserved`, so `ci`'s excuse cannot be
 * reached behind a shape `verify` would have refused. On top of it the run must have
 * ANSWERED with a numeric exit code — a rejection that stamped nothing is neither killed,
 * un-startable nor overflowed, and would grade the excuse on a stream nobody produced.
 */
export function ciTierObserved(ran: unknown): boolean {
  if (!tierObserved(ran)) return false;
  if (ran === null || typeof ran !== "object") return false;
  if (!("stdout" in (ran as object))) return false;
  return tierExitCode(ran) !== undefined;
}

/**
 * A red full tier excused over the base commit, or `undefined` when it is not.
 *
 * `stream` is the head side — what the full tier printed on its red run in the
 * run's worktree — and `ran` the executor's result for that same run, carrying
 * the kill / overflow / `ENOENT` stamps {@link ciTierObserved} reads. The base
 * side is always this call's own probe of `baseSha`.
 */
export async function fullTierExcuse(opts: {
  deps: CiDeps;
  ctx: HandlerCtx;
  full: string;
  wt: string;
  stream: string;
  ran: unknown;
}): Promise<PreexistingTierRecord | undefined> {
  const { deps, ctx, full, wt, stream, ran } = opts;
  // A tier that never judged the code names nothing: no record is written and no
  // green is granted on its output.
  if (!ciTierObserved(ran)) return undefined;
  const probe = await probeTierAtBase({
    repoRoot: ctx.repoRoot,
    baseSha: ctx.run.baseSha,
    issue: ctx.issue,
    cmd: full,
    timeoutMs: deps.tierTimeoutMs ?? 600_000,
    exec: deps.exec,
    frozen: frozenFromLog(ctx.steps),
  });
  const excuse = baselineExcuse({
    tierName: CI_FULL_TIER,
    cmd: full,
    baseSha: ctx.run.baseSha,
    probe,
    headStream: stream,
    baseStream: probe.stream,
    headRoot: wt,
    probeRoot: baselineProbeWorktreePath(ctx.repoRoot, ctx.issue),
  });
  return excuse.kind === "excused" ? excuse.record : undefined;
}

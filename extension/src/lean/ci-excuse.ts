/**
 * lean/ci-excuse — a red FULL tier whose failures the base commit already had.
 *
 * `ci` grades the run's mergeability on two readings: the forge's required checks
 * and the project's full tier run in the run's own worktree. When that tier exits
 * non-zero, `verify`'s own baseline excuse has usually already answered the same
 * question for a tier this run — a mainline whose suite is red on this host is red
 * for `ci` exactly as it was for `verify`. This module asks the question again for
 * `ci`'s OWN full tier, in a throwaway sibling checkout of the run's `baseSha`, and
 * excuses only on what that probe printed — there is no reuse of `verify`'s recorded
 * base set. Replaying names a later reader cannot re-derive from a run is how a
 * comparison gets graded on evidence nobody can check. The accepted cost is one extra
 * full-tier run per red full tier.
 *
 * And neither half of the comparison may rest on a run that observed nothing: the
 * head side arrives through {@link tierFailure}, which turns a kill, an overflow or
 * an un-startable command into an infrastructure throw, so by the time this module
 * sees a stream the tier really ran. `classifyBaseRun` is the base side's equivalent
 * guard and is what `verify`'s own excuse is reached through.
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
 * `tierFailure` throws for a kill and for a command that never started, so the
 * shapes that reach here are an ordinary non-zero exit and — the one that does not
 * throw on its own — an output BUFFER OVERFLOW: `exec` stamps `overflow` beside the
 * captured streams and `ci` treats it as a red with a tail, because a tier that
 * flooded its buffer really did fail. It is NOT evidence about WHICH tests failed:
 * the stream is truncated at the bound, so the names it printed before the cut are
 * all the excuse would get to read, and the omitted half can hold the failure this
 * run authored. So the excuse is refused and today's red stands.
 *
 * The observation test is `verify`'s own `tierObserved` — the same predicate that
 * gates `verify`'s excuse, so `ci`'s cannot be reached behind a shape `verify` would
 * have refused. On top of it a run must have ANSWERED with a numeric exit code: a
 * rejection that stamped nothing at all (`new Error("boom")`, `{}`) is neither killed
 * nor un-startable nor overflowed, and reading it as observed would grade the excuse on
 * a stream nobody produced. `verify`'s `confirmTierRedFrom` requires the same numeric
 * code — and the same absence of an object means the same thing there, because an
 * executor that resolves with no result object at all is the fixture's "exited 0 with no
 * output" and stays admissible.
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
 * `stream` is what the full tier printed on its red run in the run's worktree —
 * the head side of the comparison, which `ci` already has in hand. `ran` is the
 * executor's result object for that same run, which carries the kill / overflow /
 * `ENOENT` stamps {@link ciTierObserved} reads. The base side is always this call's
 * own probe: `ci` re-probes `baseSha` rather than replaying `verify`'s record.
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

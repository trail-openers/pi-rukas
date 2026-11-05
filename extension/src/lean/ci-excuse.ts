/**
 * lean/ci-excuse — a red FULL tier whose failures the base commit already had.
 *
 * `ci` grades the run's mergeability on two readings: the forge's required checks
 * and the project's full tier run in the run's own worktree. When that tier exits
 * non-zero, `verify`'s own baseline excuse has usually already answered the same
 * question for a tier this run — a mainline whose suite is red on this host is red
 * for `ci` exactly as it was for `verify`. This module decides whether `ci` may
 * reuse that answer, and asks the base itself when it cannot.
 *
 * Reuse is narrow on purpose, because the record is a claim that licenses a GREEN:
 *
 *   - the command `ci` is about to run must be BYTE-IDENTICAL to the recorded one —
 *     a tier that differs by a flag is a different gate, and its names say nothing
 *     about this one's;
 *   - the record comes from the NEWEST DECIDED `verify` and only that one, and that
 *     verify must be green with `verifiedHead` equal to the head `ci` judges;
 *   - the comparison still runs: every name `ci`'s own head run printed must match
 *     a name the recorded base set carries, through the same reader a fresh probe
 *     would have used. A record whose base set was too large to persist is treated
 *     as no record at all — a partial base set would let `ci` excuse a failure it
 *     never saw at base.
 *
 * Everything else — including every `ci` fix round, which is the case that needs
 * reuse most and earns it least, because the machine puts a fresh `verify` between
 * the two — probes the run's `baseSha` in the throwaway sibling checkout, the way
 * `verify` does, and pays one extra full-tier run for it.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { frozenFromLog } from "./build.ts";
import type { CiDeps } from "./ci-deps.ts";
import type { HandlerCtx } from "./engine.ts";
import type { PreexistingTierRecord } from "./state-outcome-maps.ts";
import { newestDecided } from "./state.ts";
import { baseStreamOf, baselineExcuse } from "./verify-baseline-excuse.ts";
import { baselineProbeWorktreePath, probeTierAtBase } from "./verify-baseline.ts";

/** The tier name the full tier's record is keyed by, in `ci`'s own outcome. */
export const CI_FULL_TIER = "full";

/**
 * A red full tier excused over the base commit, or `undefined` when it is not.
 *
 * `stream` is what the full tier printed on its red run in the run's worktree —
 * the head side of the comparison, which `ci` already has in hand.
 */
export async function fullTierExcuse(opts: {
  deps: CiDeps;
  ctx: HandlerCtx;
  full: string;
  verified: string;
  wt: string;
  stream: string;
}): Promise<PreexistingTierRecord | undefined> {
  const { deps, ctx, full, verified, wt, stream } = opts;
  const reuse = reusableRecord(ctx, full, verified);
  if (reuse !== undefined) {
    const excuse = baselineExcuse({
      tierName: CI_FULL_TIER,
      cmd: full,
      baseSha: reuse.baseSha,
      probe: { status: "red" },
      headStream: stream,
      baseStream: baseStreamOf(reuse.baseNames ?? []),
      headRoot: wt,
      probeRoot: baselineProbeWorktreePath(ctx.repoRoot, ctx.issue),
    });
    return excuse.kind === "excused" ? excuse.record : undefined;
  }
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

/**
 * The newest decided verify's record for this exact command, or `undefined`.
 *
 * Three facts, all required: green, `verifiedHead` equal to the head `ci` judges,
 * and a `cmd` byte-equal to the one `ci` runs. A record that omits `baseNames` —
 * because the base set was larger than the persist bound — is no evidence either.
 */
function reusableRecord(
  ctx: HandlerCtx,
  full: string,
  verified: string,
): PreexistingTierRecord | undefined {
  const v = newestDecided(ctx.steps, "verify");
  const oc = v?.outcome;
  if (oc?.kind !== "green") return undefined;
  if (!isFullCommitSha(oc.verifiedHead ?? "") || oc.verifiedHead !== verified) return undefined;
  const recorded = oc.preexistingFailures?.[CI_FULL_TIER];
  if (recorded === undefined || recorded.cmd !== full) return undefined;
  return recorded.baseNames === undefined ? undefined : recorded;
}

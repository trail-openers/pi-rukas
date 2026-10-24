/**
 * work-driver-verify-base-health-run — the arms a base probe can reach, and the
 * record each one produces.
 *
 * Extracted from `work-driver-verify-base-health.ts` (AGENTS.md §12 file-size cap).
 * It is the half of the probe that judges a run; the module it came from keeps the
 * half that decides whether to run at all (switches, keys, the cache read, and the
 * single-flight registration). Splitting there keeps each rule in one place: the
 * arm rules are the ones an operator's handoff quotes, and the dispatch rules are
 * the ones a cycle's wall clock depends on.
 *
 * Two invariants the arms carry, both of which a caller cannot enforce afterwards:
 * a RED is never cached (each cycle re-probes, so one flaky red cannot speak for
 * cycles it never ran in) and a GREEN that could not be WRITTEN is no verdict at
 * all (the file is the evidence a later cycle reads instead of paying for the
 * suite — see `test-verify-baseline-attribution.ts` case 17).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { CycleContext, DriverExecFn } from "./work-driver-context.ts";
import { writeBaseHealthCache } from "./work-driver-verify-base-health.ts";
import {
  type BaseHealthRedEvidence,
  baseHealthRedEvidence,
} from "./work-driver-verify-base-park.ts";
import { isRedBaseline, probeBaselineVerify } from "./work-driver-verify-baseline.ts";
import { verifyChildEnv } from "./work-driver-verify-cmd.ts";
import type { BaseHealthKey, BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";

/** What the probe did, as its callers report it. */
export interface BaseHealthProbeOutcome {
  /** Nothing ran (no command, a switch off, an unreadable base). */
  ran: boolean;
  verdict?: BaseHealthVerdict;
  /** Wall clock of the probe's own run, when it ran one. */
  ms?: number;
  /**
   * Set only on an established RED: the arm the probe itself earned, rendered.
   * Nothing parks on it at the branch step any more — the develop gate attributes
   * a red base as `verify-baseline-red:develop` — so it travels as evidence, and
   * nothing else can attribute a base to a run the probe did not perform.
   */
  red?: BaseHealthRedEvidence;
  /** A note for the operator: why nothing ran, or why the cache answered. */
  notes: string[];
}

/**
 * The one `unknown` the probe raises when it never got an answer from the gate:
 * the verdict that records the attempt, and the note that says so. Never a park —
 * a probe that could not run has established nothing, and the whole cost model of
 * this seam rests on that being cheap.
 *
 * MODULE-PRIVATE (#1809 fix round): an `unknown` is only honest when the arm that
 * reached no verdict produced it. Exported, it invited any caller to synthesize a
 * verdict the probe never judged.
 */
function unknownProbeOutcome(
  baseSha: string,
  cmd: string,
  tierBoundMs: number,
  why: string,
): BaseHealthProbeOutcome {
  const reason = `probe could not run (${why})`;
  return {
    ran: false,
    verdict: { status: "unknown", baseSha, command: cmd, tierBoundMs, reason },
    notes: [`base-health: ${reason}; the cycle proceeds`],
  };
}

/** The outcome a probe that never reached a gate reports. */
export function skippedProbeOutcome(note: string): BaseHealthProbeOutcome {
  return { ran: false, notes: [`base-health: ${note}`] };
}

/**
 * Pay for the suite run at the base commit and report the arm it reached.
 *
 * The run is deliberately NOT tied to the cycle's abort signal: it runs to
 * completion or to its bound, because a GREEN is a fact about the base commit that
 * a later cycle reuses — abandoning it because this cycle is on its way out throws
 * away a verdict the repo still wants. Process exit ends it.
 */
export async function runBaseHealthProbe(
  execFn: DriverExecFn,
  ctx: CycleContext,
  baseSha: string,
  cmd: string,
  key: BaseHealthKey,
): Promise<BaseHealthProbeOutcome> {
  trace(
    `work-driver: base-health — probing base ${baseSha.slice(0, 12)} with \`${cmd}\` (one extra suite run, bound ${(key.tierBoundMs / 60000).toFixed(0)} min)`,
  );
  const startedAt = Date.now();
  const probe = await probeBaselineVerify(execFn, {
    repoRoot: ctx.repoRoot,
    baseSha,
    // A label the develop step's `baseline-verify-<issue>` tree can never collide
    // with: two seams sharing one throwaway checkout is how one step's teardown
    // removes the other's tree mid-run.
    issue: `branch-${ctx.issue}`,
    cmd,
    timeoutMs: key.tierBoundMs,
    env: verifyChildEnv(),
  });
  const ms = Date.now() - startedAt;
  const timedOut = probe.status === "red-timed-out";
  const verdict: BaseHealthVerdict = {
    status: isRedBaseline(probe) ? "red" : probe.status === "green" ? "green" : "unknown",
    baseSha,
    command: cmd,
    tierBoundMs: key.tierBoundMs,
    ...(probe.status === "unknown" ? { reason: probe.reason } : {}),
    // The one field that says WHICH red this is. The develop gate's reuse rebuilds
    // its arm from this record, and a killed run has no stream, no tally and no
    // assertion to reason from — see `BaseHealthVerdict.timedOut`.
    ...(timedOut ? { timedOut: true as const } : {}),
  };
  if (isRedBaseline(probe)) {
    // Deliberately NOT cached across cycles: each cycle re-probes, so one flaky red
    // cannot speak for cycles it never ran in. The verdict is handed out with the
    // evidence of its own arm — a red is the one verdict whose record the develop
    // gate must name in its handoff, and only the run this probe performed can say
    // which colour of red it was. The cache file stays untouched on this path: one
    // flaky red must not erase a green the same key earned.
    return {
      ran: true,
      ms,
      verdict,
      red: baseHealthRedEvidence(verdict, probe),
      notes: [`base-health: base ${baseSha.slice(0, 12)} is RED — the gate was already red`],
    };
  }
  if (verdict.status === "green") {
    // The cache write is the green's EVIDENCE: it is what a later cycle reads back
    // instead of paying for the suite. `writeBaseHealthCache` swallows its own fault
    // (a failed write costs a later re-probe, nothing else), but it reports whether
    // the write landed, and a green that did not land is no verdict at all.
    const recorded = await writeBaseHealthCache(
      async (file, contents) => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, contents, "utf8");
      },
      ctx.repoRoot,
      verdict,
    );
    if (!recorded) {
      return unknownProbeOutcome(
        baseSha,
        cmd,
        key.tierBoundMs,
        "the green could not be recorded — the cache file was not written",
      );
    }
    return {
      ran: true,
      ms,
      verdict,
      notes: [`base-health: base ${baseSha.slice(0, 12)} is GREEN`],
    };
  }
  return {
    ran: true,
    ms,
    verdict,
    notes: [
      `base-health: not established — ${verdict.reason ?? "the probe reached no verdict"}; the cycle proceeds`,
    ],
  };
}

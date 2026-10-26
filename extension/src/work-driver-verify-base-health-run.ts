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
import { baseRunsProse, confirmingOutcomeProse } from "./work-driver-verify-base-confirm-prose.ts";
import {
  BASE_CONFIRM_FIRST_LABEL,
  BASE_CONFIRM_SECOND_LABEL,
  baseRunInLabelledTree,
  baseRunTreePath,
  confirmRedBase,
} from "./work-driver-verify-base-confirm.ts";
import { writeBaseHealthCache } from "./work-driver-verify-base-health.ts";
import {
  type BaseHealthRedEvidence,
  baseHealthRedEvidence,
} from "./work-driver-verify-base-park.ts";
import {
  type BaselineVerdict,
  type RedBaselineVerdict,
  baselineProbeWorktreePath,
  isRedBaseline,
  probeBaselineVerify,
} from "./work-driver-verify-baseline.ts";
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
  // One base run of the project's command, on a fresh detached checkout under
  // `label`, through the helper BOTH base seams share: the first run and the #1826
  // confirmation cannot then disagree about provisioning, the scrubbed env, the
  // bound or the tree-naming rule — and the confirmation's distinct label is what
  // makes it a FRESH tree rather than the first run's, which a project gate that
  // writes into its own checkout would have inherited.
  const baseRun = baseRunInLabelledTree(execFn, {
    repoRoot: ctx.repoRoot,
    baseSha,
    cmd,
    // A namespace the develop step's `baseline-verify-<issue>` trees can never
    // collide with.
    issueLabel: `branch-${ctx.issue}`,
    env: verifyChildEnv(),
  });
  const tree = (label: string) => baseRunTreePath(ctx.repoRoot, `branch-${ctx.issue}`, label);
  const probe = await baseRun(BASE_CONFIRM_FIRST_LABEL, key.tierBoundMs);
  const firstEndedAt = Date.now();
  const firstMs = firstEndedAt - startedAt;
  // #1826 — the second run, paid for only when the first arm leaves the question
  // open. A first `red-timed-out` or `unknown` triggers NO second run and keeps
  // today's routing; a green triggers none.
  const confirmation = isRedBaseline(probe)
    ? await confirmRedBase(probe, (label, boundMs) => baseRun(label, boundMs), key.tierBoundMs, {
        firstRoot: tree(BASE_CONFIRM_FIRST_LABEL),
        secondRoot: tree(BASE_CONFIRM_SECOND_LABEL),
      })
    : undefined;
  const ms = Date.now() - startedAt;
  // The FIRST run's own wall clock, not the two runs summed, whenever a second
  // run was paid for. The consultation record carries it as "what did the probe
  // cost", and `synthesizeDriverCompletion` renders `now - startedAt` from it: after
  // a confirmation the sum would report a consultation whose probe cost twice what
  // the run it consulted cost.
  const probeMs = confirmation?.ranSecond === true ? firstMs : ms;
  const timedOut = probe.status === "red-timed-out";
  // The colour the probe's record states, and the ONLY colour it may state: a red
  // the second run did not confirm is recorded as no verdict — except the killed
  // first run, which keeps today's routing untouched. The develop gate's reuse
  // reads a colour, and a colour it reads is a colour it may claim, which is why
  // `secondRun` has to travel with every red the record states.
  const confirmed = confirmation?.confirmation === "confirmed-red";
  const secondRun = confirmation?.second?.status;
  // `reason` is the `unknown` arm's own field; every other arm has no verdict to
  // explain, which is why the reader below narrows rather than defaults.
  const firstReason = probe.status === "unknown" ? probe.reason : undefined;
  const verdict: BaseHealthVerdict = {
    status:
      probe.status === "green"
        ? "green"
        : confirmed || probe.status === "red-timed-out"
          ? "red"
          : "unknown",
    baseSha,
    command: cmd,
    tierBoundMs: key.tierBoundMs,
    ...(secondRun === undefined ? {} : { secondRun }),
    ...(firstReason === undefined ? {} : { reason: firstReason }),
    // A KILLED first run states its arm on the record, and the arm is the only
    // thing a reuse can carry no field for: `ReusableVerdict` has no `timedOut`, so
    // a reuse whose record did not say "killed" would rebuild a killed gate's
    // timeout as a plain red base and write an assertion line for a run that
    // produced no stream (#1765 lens round 1).
    ...(timedOut || confirmed || firstReason !== undefined
      ? {}
      : {
          // The reason names the CONFIRMING run's actual outcome, never a colour it
          // did not reach: green, killed at its bound, could not be read, or a run
          // that named a different test are four different facts for an operator, and
          // "the confirming run was red" about a NON-confirmed pair describes a run
          // nobody watched fail twice.
          reason: `the base failed once and ${confirmingOutcomeProse(
            confirmation ?? { confirmation: "not-confirmed", first: probe, ranSecond: false },
          )} — the base is not established red`,
        }),
    // The one field that says WHICH red this is. The develop gate's reuse rebuilds
    // its arm from this record, and a killed run has no stream, no tally and no
    // assertion to reason from — see `BaseHealthVerdict.timedOut`.
    ...(timedOut ? { timedOut: true as const } : {}),
  };
  // A FIRST run killed at its bound keeps its own route, two-run rule and all.
  // `confirmRedBase` asks for no second run when the first was killed — a run that
  // judged nothing has nothing to confirm — so `confirmed` is false for it and the
  // red arm below would otherwise drop the only evidence this shape produces: the
  // `[baseline-red]` entry naming the bound. Cap precedence still routes it as
  // `verify-timeout:<step>`, which is the actionable diagnosis (#1404), and a
  // cycle that cannot reach a verdict must not lose the sentence that says so.
  if (confirmed) {
    // Deliberately NOT cached across cycles: each cycle re-probes, so one flaky red
    // cannot speak for cycles it never ran in. The verdict is handed out with the
    // evidence of its own arms — a red is the one verdict whose record the develop
    // gate must name in its handoff, and only the runs this probe performed can say
    // which colour each of them was. The cache file stays untouched on this path:
    // one flaky red must not erase a green the same key earned.
    return {
      ran: true,
      ms: probeMs,
      verdict,
      red: baseHealthRedEvidence(verdict, probe as RedBaselineVerdict, confirmation),
      notes: [
        // This arm is reached only with a CONFIRMED red, so the sentence has one
        // shape: the older form carried a "killed at its bound" alternative that
        // this branch can never take, and a dead clause in an operator's line reads
        // as a possibility that exists.
        `base-health: base ${baseSha.slice(0, 12)} is RED — the gate was already red, red on both base runs`,
        // A killed first run has no second run to name — `confirmRedBase` asked for
        // none — so the prose is built from the one arm that exists rather than
        // from a confirmation that never happened.
        `base-health: ${baseRunsProse(confirmation ?? { confirmation: "not-confirmed", first: probe, ranSecond: false })}`,
      ],
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
      // The same rule as the red arm: the run the consultation consulted, not the
      // total the probe spent getting there (a green never pays for a second run).
      ms: probeMs,
      verdict,
      notes: [`base-health: base ${baseSha.slice(0, 12)} is GREEN`],
    };
  }
  return {
    ran: true,
    ms: probeMs,
    verdict,
    // #1826 — a first run KILLED at its bound keeps the evidence today's route
    // produced for it: the finding is the timeout's own sentence, which is the
    // operator's actionable line for this shape ("the gate cannot finish on a clean
    // checkout of the base whatever the diff contains"), and cap precedence routes it
    // as `verify-timeout:<step>` (#1404), never as a base claim. It carries no
    // two-run prose because there was no second run: `confirmRedBase` asked for none,
    // and a run that judged nothing has nothing to confirm.
    ...(timedOut ? { red: baseHealthRedEvidence(verdict, probe as RedBaselineVerdict) } : {}),
    notes: [
      `base-health: not established — ${verdict.reason ?? "the probe reached no verdict"}; the cycle proceeds`,
      // #1826 — the flaky base is recorded where the operator can read it: the
      // consultation note the develop gate writes for this verdict names both
      // runs, so "red once, green once" survives the probe's own scope. A killed
      // FIRST run is excluded because it had no second run at all, and a confirmed
      // red never reaches this arm.
      ...(confirmation === undefined ||
      confirmation.second === undefined ||
      confirmation.confirmation === "confirmed-red" ||
      timedOut
        ? []
        : [`base-health: ${baseRunsProse(confirmation)}`]),
    ],
  };
}

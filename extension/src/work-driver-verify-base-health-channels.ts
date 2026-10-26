/**
 * work-driver-verify-base-health-channels — the ONE shape the background
 * base-health probe has to the develop gate, declared once and reused at every
 * layer (aggregate → verify-cmd → develop → pr17 → the driver's recorder).
 *
 * The branch step registers the probe and returns; the probe writes no state (a
 * concurrent state write would race the develop step), so the gate's reads
 * travel out as callbacks.
 *
 * Why one shape and not two callbacks with two signatures each (#1809 fix round).
 * The two halves arrived as two positional parameters that each layer re-declared
 * in its own words, and every receiver in the chain had to decide for itself what
 * `undefined` meant. It means "this channel said nothing", and the receivers that
 * read it that way kept the other half; the one that did not (`verifyStepOutcome`)
 * erased a whole consultation by assigning both halves unconditionally. A report
 * whose halves are OPTIONAL PROPERTIES cannot be erased that way: assigning a
 * half only when it is present is the only well-typed thing to do with it.
 */
import type { BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";

/**
 * What one consultation read: the verdict and the probe run it came from (which
 * carries that run's measured wall clock and whether it executed a suite of its
 * own). Declared here, beside the report that carries it, because the two are one
 * decision made in one place — `aggregateVerifyOutcome` consults the registry once
 * and reports both halves of what it saw.
 */
export interface BaseHealthConsulted {
  status: "green" | "red";
  /** The base the verdict speaks for, so a reader can name it. */
  baseSha: string;
  /** The probe's measured run time; absent when it ran nothing (a cache answer). */
  ms?: number;
  /** The red came from the timed-out arm — the operator must not be told to fix a test. */
  timedOut?: true;
  /**
   * #1826 — the SECOND base run's colour, when the probe paid for one. The
   * operator-visible half of the flaky-base record: a red whose confirmation came
   * back green is not a red base, and the consultation event is the one place a
   * later reader learns the base was red once and green once rather than red twice.
   */
  secondRun?: "green" | "red" | "red-timed-out" | "unknown";
}

/**
 * What one consultation produced, in one object: the verdict the gate read (only
 * a GREEN travels here — `pipelineState.baseHealthProbe` survives a develop round
 * and a RED is never cached across rounds) and the record of the consultation
 * itself (colour + the probe's own measured ms), which is the operator-visible
 * `driver:base-health` event.
 *
 * Both members are optional and BOTH may be present at once: a green consultation
 * reports its verdict and its record together, a red reports only its record.
 * "Absent" is a property, never a positional `undefined`, so no receiver can
 * mistake it for "forget the other half".
 */
export interface BaseHealthReport {
  /**
   * The verdict this gate collected from the BACKGROUND base probe (see
   * `aggregateVerifyOutcome`): absent when nothing was running for this cycle's
   * key, and never present for a RED. The develop gate is the only writer of
   * `pipelineState.baseHealthProbe`, and only when it needed the verdict.
   */
  collected?: BaseHealthVerdict;
  /** The consultation itself — colour and the probe's measured ms. */
  consulted?: BaseHealthConsulted;
}

/** The single channel every layer of the develop gate carries. */
export interface VerifyCommandGateBaseHealth {
  onBaseHealth?: (report: BaseHealthReport) => void;
}

/**
 * Fold a report into the accumulator a receiver keeps across calls, the way every
 * layer in the chain must: a half is taken ONLY when the report carries it, so two
 * calls that each deliver one half leave both and a later call can never erase an
 * earlier one. `undefined` meaning "not this channel" was the rule the one-by-one
 * signatures invited each layer to interpret differently; this is that rule as
 * code, in the one place that owns the shape. `test-verify-base-health-channels.ts`
 * proves the fold keeps both halves when they arrive separately.
 */
export function mergeBaseHealthReport(
  into: BaseHealthReport,
  report: BaseHealthReport,
): BaseHealthReport {
  return {
    ...(into.collected !== undefined || report.collected !== undefined
      ? { collected: report.collected ?? into.collected }
      : {}),
    ...(into.consulted !== undefined || report.consulted !== undefined
      ? { consulted: report.consulted ?? into.consulted }
      : {}),
  };
}

/** The operator's note for a consulted verdict, as the develop gate records it. */
export function baseHealthConsultedNote(baseSha: string, report: BaseHealthConsulted): string {
  const timing =
    report.ms === undefined ? "no suite run of its own" : `its own run measured ${report.ms} ms`;
  const colour =
    report.timedOut === true
      ? `${report.status.toUpperCase()} (probe timed out)`
      : report.status.toUpperCase();
  // #1826 — a RED is only a red base when a SECOND run agrees with it, so the note
  // says how many runs the colour rests on. The second run's colour has ONE carrier:
  // the record. It used to arrive a second time as a positional argument the renderer
  // preferred over the record, which is exactly how a note comes to disagree with the
  // event it annotates — two accounts of one consultation, no error, no check.
  const second = report.secondRun;
  const runs =
    second === undefined
      ? report.status === "red"
        ? " — one base run, not confirmed red"
        : ""
      : ` — base run 2 ${second.toUpperCase()}${second === "green" ? " (FLAKY base: red once, green once)" : ""}`;
  return `base-health: the develop gate consulted the background probe — base ${(baseSha || report.baseSha).slice(0, 12)} ${colour} (${timing})${runs}`;
}

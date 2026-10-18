/**
 * plan-driver-halt — the one builder for the pipeline's early-return halts.
 *
 * Five deterministic halts share this shape (needs-clarification,
 * skipped-all-angles-failed, duplicate-risk, draft-invalid,
 * body-too-large): nothing filed, zero gaps, a spec text that explains and
 * names the remedy, and a DISCRIMINATED FilingFailure the renderer turns
 * into the NOT-FILEABLE head + FILING STATUS block (on dryRun too — the
 * #647 rule). One builder so a field added to the halt shape cannot be
 * forgotten at four of five sites. Split from plan-driver.ts along the
 * 500-line seam (AGENTS.md §12).
 *
 * #1043: `buildPlanResult` is the ONE PlanResult builder. The pipeline's final
 * return, the verbatim filing and the in-progress refusal all go through it, so
 * a field added to PlanResult cannot be set on one path and forgotten on another.
 * The normalisation (empty arrays and false flags become absent) lives here too.
 */
import type { AngleFindings } from "./plan-draft.ts";
import type { FilingFailure } from "./plan-filing.ts";
import type { GapGateLoopCapReason } from "./plan-gaps.ts";
import { PLAN_REPORTER_PATH } from "./plan-investigate.ts";
import {
  type PlanGap,
  type PlanPhaseTiming,
  type PlanResult,
  type PlanType,
  planTitle,
} from "./plan-types.ts";
import { reporterMissingError } from "./reporter-preflight.ts";
import { trace } from "./trace.ts";

/** Every field a PlanResult can carry. Callers pass what they know; the builder normalises. */
export interface PlanResultFields {
  type: PlanType;
  title: string;
  spec: string;
  gaps: PlanGap[];
  priorContext: { source: string; fact: string }[];
  issueUrl?: string;
  /** #1377: the filed issue's number, when the forge response carried one. */
  issueNumber?: number;
  filingFailure?: FilingFailure;
  timings: PlanPhaseTiming[];
  capHit?: boolean;
  capReason?: GapGateLoopCapReason;
  residualForDisclosure?: PlanGap[];
  failedAngles?: { name: string; detail: string }[];
  compacted?: boolean;
  /**
   * #1383: the durable file holding the FULL dropped-items list when the
   * bounded `## Dropped investigation items` section omitted part of it, so the
   * omission line and the tool result name bytes that exist rather than the run
   * transcripts (`/runs` truncates tool args and prune after 5 days). Absent
   * when nothing was omitted or the write failed — the body then states counts
   * and bounds and promises no location.
   */
  droppedListFile?: string;
  reviewedDigest?: string;
  investigationReused?: { ageMs: number };
  filedFromDryRun?: { ageMs: number };
  reviewedSpecChanged?: { reason: string };
}

/**
 * Per-phase wall-clock record for one pipeline run (PlanResult.timings). Split
 * out of plan-driver.ts along the 500-line seam (AGENTS.md §12).
 */
export function phaseTimer() {
  const timings: PlanPhaseTiming[] = [];
  const pipelineStart = Date.now();
  const timed = async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      timings.push({ phase, ms: Date.now() - t0 });
    }
  };
  const finishTimings = (): PlanPhaseTiming[] => {
    const total = { phase: "total", ms: Date.now() - pipelineStart } as const;
    return [...timings, total];
  };
  return { timed, finishTimings };
}

export function buildPlanResult(f: PlanResultFields): PlanResult {
  return {
    type: f.type,
    title: f.title,
    spec: f.spec,
    gaps: f.gaps,
    priorContext: f.priorContext,
    filed: !!f.issueUrl,
    issueUrl: f.issueUrl,
    issueNumber: f.issueNumber,
    capHit: f.capHit || undefined,
    capReason: f.capReason,
    residualForDisclosure: f.residualForDisclosure?.length ? f.residualForDisclosure : undefined,
    filingFailure: f.filingFailure,
    failedAngles: f.failedAngles?.length ? f.failedAngles : undefined,
    compacted: f.compacted || undefined,
    droppedListFile: f.droppedListFile,
    reviewedDigest: f.reviewedDigest,
    investigationReused: f.investigationReused,
    filedFromDryRun: f.filedFromDryRun,
    reviewedSpecChanged: f.reviewedSpecChanged,
    timings: f.timings,
  };
}

/** An early-return halt: nothing filed, zero gaps, the filing failure says why. */
export function haltResult(args: {
  type: PlanType;
  title: string;
  /** The operator-visible explanation (rendered as the SPEC section). */
  spec: string;
  priorContext: { source: string; fact: string }[];
  failure: FilingFailure;
  timings: PlanPhaseTiming[];
  capHit?: boolean;
  /**
   * The gap-gate routing reason a halt carries (the corrective re-draft's halt
   * is the only one today). Optional and forwarded verbatim: the loop's own
   * cap reasons are set by the driver post-loop, so this is only for a halt
   * that STOPS the gate — and having it here means a halt cannot silently omit
   * the reason Phase 5 and the renderer both branch on.
   */
  capReason?: GapGateLoopCapReason;
  failedAngles?: { name: string; detail: string }[];
}): PlanResult {
  return buildPlanResult({
    type: args.type,
    title: args.title,
    spec: args.spec,
    gaps: [],
    priorContext: args.priorContext.slice(0, 15),
    filingFailure: args.failure,
    capHit: args.capHit,
    capReason: args.capReason,
    failedAngles: args.failedAngles,
    timings: args.timings,
  });
}

/**
 * The all-angles-failed spec text (#893). When EVERY failed angle carries
 * the named reporter-missing error, the preflight failed: nothing was
 * dispatched, so the generic "Dispatched angles … prose only /
 * schema-invalid" text would be false — render the honest preflight text
 * instead. Moved from plan-driver.ts along the 500-line seam (AGENTS.md §12);
 * the sentences are verbatim from the driver's original builder.
 */
// #893 — when EVERY failed angle carries the named reporter-missing error,
// the preflight failed: the builder renders the honest "nothing was
// dispatched" text instead of the dispatched-angles text.
export function allAnglesFailedSpec(angleNames: string, findings: AngleFindings[]): string {
  const allReporterMissing = findings.every(
    (f) => f.failure === reporterMissingError(PLAN_REPORTER_PATH),
  );
  return allReporterMissing
    ? `(spec not drafted — the plan-reporter extension is missing)\n\nNo angles were dispatched — ${reporterMissingError(PLAN_REPORTER_PATH)}.`
    : `(spec not drafted — all investigation angles returned zero structured items)\n\nDispatched angles: ${angleNames}\n\nEach angle returned either prose only (no report_plan_item tool calls) or schema-invalid calls only. This usually means the reporter extension was not loaded, or the model did not make the tool calls. Re-run start_plan_driver — the investigation children are re-dispatched; if this recurs, check the plan-reporter extension registration (PLAN_REPORTER_PATH).`;
}

// #633 aggregate all-angles-failed guard (fail-closed): if EVERY angle
// produced zero structured items, every typed section would silently fall
// back — halt before draftSpec/fileIssue with the discriminated
// `skipped-all-angles-failed` reason instead ("deliberately skipped",
// never "filing failed").
export function allAnglesFailedHalt(args: {
  type: PlanType;
  descriptor: string;
  findings: AngleFindings[];
  priorContext: { source: string; fact: string }[];
  failedAngles: { name: string; detail: string }[];
  dryRun?: boolean;
  timings: () => PlanPhaseTiming[];
}): PlanResult | undefined {
  const { type, descriptor, findings, priorContext, failedAngles, dryRun } = args;
  const withItems = findings.filter((f) => f.toolUses.length > 0).length;
  if (findings.length === 0 || withItems > 0) return undefined;
  trace(
    `plan-driver: ALL ${findings.length} angles produced zero structured items (prose-only or schema-invalid calls) — halting, no spec filed`,
  );
  const angleNames = findings.map((f) => f.name).join(", ");
  const spec = allAnglesFailedSpec(angleNames, findings);
  const title = planTitle(descriptor, type);
  trace(
    `plan-driver: type=${type} angles=${findings.length} structured=${withItems} gaps=0 filed=false dryRun=${!!dryRun} ALL-ANGLES-FAILED`,
  );
  return haltResult({
    type,
    title,
    spec,
    priorContext,
    capHit: true,
    failure: {
      reason: "skipped-all-angles-failed",
      detail: `all ${findings.length} angles produced zero structured items — filing was deliberately skipped (not a forge failure)`,
    },
    failedAngles,
    timings: args.timings(),
  });
}

/**
 * The corrective re-draft failure with its writeback DISCLOSURE: names what
 * was computed (and whether each splice landed) before the throw, so a
 * crash cannot silently lose carried gap decisions.
 */
export function correctiveRedraftError(
  computed: { description: string; resolution: string }[],
  writtenOutcomes: { applied: boolean; heading: string }[],
  e: unknown,
): Error {
  const disclosed = computed.length
    ? computed
        .map((d, i) => {
          const o = writtenOutcomes[i];
          return o
            ? o.applied
              ? `• written back to ${o.heading}: ${d.description} → ${d.resolution}`
              : `• NOT written back (open, decision owner operator): ${d.description} → ${d.resolution}`
            : `• not yet applied: ${d.description} → ${d.resolution}`;
        })
        .join("\n")
    : "(no decisions computed — the throw preceded the re-draft)";
  const err = e instanceof Error ? e : new Error(String(e));
  return new Error(
    `corrective re-draft failed AFTER computing ${computed.length} carried gap decision(s) (the writeback decisions are disclosed here so the loss is visible):\n${disclosed}\noriginal error: ${err.message}`,
    { cause: err },
  );
}

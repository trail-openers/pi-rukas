/**
 * headless/result — the JSON projection of one issue's state file (headless S4,
 * #1024). Pure: reads a WorkState, never writes. `stdout` carries exactly one
 * JSON document built from these projections.
 */

import type { WorkState } from "../workflow-state.ts";
import { exitCodeForState, lastCap, lastEvent } from "./exit-code.ts";

/** Version of the --json result schema. Bump on any change to the result shape. */
export const RESULT_SCHEMA_VERSION = 1 as const;

export interface StepTiming {
  step: string;
  startedAt: string;
  endedAt: string;
}

export interface IssueResult {
  issue: number;
  /** `not-started`: the group member had no state file (the driver never persisted one). */
  status: WorkState["pipelineState"]["status"] | "not-started";
  cap?: string;
  branch?: string;
  prNumber?: number;
  stateFile: string;
  durationMs: number;
  steps: StepTiming[];
  exitCode: number;
  /** Clarification questions (exit 11): the cap's bullet evidence, numbered q1, q2… */
  questions?: string[];
  /**
   * #1189 — present only when the runner detected a divergence between the
   * driver's in-memory terminal state and the on-disk state file. In that
   * case `exitCode` is 30 (EXIT.crash) regardless of `status`: the in-memory
   * state may be a clean terminal state (e.g. `merged`) that the on-disk
   * file contradicts — the 30 signals that the two disagree, not that the
   * driver crashed. The `state-diverged` error code is carried on the
   * top-level `HeadlessRunResult.error`, not on this result.
   */
  diverged?: boolean;
}

/** `- item` bullet lines of a cap's evidence, in order. */
function bulletsOf(evidence: string | undefined): string[] {
  if (!evidence) return [];
  return evidence
    .split("\n")
    .map((l) => l.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1])
    .filter((x): x is string => typeof x === "string" && x.length > 0);
}

/** Open questions for an exit-11 handoff, numbered q1, q2… */
export function questionsOf(state: WorkState): string[] {
  const cap = lastEvent(state, "cap-hit");
  return cap ? bulletsOf(cap.evidence).map((q, n) => `q${n + 1}: ${q}`) : [];
}

/** Project one state file into the JSON result for its issue. */
export function projectIssue(state: WorkState, stateFile: string): IssueResult {
  const log = state.eventLog;
  const first = log[0]?.at;
  const last = log[log.length - 1]?.at;
  const durationMs = typeof first === "number" && typeof last === "number" ? last - first : 0;
  const steps: StepTiming[] = [];
  const starts = log.filter((e) => e.kind === "step-started");
  starts.forEach((e, i) => {
    if (e.kind !== "step-started") return;
    const next = starts[i + 1];
    const endAt = next && next.kind === "step-started" ? next.at : (last ?? e.at);
    steps.push({
      step: e.step,
      startedAt: new Date(e.at).toISOString(),
      endedAt: new Date(endAt).toISOString(),
    });
  });
  const merged = lastEvent(state, "merged");
  const exitCode = exitCodeForState(state);
  const cap = lastCap(state);
  const result: IssueResult = {
    issue: state.issue,
    status: state.pipelineState.status,
    stateFile,
    durationMs,
    steps,
    exitCode,
  };
  if (cap !== undefined) result.cap = cap;
  if (state.pipelineState.branchName !== undefined) result.branch = state.pipelineState.branchName;
  const prNumber = merged
    ? merged.prNumber
    : (state.pipelineState.prNumber ?? state.pipelineState.existingPr?.number);
  if (prNumber !== undefined) result.prNumber = prNumber;
  if (exitCode === 11) result.questions = questionsOf(state);
  return result;
}

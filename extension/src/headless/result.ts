/**
 * headless/result — the JSON projection of one issue's state file (headless S4,
 * #1024). Pure: reads a WorkState, never writes. `stdout` carries exactly one
 * JSON document built from these projections (resultDocument).
 *
 * #1326 — the result is the host contract; the state file is not. Everything a
 * host needs to act on an outcome is projected here (typed `cap`, `failedStep`,
 * `branch`, `prUrl`, summed `usage`, `resumable`) so it never reads the state
 * file or pi-rukas source.
 */

import type { DispatchUsage } from "../types.ts";
import { resumeEnabled } from "../work-driver-resume.ts";
import type { WorkStep } from "../workflow-state-events.ts";
import type { WorkState } from "../workflow-state.ts";
import { type HeadlessCap, capStep } from "./caps.ts";
import { EXIT, exitCodeForState, lastCap, lastEvent } from "./exit-code.ts";
import { recordedPrUrl } from "./pr-url.ts";

/**
 * Version of the --json result schema. Bump on any change to the result shape.
 * v2 (#1326): top-level `schemaVersion`, `buildCommit` and `buildVersion`; per
 * issue a typed `cap`, `failedStep`, `prUrl`, `usage` and `resumable`.
 */
export const RESULT_SCHEMA_VERSION = 2 as const;

/** Token and cost totals summed over every dispatch the cycle recorded. */
export type ResultUsage = DispatchUsage & { dispatches: number };

export interface StepTiming {
  step: string;
  startedAt: string;
  endedAt: string;
}

export interface IssueResult {
  issue: number;
  /** `not-started`: the group member had no state file (the driver never persisted one). */
  status: WorkState["pipelineState"]["status"] | "not-started";
  /** The last cap hit, from the vocabulary `--capabilities` publishes (caps.ts). */
  cap?: HeadlessCap;
  /** The step the cycle stopped in, when it did not merge. */
  failedStep?: WorkStep;
  branch?: string;
  prNumber?: number;
  /** The PR's web URL, only when it is unambiguous (pr-url.ts). */
  prUrl?: string;
  /** Present whenever a state existed to sum. */
  usage?: ResultUsage;
  /**
   * Re-running `work <issue>` without `--restart` continues this cycle. False
   * on a refusal (exit 40: a live process owns the cycle) and when
   * PI_ENSEMBLE_RESUME=0.
   */
  resumable: boolean;
  /** Diagnostic path for a person. Not a host contract: do not parse the file. */
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

/** The JSON document `--json` writes to stdout. */
export interface ResultDocument {
  schemaVersion: typeof RESULT_SCHEMA_VERSION;
  /** The 40-hex commit the running build was made from, or null (build.ts). */
  buildCommit: string | null;
  /** The release version of the running build (extension/package.json). */
  buildVersion: string;
  exitCode: number;
  issues: IssueResult[];
  error?: { code: string; message: string };
}

export function resultDocument(
  run: { exitCode: number; results: IssueResult[]; error?: { code: string; message: string } },
  build: { commit: string | null; version: string },
): ResultDocument {
  const doc: ResultDocument = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    buildCommit: build.commit,
    buildVersion: build.version,
    exitCode: run.exitCode,
    issues: run.results,
  };
  if (run.error) doc.error = run.error;
  return doc;
}

/** The result for an issue that has no state to project. */
export function notStartedResult(
  issue: number,
  stateFile: string,
  exitCode: number,
  extra: Partial<IssueResult> = {},
): IssueResult {
  return {
    issue,
    status: "not-started",
    stateFile,
    durationMs: 0,
    steps: [],
    exitCode,
    resumable: false,
    ...extra,
  };
}

/** Sum the usage of every dispatch event in the log. */
export function usageOf(state: WorkState): ResultUsage {
  const total: ResultUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
    dispatches: 0,
  };
  for (const e of state.eventLog) {
    if (
      e.kind !== "dispatch-completed" &&
      e.kind !== "dispatch-failed" &&
      e.kind !== "dispatch-failed-provider"
    ) {
      continue;
    }
    total.dispatches++;
    const u = e.usage;
    if (!u) continue;
    total.input += u.input;
    total.output += u.output;
    total.cacheRead += u.cacheRead;
    total.cacheWrite += u.cacheWrite;
    total.cost += u.cost;
    total.turns += u.turns;
  }
  return total;
}

/**
 * The step a cycle that did not merge stopped in: the step a step-template cap
 * names (`verify-failed:develop`), else the last step started before the last
 * cap hit, else the last step started. The `handoff` step is the driver
 * reporting the stop, never the step that stopped.
 */
export function failedStepOf(state: WorkState): WorkStep | undefined {
  if (state.pipelineState.status === "merged") return undefined;
  const cap = lastCap(state);
  const named = cap !== undefined ? capStep(cap) : undefined;
  if (named) return named;
  const log = state.eventLog;
  let end = log.length;
  if (cap !== undefined) {
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i]?.kind === "cap-hit") {
        end = i;
        break;
      }
    }
  }
  for (let i = end - 1; i >= 0; i--) {
    const e = log[i];
    if (e?.kind === "step-started" && e.step !== "handoff") return e.step;
  }
  return undefined;
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
    usage: usageOf(state),
    // An interrupted cycle re-enters as running; a running one resumes (#382).
    resumable:
      exitCode !== EXIT.refused &&
      resumeEnabled() &&
      (state.pipelineState.status === "running" || state.pipelineState.status === "interrupted"),
  };
  if (cap !== undefined) result.cap = cap;
  const failedStep = failedStepOf(state);
  if (failedStep !== undefined) result.failedStep = failedStep;
  if (state.pipelineState.branchName !== undefined) result.branch = state.pipelineState.branchName;
  const prNumber = merged
    ? merged.prNumber
    : (state.pipelineState.prNumber ?? state.pipelineState.existingPr?.number);
  if (prNumber !== undefined) {
    result.prNumber = prNumber;
    const url = recordedPrUrl(state, prNumber);
    if (url) result.prUrl = url;
  }
  if (exitCode === 11) result.questions = questionsOf(state);
  return result;
}

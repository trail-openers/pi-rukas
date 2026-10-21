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

import type { ResourceReport } from "../resource-budget.ts";
import type { DispatchUsage } from "../types.ts";
import { causeVerdictOf } from "../work-driver-cause-class.ts";
import type { CauseVerdict } from "../work-driver-cause-class.ts";
import { causeForCycle } from "../work-driver-cause-for.ts";
import type { CauseClass } from "../work-driver-cause-table.ts";
import { handoffMarker, parseHandoffMarker } from "../work-driver-handoff-channel.ts";
import { resumeEnabled } from "../work-driver-resume.ts";
import type { WorkStep } from "../workflow-state-events.ts";
import { type WorkState, initialState } from "../workflow-state.ts";
import { type HeadlessCap, capStep } from "./caps.ts";
import { EXIT, exitCodeForState, lastCap, lastCapIndex, lastEvent } from "./exit-code.ts";
import { failedStepOf } from "./failed-step.ts";
import { type ResultFailure, failureOf } from "./failure.ts";
import { recordedPrUrl } from "./pr-url.ts";

/**
 * Version of the --json result schema. Bump on any change to the result shape.
 * v2 (#1326): top-level `schemaVersion`, `buildCommit` and `buildVersion`; per
 * issue a typed `cap`, `failedStep`, `prUrl`, `usage` and `resumable`.
 * v3 (#1327): per issue `parkReason` and `handoff` (channel, marker, body).
 * v4 (#1384): the cap `wall-clock` is renamed `lens-review-timeout` — it was
 * the lens-review fix loop's budget, and a host read it as its own cycle clock.
 * v5 (#1560): the cap `developer-timeout` is renamed `spawn-backstop` (it names
 * the 2-h spawn backstop, not a developer bound), and the per-child run bound
 * adds the template `child-timeout:<step>`.
 * Additive, no bump: top-level `resources` (#1325); per issue `failure`
 * (#1367), `usage.byRole` (#1368), `continuedPr` (#1468) and the cause fields
 * `causeClass`, `causeReason`, `causeEvidence`, `userAction` (#1675).
 */
export const RESULT_SCHEMA_VERSION = 5 as const;

/** Token and cost totals over a set of dispatches, and how many there were. */
export type UsageTotals = DispatchUsage & { dispatches: number };

/**
 * Totals over every dispatch the cycle recorded, and the same sums per dispatch
 * `role` (#1368), so the rows add up to the total.
 */
export type ResultUsage = UsageTotals & { byRole: Record<string, UsageTotals> };

export interface StepTiming {
  step: string;
  startedAt: string;
  endedAt: string;
}

/**
 * #1327 — the handoff the cycle emitted. With `channel: "host"` pi-rukas
 * posted no handoff comment and applied no label: delivering `body` is the host's job.
 */
export interface HandoffResult {
  channel: "forge" | "host";
  /** `<!-- pi-rukas:handoff issue=N cap=<cap> -->`, the first line of `body`. */
  marker: string;
  /**
   * The full handoff markdown, from the driver's own record of this cycle's
   * handoff (never re-read from `bodyFile`, which an earlier cycle may have
   * written). Absent only on a handoff recorded before #1327: `bodyError` says so.
   */
  body?: string;
  /** Present instead of `body` when the cycle recorded no body. */
  bodyError?: "not-recorded";
  /** Diagnostic path for a person, like `stateFile`. */
  bodyFile?: string;
  /** Forge channel: the comment pi-rukas posted (or an earlier identical park's). */
  commentUrl?: string;
  /** Forge channel: `needs-human-attention` was verified on the issue (and PR). */
  labelApplied: boolean;
  /**
   * #1743 — present when this park repeats one already recorded: how many
   * cycles have parked this (cap, reason, issue text), when the first did, and
   * the marker the last one published. A host uses it to tell a re-report from
   * a first report; the third identical park is REFUSED at the pre-loop guard
   * (cap `repeat-park`) rather than delivered a third time. Absent on the
   * first park of its kind. See work-driver-park-memory.ts.
   */
  repeat?: { count: number; firstAt: number; marker: string };
}

export interface IssueResult {
  issue: number;
  /** `not-started`: the group member had no state file (the driver never persisted one). */
  status: WorkState["pipelineState"]["status"] | "not-started";
  /** The last cap hit, from the vocabulary `--capabilities` publishes (caps.ts). */
  cap?: HeadlessCap;
  /** An intent park's machine reason (`underspecified`, `too-large`, …). */
  parkReason?: string;
  /** The step the cycle stopped in, when it did not merge. */
  failedStep?: WorkStep;
  /** #1367 — why the cycle stopped on `cap`, as stable fields (failure.ts). */
  failure?: ResultFailure;
  /**
   * #1675 — who can act on the stop: `issue`, `change`, `environment` or
   * `pi-rukas` (work-driver-cause-table.ts). Absent for a cycle that is not a
   * failure (awaiting merge). Independent of `failure.kind`, which is unchanged.
   */
  causeClass?: CauseClass;
  /** #1675 — one plain sentence: why the cycle stopped. */
  causeReason?: string;
  /** #1675 — bounded, redacted evidence: the failing checks, the denied command, the provider's words. */
  causeEvidence?: string[];
  /** #1675 — what the user can do; null for a pi-rukas defect (it is ours, not the user's). */
  userAction?: string | null;
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
  /** #1468 — the PR a `--continue-pr` cycle continued; `startHeadSha` is its head at the start. */
  continuedPr?: { number: number; headRefName: string; startHeadSha: string; mainlineSha: string };
  /** Present once the cycle emitted a handoff (#1327). */
  handoff?: HandoffResult;
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
  /** #1325 — the host budget and parallelism limits (added by the CLI; additive). */
  resources?: ResourceReport;
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

/**
 * #1743 — the projection of a start the repeat-park guard refused.
 *
 * The guard fires before the driver persists anything, so the state file on
 * disk still belongs to the EARLIER cycle: projecting it would hand the host
 * that cycle's cap, handoff, usage and branch as if this start had produced
 * them — and its exit code, not 40. So this refusal is projected from an empty
 * state instead: `not-started`, `cap: "repeat-park"`, the guard's own sentence
 * as the failure, and NO `handoff` field (this start delivered nothing).
 */
export function repeatParkRefusalResult(
  issue: number,
  stateFile: string,
  detail: string,
  /** Set for a group sibling: it was never evaluated, so no `repeat-park` cap. */
  opts: { notEvaluated?: boolean } = {},
): IssueResult {
  const failure: ResultFailure = { kind: "cap", message: detail };
  const result = notStartedResult(issue, stateFile, EXIT.refused, {
    ...(opts.notEvaluated ? {} : { cap: "repeat-park" as const }),
    failure,
  });
  if (!opts.notEvaluated) {
    const cause = causeVerdictOf(initialState(issue), "repeat-park", failure);
    if (cause) applyCause(result, cause);
  } else {
    // No `repeat-park` cause for a sibling: the cause table would tell the host
    // THIS issue parked twice, which nothing ever checked. It is the group's
    // problem, attributed to the issue that armed the guard — whose number the
    // failure message already names.
    result.causeClass = "issue";
    result.causeReason = detail;
    result.userAction = null;
  }
  return result;
}

const zeroUsage = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
  dispatches: 0,
});

function addUsage(t: UsageTotals, u: DispatchUsage | undefined): void {
  t.dispatches++;
  if (!u) return;
  t.input += u.input;
  t.output += u.output;
  t.cacheRead += u.cacheRead;
  t.cacheWrite += u.cacheWrite;
  t.cost += u.cost;
  t.turns += u.turns;
}

/** Sum the usage of every dispatch event in the log, in total and per role. */
export function usageOf(state: WorkState): ResultUsage {
  const total: ResultUsage = { ...zeroUsage(), byRole: {} };
  for (const e of state.eventLog) {
    if (
      e.kind !== "dispatch-completed" &&
      e.kind !== "dispatch-failed" &&
      e.kind !== "dispatch-failed-provider"
    ) {
      continue;
    }
    addUsage(total, e.usage);
    const row = total.byRole[e.role] ?? zeroUsage();
    total.byRole[e.role] = row;
    addUsage(row, e.usage);
  }
  return total;
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

/** #1675 — the cause fields, set only when the verdict has them. */
function applyCause(result: IssueResult, cause: CauseVerdict): void {
  if (cause.causeClass !== undefined) result.causeClass = cause.causeClass;
  result.causeReason = cause.causeReason;
  if (cause.causeEvidence.length > 0) result.causeEvidence = cause.causeEvidence;
  result.userAction = cause.userAction;
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
  const failure = failureOf(state, cap, failedStep);
  if (failure) result.failure = failure;
  const terminal = state.pipelineState.status;
  if (cap !== undefined || terminal === "handoff" || terminal === "aborted") {
    const cause = causeForCycle(state);
    if (cause) applyCause(result, cause);
  }
  if (state.pipelineState.branchName !== undefined) result.branch = state.pipelineState.branchName;
  const prNumber = merged
    ? merged.prNumber
    : (state.pipelineState.prNumber ?? state.pipelineState.existingPr?.number);
  if (prNumber !== undefined) {
    result.prNumber = prNumber;
    const url = recordedPrUrl(state, prNumber);
    if (url) result.prUrl = url;
  }
  const cp = state.pipelineState.continuedPr;
  if (cp) {
    result.continuedPr = {
      number: cp.number,
      headRefName: cp.headRefName,
      startHeadSha: cp.headSha,
      mainlineSha: cp.mainlineSha,
    };
  }
  if (exitCode === 11) result.questions = questionsOf(state);
  const capHit = lastEvent(state, "cap-hit");
  const parkReason = capHit?.parkReason ?? state.pipelineState.normalisedSpec?.parkReason;
  if (parkReason && cap === "intent-park") result.parkReason = parkReason;
  // #1743 — a plan park's machine reason is its verdict, and a host switching
  // on `parkReason` had only the intent park to switch on. Additive.
  if (cap === "plan-spec-mismatch" && capHit?.planVerdict) result.parkReason = capHit.planVerdict;
  const handoff = handoffOf(state, cap);
  if (handoff) result.handoff = handoff;
  return result;
}

/** The marker the body actually carries, so the two can never disagree. */
function markerOf(body: string | undefined): string | undefined {
  const m = body ? parseHandoffMarker(body) : undefined;
  return m ? handoffMarker(m.issue, m.cap) : undefined;
}

/** The last handoff the cycle emitted, with its body. */
export function handoffOf(state: WorkState, cap: string | undefined): HandoffResult | undefined {
  const e = lastEvent(state, "handoff-emitted");
  if (!e) return undefined;
  const h: HandoffResult = {
    channel: e.delivery === "host" ? "host" : "forge",
    marker: markerOf(e.body) ?? handoffMarker(state.issue, cap),
    labelApplied: e.labelApplied,
  };
  if (e.body !== undefined) h.body = e.body;
  else h.bodyError = "not-recorded";
  if (e.handoffBodyPath) h.bodyFile = e.handoffBodyPath;
  if (e.commentUrl) h.commentUrl = e.commentUrl;
  if (e.repeat)
    h.repeat = { count: e.repeat.count, firstAt: e.repeat.firstAt, marker: e.repeat.marker };
  return h;
}

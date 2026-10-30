/**
 * headless/work-lean-result — the schema-5 projection of ONE lean run
 * (#1920 slice B). Pure: reads a `LeanRun` and its exit code, never writes,
 * never shells out.
 *
 * `work-lean` used to answer a host with its own document (`subcommand`,
 * `issue`, `exitCode`, `state`, `summary`, `steps`, `prUrl`). A host that
 * drives `work` headless, one issue per container, already reads
 * `issues[]` with `status`, `cap`, `failedStep`, `failure`, `branch`, `prUrl`
 * and `usage`, and had to keep a second reader for the lean engine it was
 * supposed to be comparable against. This module is the projection that lets
 * it keep one: the same field names, the same meanings, exactly one issue.
 *
 * The one field with no counterpart in `work` is `prState`. Lean exits 10 for
 * EVERY run that reaches `publish`, because `review`, `ci` and `land` are not
 * built: exit 10 covers a green PR waiting for a merge, a draft behind
 * unverified bytes, and a run that opened nothing. `status`/`cap` alone cannot
 * tell those apart, and the issue asks for a typed answer, so `prState` is the
 * third discriminator beside them.
 *
 * Why the caps are chosen the way they are. `work`'s cap vocabulary is a closed
 * union checked against the driver's `WorkCapLiteral`, and no entry there
 * describes a lean run's cause — a lean handback is a different machine's
 * verdict, and inventing a name would put a word in the host's `switch` that
 * `--capabilities` never published. So exactly ONE published cap is used, and
 * only where it says what a lean run did: `awaiting-human-merge` for a PR that
 * publish opened READY and the run's own gate cleared. Every other cause rides
 * `failure`, whose `kind` is an OPEN list built for this (`FAILURE_KINDS`, and
 * `test-headless-failure-usage.ts` asserts the published list equals the live
 * array).
 *
 * `lens-review-timeout` is deliberately NOT used, though it is the one published
 * name that sounds like a lean budget breach. It is not: it names the classic
 * driver's six-pass review loop, whose budget a lean run never had — a lean
 * `budget` outcome is a step's own ceiling on its own child. Borrowing the name
 * to make prose legible would be a cap the run did not hit, and the typed
 * outcome (`kind === "budget"` with its `limit`) already says what happened.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { redactClip } from "../decision-log.ts";
import { specifyBranch } from "../lean/specify-tree.ts";
import { validPrUrl } from "../lean/state-outcome.ts";
import {
  type LeanRun,
  type Outcome,
  REPORT_STATES,
  type Step,
  newestDecided,
} from "../lean/state.ts";
import { budgetSentence, budgetTrio } from "../lean/step-budget.ts";
import { leanUsage } from "../lean/usage-sum.ts";
import { handoffMarker } from "../work-driver-handoff-channel.ts";
import { makeHandoffEmittedEvent } from "../work-driver-handoff-post.ts";
import { initialState } from "../workflow-state.ts";
import { type HeadlessCap, capStep } from "./caps.ts";
import { EXIT } from "./exit-code.ts";
import type { ResultFailure } from "./failure.ts";
import {
  type HandoffResult,
  type IssueResult,
  RESULT_SCHEMA_VERSION,
  type ResultUsage,
  type StepTiming,
  handoffOf,
} from "./result.ts";

/** What `work` reports for a finished PR waiting on a person (#1675's vocabulary). */
const AWAITING = "awaiting-human-merge";

/** A lean `failure.step` must be a `WorkStep`; `handback` has no counterpart. */
const LEAN_FAILURE_STEP = "handoff" as const;

/** How long one piece of the run's own prose may be on the host's document. Same
 * bound and seam as `headless/failure.ts`: redaction happens BEFORE the clip, so
 * a cut cannot leave a fragment no pattern recognises. */
const TEXT_MAX = 500;

/** The gap `leanHandoff` puts between the marker line and the reason. */
const BODY_GAP = "\n\n";

/** The run's durable record, named the way the engine names it. */
function stateFileOf(issue: number): string {
  return `.pi/lean-state/${issue}.json`;
}
/** The run's own words for why it ended, preferring the outcome's reason. */
function outcomeText(outcome: Outcome | undefined): string | undefined {
  if (outcome === undefined) return undefined;
  // `Outcome`'s two prose fields are optional strings, and the log this
  // projection reads is a `Step[]` the loader is not the only thing that hands
  // over — so both are re-checked rather than trusted.
  for (const text of [outcome.reason, outcome.message]) {
    if (typeof text === "string" && text.trim() !== "") return text.trim();
  }
  return undefined;
}

/**
 * The newest step whose outcome reports a failure of its own, or undefined —
 * child text a host prints, so its reason is bounded and redacted on exit.
 */
function newestFailureStep(steps: Step[]): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const kind = steps[i]?.outcome?.kind;
    if (kind === "error" || kind === "red" || kind === "exhausted" || kind === "refused")
      return steps[i];
  }
  return undefined;
}

/** The newest step the run WORKED on, skipping the steps that only report. */
function newestWorkStep(steps: Step[]): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step === undefined) continue;
    // The report states are the run REPORTING how it ended, never the work that
    // ended it — the same exclusion `lean/handback.ts`'s `budgetCause` makes
    // before it will blame a ceiling for a run. Read from the engine's own list
    // so a new reporting state cannot be forgotten here.
    if (REPORT_STATES.includes(step.state)) continue;
    return step;
  }
  return undefined;
}

/** The role of the newest dispatching step's last child — the child a host blames. */
function lastRole(steps: Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const rows = steps[i]?.outcome?.dispatches;
    if (rows === undefined || rows.length === 0) continue;
    return rows[rows.length - 1]?.role;
  }
  return undefined;
}

/**
 * Why the run stopped, as the host contract's stable fields.
 *
 * What the code does, step by step:
 *
 *   1. take the newest step the run WORKED on (`newestWorkStep` — `handback` and
 *      `decline` are the run reporting, not the work that ended it);
 *   2. if THAT step is a complete `budget` verdict (`limit`/`value`/`used` all
 *      present), the failure is `kind: "timeout"` with the sentence rendered from
 *      those three. A breach the run survived — a `challenge` ceiling the table
 *      carried past on its way to `verify` (#1883) — is older than the newest
 *      working step, so position, not prose, decides;
 *   3. otherwise scan the WHOLE log backwards for the newest step whose own
 *      outcome reports a failure and map it: `error` → `crashed` (a handler
 *      threw), `red` → `verify` (the run's own gate judged the code),
 *      `exhausted`/`refused` → `process` (out of rounds, or the forge refused —
 *      neither judges the code, none is transient). Its `message` is the
 *      outcome's own reason or message, or a fallback naming the state and kind;
 *   4. if no such step exists the run said nothing about failing: `undefined`.
 *
 * `step` is always `"handoff"` and `role` is the last child of the newest
 * dispatching step, both added only when they have a value: lean's states are
 * not `WorkStep`s, so the one handoff shape `work` uses is the honest answer.
 */
function leanFailure(run: LeanRun): ResultFailure | undefined {
  const steps = run.steps;
  const worked = newestWorkStep(steps);
  // The shared trio check: `limit` named and `value`/`used` numbers, or the
  // breach is a half-record and falls through to the newest real failure.
  const fired = worked === undefined ? undefined : budgetTrio(worked.outcome);
  let failure: ResultFailure;
  if (worked !== undefined && fired !== undefined) {
    failure = {
      kind: "timeout",
      message: redactClip(budgetSentence(worked.state, fired), TEXT_MAX),
    };
  } else {
    const step = newestFailureStep(steps);
    if (step === undefined) return undefined;
    const kind = step.outcome?.kind;
    const message = outcomeText(step.outcome) ?? `${step.state} step reported ${String(kind)}`;
    failure = {
      kind:
        kind === "error"
          ? // A handler threw: the engine recorded its message and handed back.
            "crashed"
          : kind === "red"
            ? // The run's own gate judged the code.
              "verify"
            : // `exhausted` / `refused`: the step ran out of rounds, or the forge
              // refused. Neither is a judge of the code and none is transient.
              "process",
      message: redactClip(message, TEXT_MAX),
    };
  }
  failure.step = LEAN_FAILURE_STEP;
  const role = lastRole(steps);
  if (role !== undefined) failure.role = role;
  return failure;
}

/**
 * The cap. `undefined` when no published cap name says what happened — the
 * cause is then on `failure` alone, which is the open list.
 *
 * A PR URL is NOT enough for `awaiting-human-merge`: a run can push a branch,
 * open a PR, and then have its own gate call the work red, and that is a park,
 * not a hold. Nor is handing back with a PR enough — publish keeps a PR it opened
 * as a DRAFT whenever its gate was not green, and a draft behind unverified bytes
 * is not work waiting on a person. It takes the typed `prState: "ready"`.
 *
 * A budget breach gets no cap. `lens-review-timeout` is the classic driver's
 * six-pass review budget, and a lean run has no such loop: its `budget` outcome is
 * one step's ceiling on one child. The breach is on `failure` with
 * `kind: "timeout"` and the typed trio, which needs no borrowed name.
 */
function leanCap(
  status: IssueResult["status"],
  prUrl: string | undefined,
  prState: IssueResult["prState"],
): HeadlessCap | undefined {
  if (prUrl !== undefined && status === "handoff" && prState === "ready") return AWAITING;
  return undefined;
}

/**
 * The terminal status, from the state the run reached and the code it stamped.
 *
 * `landed` is the only success and `not-ready` is the one verdict that says the
 * ISSUE was refused (an issue-text fault is `causeClass: "issue"` in `work`'s
 * vocabulary, not a change fault). A run that reached no terminal state and
 * still reported a code is the shape a future `--timeout` produces (#1920 item
 * 2): no new step started, a result handed back — the same answer `work` gives a
 * cycle its deadline cut off, which is `interrupted`.
 */
function leanStatus(run: LeanRun, code: number): IssueResult["status"] {
  if (run.state === "landed") return "merged";
  if (run.state === "not-ready") return "aborted";
  if (run.state === "handed-back") return "handoff";
  return code === EXIT.merged ? "running" : "interrupted";
}

/**
 * The newest DECIDED `publish` step's URL, if the run got that far.
 *
 * `newestDecided` is the log's own rule (an outcome-less step is a crash
 * mid-step and has said nothing), so a newer `publish` that decided without a
 * URL reports no URL — reading one from an earlier publish would hand the host
 * the address of a PR this run replaced. The value is then re-checked with the
 * load-time rule `handback` applies rather than trusted: the log this projection
 * reads is a `Step[]`, and the loader is not the only thing that hands one over.
 * A URL that breaks the shape is not a link a host should open, and it is not a
 * PR either — which is why `prState` asks THIS function, not the raw field.
 */
function prUrlOf(steps: Step[]): string | undefined {
  return validPrUrl(newestDecided(steps, "publish")?.outcome?.prUrl);
}

/**
 * The full head the publish step says it shipped: its typed `publishedHead`,
 * re-checked with the SAME shape rule the loader enforces — the loader is not the
 * only thing that hands a `Step[]` over (an in-memory log from a run that just
 * finished never passed through it), exactly as `prUrlOf` revalidates the URL.
 * A publish that recorded no head, or one that is not an oid, returns
 * `undefined`, and that is what makes `prState` refuse `ready`. The reason line's
 * `at <sha>` is NOT read: prose is what this field exists to replace.
 */
function publishedHeadOf(publish: Step | undefined): string | undefined {
  const head = publish?.outcome?.publishedHead;
  return typeof head === "string" && isFullCommitSha(head) ? head : undefined;
}

/**
 * The newest step in the WHOLE log whose `state` matches, decided or not. Log
 * POSITION is what makes a verdict the run's current one — `newestDecided` would
 * skip an outcome-less step and let an older verdict speak for a gate that died.
 */
function newestAttempt(steps: Step[], state: Step["state"]): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]?.state === state) return steps[i];
  }
  return undefined;
}

/**
 * Did the gate clear the exact tree this publish step shipped? One reader: the
 * NEWEST `verify`, the same record `lean/engine.ts`'s `landEarned` reads, plus the
 * rule that the green is about the head `publish` pushed. The `startedAt` filter
 * this used to carry was wrong: a re-run leaves a verdict NEWER than the publish,
 * and reading an older green over it told a host to merge work its gate had since
 * called red. A `ci` is read by position too, and only ever REJECTS — an absent
 * `ci` is unjudged, not refused (lean has no `ci` step built), while a newest `ci`
 * that is not green is the pipeline's verdict against the head the PR stands on.
 *
 * An outcome-less newest `verify` or `ci` is a crash mid-step, so the gate is
 * UNOBSERVED; a publish with no head, or a green with none, the same. Every one of
 * these goes to `draft`.
 */
function gateClearedPublishedHead(steps: Step[], head: string | undefined): boolean {
  if (head === undefined) return false;
  // Absent `ci` is unjudged, not refused; but when a `ci` exists its NEWEST step
  // must be green — an outcome-less one is a crash mid-pipeline, not a green.
  const ci = newestAttempt(steps, "ci");
  if (ci !== undefined && ci.outcome?.kind !== "green") return false;
  const gate = newestAttempt(steps, "verify");
  if (gate?.outcome?.kind !== "green") return false;
  const verified = gate.outcome.verifiedHead;
  return typeof verified === "string" && isFullCommitSha(verified) && verified === head;
}

/**
 * Was the PR ready, a draft, or was there no PR at all? The typed answer to the
 * question exit 10 cannot ask.
 *
 * - `ready` — `counters.draft` is false, publish recorded `draft === false`, and
 *   the NEWEST `verify` is green about the very head publish says it shipped
 *   (an outcome-less newest `verify` is a crash, not a green), with no newest
 *   `ci` that is not green; a run with no `ci` step is unjudged, not refused;
 * - `draft` — `counters.draft` is true, or publish recorded `draft === true`, or
 *   anything about the claim is missing;
 * - `none` — no publish step left a PR URL.
 *
 * AN UNOBSERVED DRAFT STATE GOES TO `draft`, THE SAFE SIDE. `publish` records
 * the state the forge REPORTED rather than the one it asked for (that is
 * #1920 slice A's rule, and why the field is optional), so a publish outcome
 * with no `draft` is the one case where nobody knows. Guessing `ready` tells a
 * host to merge bytes its own gate never cleared; guessing `draft` costs a
 * person one look at the PR. The asymmetry decides it, and it decides every
 * missing half of the `ready` evidence the same way — `run.counters.draft`
 * included, which is the engine's own refusal (`landEarned` reads it FIRST).
 */
function prStateOf(steps: Step[], draftCounter: boolean): IssueResult["prState"] {
  const publish = newestDecided(steps, "publish");
  if (publish === undefined || prUrlOf(steps) === undefined) return "none";
  // The forge's own answer, or the run's own counter: either needs no second opinion.
  if (draftCounter || publish.outcome?.draft === true) return "draft";
  // `ready` is the only claim needing every half of its evidence: the forge said
  // the PR is not a draft, the gate went green, and that green was about the head
  // publish pushed. Anything else is `draft`, the safe side: a host told `ready`
  // merges, a host told `draft` goes and looks.
  if (publish.outcome?.draft !== false) return "draft";
  return gateClearedPublishedHead(steps, publishedHeadOf(publish)) ? "ready" : "draft";
}

/** Start/end per step, in log order — the shape `StepTiming[]` has. */
function stepTimings(steps: Step[]): StepTiming[] {
  return steps.map((s) => ({
    step: s.state,
    startedAt: new Date(s.startedAt).toISOString(),
    endedAt: new Date(s.endedAt ?? s.startedAt).toISOString(),
  }));
}

/** First start to last end, or 0 when the log cannot say. */
function durationOf(steps: Step[]): number {
  const first = steps[0]?.startedAt;
  const last = steps[steps.length - 1];
  const end = last?.endedAt ?? last?.startedAt;
  return typeof first === "number" && typeof end === "number" ? Math.max(0, end - first) : 0;
}

/**
 * The run's report, projected through the SAME reader `work`'s result uses.
 *
 * The projection reports only what the run OBSERVED. `handback` and `decline`
 * post their comment themselves and never throw, so the only account of whether
 * it reached the forge is the typed `posted` on their outcome — and a step that
 * recorded no claim at all is NOT delivered either. So:
 *
 *   - `delivery`/`channel` are `dispatch`/`forge` only when `posted === true`:
 *     `delivery` records where a post that HAPPENED came from, so its absence is
 *     "nobody posted", and `channel` stays `forge` because the report was
 *     addressed to the forge and never got there;
 *   - `bodyError: "not-recorded"` with no `body` is `HandoffResult`'s own pair
 *     for "published nothing", so an unposted comment cannot read as posted;
 *   - `labelApplied` is false on every path — lean has no label step, so `true`
 *     would be a claim the run has no step to make (and not `labelSkipped:
 *     "host-channel"` either, for the same reason);
 *   - no `handoffBodyPath`: nothing in `lean/` writes a report file, and
 *     `handoffOf` turns one into `bodyFile` — a path a person would open to find
 *     no file there.
 *
 * `body` is the run's OWN record (the marker line, then the reason the step left
 * on the log), never a re-read of a file — #1327's rule — clipped ONCE, after
 * redaction, to the room the composed body has left, because the reason is a
 * child's text and a host prints this document.
 *
 * A posted report reaches `handoffOf` through `makeHandoffEmittedEvent`, the
 * driver's own producer of that event, so it is a real `WorkEvent`; the state
 * around it is `initialState`'s own value with its `eventLog` replaced by that one
 * event. An UNPOSTED report is built directly instead: the event type REQUIRES a
 * `body` (#1820) and this projection has nothing to put in one when the forge took
 * nothing.
 */
function leanHandoff(run: LeanRun, cap: HeadlessCap | undefined): HandoffResult | undefined {
  const reported = newestDecided(run.steps, "handback") ?? newestDecided(run.steps, "decline");
  const reason = outcomeText(reported?.outcome);
  if (reason === undefined) return undefined;
  const at = reported?.endedAt ?? reported?.startedAt ?? 0;
  const marker = handoffMarker(run.issue, cap);
  const posted = reported?.outcome?.posted === true;
  // ONE clip, sized so the COMPOSED body fits `TEXT_MAX`; clipping the reason to
  // the whole budget and bounding the body again cut the reason away once the
  // marker was added.
  const clip = Math.max(0, TEXT_MAX - marker.length - BODY_GAP.length);
  if (!posted) {
    // Nothing reached the forge: no delivery provenance and no text —
    // `HandoffResult`'s own not-delivered pair.
    return { channel: "forge", marker, labelApplied: false, bodyError: "not-recorded" };
  }
  const event = makeHandoffEmittedEvent({
    at,
    // Lean posts through no driver seam that returns a URL, so there is no
    // comment address to record — only whether the post happened.
    commentUrl: undefined,
    // Lean has no label step, so it never claims one — posted or not.
    labelApplied: false,
    handoffBodyPath: "",
    // The text the forge took, redacted then clipped to the room the body has
    // left (`redactClip` scrubs BEFORE it clips, so a cut cannot leave a
    // fragment no pattern recognises).
    body: `${marker}${BODY_GAP}${redactClip(reason, clip)}`,
    delivery: "dispatch",
    targetType: "issue",
    targetNumber: run.issue,
    consolidated: false,
  });
  return handoffOf({ ...initialState(run.issue), eventLog: [event] }, cap);
}

/** The fold's totals flattened into the host contract's `usage` shape. */
function resultUsageOf(steps: Step[]): ResultUsage {
  const { total, byRole } = leanUsage(steps);
  return { ...total, byRole };
}

/**
 * Project one lean run into the single `IssueResult` its document carries.
 *
 * `code` is the code the run stamped (`RunLeanResult.code`). Every field comes
 * from the run's own record; a field with no lean counterpart is absent rather
 * than guessed — which is why there is no `prNumber` (the lean forge adapter
 * returns a URL, not a number) and no `parkReason` (no lean step records one).
 */
export function leanIssueResult(run: LeanRun, code: number): IssueResult {
  const steps = run.steps;
  const prUrl = prUrlOf(steps);
  const status = leanStatus(run, code);
  const failure = leanFailure(run);
  const prState = prStateOf(steps, run.counters.draft);
  const cap = leanCap(status, prUrl, prState);
  const result: IssueResult = {
    issue: run.issue,
    status,
    stateFile: stateFileOf(run.issue),
    durationMs: durationOf(steps),
    steps: stepTimings(steps),
    exitCode: code,
    resumable: false,
    usage: resultUsageOf(steps),
    // The same derivation every lean surface uses, so the branch the document
    // names is the branch the steps worked on (`lean/`'s own fallback).
    branch: specifyBranch(run.branch, run.issue),
    prState,
  };
  if (cap !== undefined) result.cap = cap;
  // `failedStep` is reported ONLY when the cap names it: `capStep()` is the
  // driver's own rule for a step-template cap, and lean's states are not
  // `WorkStep`s, so a guessed step would be a wrong answer rather than a
  // missing one.
  const named = cap === undefined ? undefined : capStep(cap);
  if (named !== undefined) result.failedStep = named;
  if (failure !== undefined) result.failure = failure;
  if (prUrl !== undefined) result.prUrl = prUrl;
  const handoff = leanHandoff(run, cap);
  if (handoff !== undefined) result.handoff = handoff;
  return result;
}

/**
 * The success-path document: a schema-5 result for one lean run, in the shape a
 * verb returns (`exitCode` + `doc`).
 *
 * `schemaVersion` / `issues[]` mirror `ResultDocument`, and `buildCommit` /
 * `buildVersion` are deliberately NOT filled here: `runSubcommand` (cli.ts)
 * spreads the build fields into whatever a verb returns, and the verb's tests
 * drive it through that path — so the CLI owns those two and this module cannot
 * contradict it. The `error` field is absent by construction: this is the path
 * where the run answered, and the refusal/crash documents (#1924) stay exactly
 * as `work-lean.ts` builds them.
 */
export function leanResultDocument(
  run: LeanRun,
  code: number,
): { exitCode: number; doc: Record<string, unknown> } {
  return {
    exitCode: code,
    doc: {
      schemaVersion: RESULT_SCHEMA_VERSION,
      issues: [leanIssueResult(run, code)],
    },
  };
}

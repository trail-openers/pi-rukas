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
 * The fields with no counterpart in `work` are `prState`, `reviewBound` and
 * `reviewComplete`. Exit 10 covers every lean run that reaches `publish` and does
 * not merge, because the handback is one exit code for many causes: a green PR
 * waiting for a merge, a ready PR whose review judged no further lens, a draft
 * behind unverified bytes, a gate that refused to certify the head, and a run that
 * opened nothing. `status`/`cap` alone cannot tell those apart, and the issue asks
 * for a typed answer, so the three lean-only fields sit beside them.
 *
 * Why the caps are chosen the way they are. `work`'s cap vocabulary is a closed
 * union checked against the driver's `WorkCapLiteral`, and no entry there
 * describes a lean run's cause — a lean handback is a different machine's
 * verdict, and inventing a name would put a word in the host's `switch` that
 * `--capabilities` never published. So exactly TWO published caps are used, both
 * already in `FIXED_CAPS`, and only where each says what a lean run did:
 * `awaiting-human-merge` for a PR that publish opened READY, whose own gate
 * cleared AND whose newest `review` step accounted for every lens it was bought ON THE HEAD
 * THE PR NOW STANDS ON;
 * `review-incomplete` for that same ready PR whose review left a lane unjudged, died
 * without recording a verdict, was never dispatched at all, or whose verdict does not cover
 * the head the PR now stands on — the cap that keeps a
 * host from merging a head no lens read. Both exit 10, and `leanCap` owns the rule that
 * tells them apart. Every other cause rides `failure`, whose `kind` is an OPEN list built
 * for this (`FAILURE_KINDS`, and `test-headless-failure-usage.ts` asserts the published
 * list equals the live array).
 *
 * `lens-review-timeout` is deliberately NOT used, though it is the one published
 * name that sounds like a lean budget breach. It is not: it names the classic
 * driver's six-pass review loop, whose budget a lean run never had — a lean
 * `budget` outcome is a step's own ceiling on its own child. Borrowing the name
 * to make prose legible would be a cap the run did not hit, and the typed
 * outcome (`kind === "budget"` with its `limit`) already says what happened.
 */

import { redactClip } from "../decision-log.ts";
import { NO_BLOCK_RULE } from "../lean/spec.ts";
import { RED_TEST_GAP } from "../lean/specify-gap-switch.ts";
import { specifyBranch } from "../lean/specify-tree.ts";
import { type LeanRun, type Outcome, REPORT_STATES, type Step } from "../lean/state.ts";
import { budgetSentence, budgetTrio } from "../lean/step-budget.ts";
import type { DispatchUsageRow } from "../lean/step-budget.ts";
import { leanUsage } from "../lean/usage-sum.ts";
import { classifyFailureCause } from "../work-driver-failure-taxonomy.ts";
import { type HeadlessCap, capStep } from "./caps.ts";
import type { ResultFailure } from "./failure.ts";
import {
  type HandoffResult,
  type IssueResult,
  RESULT_SCHEMA_VERSION,
  type ResultUsage,
  type StepTiming,
  handoffOf,
} from "./result.ts";
import { leanGates, reviewBoundSentence } from "./work-lean-gates.ts";
import { leanHandoff } from "./work-lean-handoff.ts";
import { prStateOf, prUrlOf, publishedHeadOf, reviewCompleteOf } from "./work-lean-pr.ts";

/** The full head the newest `review` fix wave started from (`PI_ENSEMBLE_LEAN_PREFIX_HEAD`); absent when
 * no review recorded one. Lean-only, so it is typed here rather than on the shared `IssueResult`. */
type LeanOnly = { preFixHead?: string };

/** What `work` reports for a finished PR waiting on a person (#1675's vocabulary). */
const AWAITING = "awaiting-human-merge";

/**
 * The published cap for a review that never judged every lane (`FIXED_CAPS`). A ready PR
 * whose review step stopped — at its own budget or the cycle deadline — left lenses that
 * returned no verdict, so the run is NOT work waiting on a person: nobody has read the
 * head yet. `capStep()` names no step for it (the cap carries no `:`), so `failedStep`
 * stays absent, and `capKind()` reads it as `process`: neither gate judged the code.
 */
const REVIEW_INCOMPLETE = "review-incomplete";

/** A lean `failure.step` must be a `WorkStep`; `handback` has no counterpart. */
const LEAN_FAILURE_STEP = "handoff" as const;

/** How long one piece of the run's own prose may be on the host's document. Same
 * bound and seam as `headless/failure.ts`: redaction happens BEFORE the clip, so
 * a cut cannot leave a fragment no pattern recognises. */
const TEXT_MAX = 500;

/** The run's durable record, named the way the engine names it. */
function stateFileOf(issue: number): string {
  return `.pi/lean-state/${issue}.json`;
}
/** The run's own words for why it ended, preferring the outcome's reason; a
 * `ready` refusal's words are its rules. */
function outcomeText(outcome: Outcome | undefined): string | undefined {
  if (outcome === undefined) return undefined;
  // `Outcome`'s prose fields are optional, and the log this projection reads is
  // a `Step[]` the loader is not the only thing that hands over — so each is
  // re-checked rather than trusted.
  const rules = Array.isArray(outcome.failedRules) ? outcome.failedRules.join("; ") : undefined;
  for (const text of [outcome.reason, outcome.message, rules]) {
    if (typeof text === "string" && text.trim() !== "") return text.trim();
  }
  return undefined;
}

/** `ready` refused the issue for carrying no `pi-spec v1` block and derived none. A `fail` whose
 * only rule is that one is the single issue refusal a host can route to another driver, so it is
 * matched exactly: any other rule beside it is a refusal the other driver would meet too. */
function noSpec(outcome: Outcome | undefined): boolean {
  const rules = outcome?.failedRules;
  return outcome?.kind === "fail" && rules?.length === 1 && rules[0] === NO_BLOCK_RULE;
}

/**
 * The newest step whose outcome reports a failure of its own, or undefined —
 * child text a host prints, so its reason is bounded and redacted on exit.
 */
function newestFailureStep(steps: Step[]): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const kind = steps[i]?.outcome?.kind;
    // `blocked` is a failure of the same family as `red` — a real judgement
    // about the contract, reached by re-running the tests, not a step that ran
    // out of rounds — so it must be recognised here or a blocked run's document
    // carries no `failure` at all and the one cause a host could branch on is
    // silent.
    if (
      kind === "error" ||
      kind === "red" ||
      kind === "blocked" ||
      kind === "exhausted" ||
      kind === "refused" ||
      kind === "setup" ||
      noSpec(steps[i]?.outcome) ||
      kind === RED_TEST_GAP
    )
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

/** Any dispatch row of a step — the row a host blames for a killed child. */
function lastRow(step: Step | undefined): DispatchUsageRow | undefined {
  const rows = step?.outcome?.dispatches;
  return rows === undefined || rows.length === 0 ? undefined : rows[rows.length - 1];
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
 *      outcome reports a failure and map it: `setup` → `setup` (`ready` refused
 *      the repository), `fail` → `no-spec` (counted as a failure only when its
 *      sole rule is exactly `NO_BLOCK_RULE`, see `noSpec`; any other `fail` is
 *      skipped), `red-test-gap` → `red-test-gap` (`specify`'s own child left a
 *      criterion with no red test; its message is the gap rules), `error` →
 *      `crashed` (a handler threw), `red`/`blocked` →
 *      `verify` (the run's own gate judged the code),
 *      `exhausted`/`refused` → `process` (out of rounds, or the forge refused —
 *      neither judges the code, none is transient). Its `message` is the
 *      outcome's own reason or message, or a fallback naming the state and kind;
 *   4. if no such step exists the run said nothing about failing: `undefined`.
 *
 * `step` is always `"handoff"` and `role` names the child a host blames — the
 * last row of the step whose ceiling fired on a budget failure, otherwise the
 * last child of the newest dispatching step — both added only when they have a
 * value: lean's states are not `WorkStep`s, so the one handoff shape `work` uses
 * is the honest answer.
 *
 * `cause` is added ONLY where lean actually recorded one, and then through the
 * SAME classifier `work` uses — `classifyFailureCause`, whose input is the
 * dispatch's kill. A lean step records the kill's consequence (its budget trio,
 * its `ok: false` row, the engine's error text) and no kill cause of its own, so
 * most lean failures have no cause to report and get none: an invented one would
 * send a host's retry ladder off a fact the run never observed.
 */
function leanFailure(run: LeanRun): ResultFailure | undefined {
  const steps = run.steps;
  const worked = newestWorkStep(steps);
  // The shared trio check: `limit` named and `value`/`used` numbers, or the
  // breach is a half-record and falls through to the newest real failure.
  const fired = worked === undefined ? undefined : budgetTrio(worked.outcome);
  let failure: ResultFailure;
  // The child a host blames. On a budget failure that is the LAST row of the
  // step whose ceiling fired — the child that was running when the bound closed
  // — because `cause` is read from that same row and the two must never name
  // different children. Otherwise it is the last child of the newest step that
  // dispatched at all.
  let blamed: DispatchUsageRow | undefined;
  if (worked !== undefined && fired !== undefined) {
    failure = {
      kind: "timeout",
      message: redactClip(budgetSentence(worked.state, fired), TEXT_MAX),
    };
    // A `minutes` breach is lean's own wall-clock kill of its child — but only
    // of the child THAT step dispatched, so the kill is attributed to the step's
    // OWN last row and to nothing else: `ok: false` on some other row of the
    // same step (a lens that failed while the builder ran clean) would otherwise
    // blame a kill on a child that never suffered one, and name it as the guilty
    // role. `turns`/`tokens` stop at a turn boundary and are not kills, so they
    // get no cause — the trio already names them.
    blamed = lastRow(worked);
    if (fired.limit === "minutes" && blamed?.ok === false) {
      failure.cause = classifyFailureCause({
        kind: "dispatch-failed",
        killCause: "child-bound",
      }).cause;
    }
  } else {
    const step = newestFailureStep(steps);
    if (step === undefined) return undefined;
    const kind = step.outcome?.kind;
    // A gap's message is its rules alone: the reason repeats them around the per-file evidence.
    const rules = kind === RED_TEST_GAP ? step.outcome?.failedRules?.join("; ") : undefined;
    const message =
      rules || outcomeText(step.outcome) || `${step.state} step reported ${String(kind)}`;
    failure = {
      kind:
        kind === RED_TEST_GAP
          ? // `specify`'s own child proved no criterion red: the run's failure, not the spec's.
            RED_TEST_GAP
          : kind === "setup"
            ? // `ready` refused the repository's setup: the one kind a host falls back on.
              "setup"
            : kind === "fail"
              ? // Only the no-block refusal reaches here (`noSpec`); the run ends not-ready at exit 11.
                "no-spec"
              : kind === "error"
                ? // A handler threw: the engine recorded its message and handed back.
                  "crashed"
                : kind === "red" || kind === "blocked"
                  ? // The run's own gate judged the code, or the builder proved the
                    // frozen tests cannot all pass together (the driver ran them). Both
                    // are a judgement about the code, so a host routes them the same way.
                    "verify"
                  : // `exhausted` / `refused`: the step ran out of rounds, or the forge
                    // refused. Neither is a judge of the code and none is transient.
                    "process",
      message: redactClip(message, TEXT_MAX),
    };
  }
  failure.step = LEAN_FAILURE_STEP;
  const role = blamed?.role ?? lastRole(steps);
  if (role !== undefined) failure.role = role;
  return failure;
}

/**
 * The cap. `undefined` when no published cap name says what happened — the
 * cause is then on `failure` alone, which is the open list.
 *
 * `review-incomplete` outranks `awaiting-human-merge` on a ready PR: the two are told
 * apart by whether the run's own review read every lens OF THE HEAD THE PR NOW STANDS ON,
 * and telling a host to merge over lanes that never ran — or over a head pushed after the
 * review read it — is the failure this cap exists to prevent. `reviewComplete` is `true`
 * when the switch is off (today's single cap) or when the record says the newest review step
 * finished on the head that shipped; `reviewCompleteOf` owns those answers.
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
  reviewComplete: boolean,
): HeadlessCap | undefined {
  if (prUrl === undefined || status !== "handoff" || prState !== "ready") return undefined;
  return reviewComplete ? AWAITING : REVIEW_INCOMPLETE;
}

/**
 * The terminal status, from the state the run reached and the code it stamped.
 *
 * `landed` is the only success and `not-ready` is the one verdict that says the
 * ISSUE was refused (an issue-text fault is `causeClass: "issue"` in `work`'s
 * vocabulary, not a change fault).
 *
 * Anything else is a state the verb's own gate has already refused: `wellFormed`
 * (`headless/work-lean.ts`) is the sole production caller's precondition and it
 * admits only a state `EXIT_CODES` names — one of the three above. A fourth arm
 * here would be a status no run can produce, and a status is a field a host
 * switches on: `running` or `interrupted` invented for a shape the caller says
 * cannot arrive would be a confident wrong answer about a bug elsewhere. So the
 * unreachable case fails loudly at the projection instead of quietly reporting a
 * state the run never reached.
 */
function leanStatus(run: LeanRun, code: number): IssueResult["status"] {
  if (run.state === "landed") return "merged";
  if (run.state === "not-ready") return "aborted";
  if (run.state === "handed-back") return "handoff";
  throw new Error(
    `leanIssueResult: ${JSON.stringify(run.state)} is not a terminal lean state (code ${String(code)})`,
  );
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
  // The one read of the review record, feeding both the cap and the field: they cannot
  // disagree because neither of them decides the question on its own.
  const reviewComplete = reviewCompleteOf(steps);
  const cap = leanCap(status, prUrl, prState, reviewComplete);
  // The head this run's PR stands on, worked out ONCE here by the reader `prStateOf`
  // itself uses. `gates.handback.head` asks a different question — the head that actually
  // SHIPPED, which after a rewind is no longer this one — so it reads the handback step's
  // own record, and `verified` is that head put back through the same gate test. One
  // reader of the rule, two heads: the fields cannot disagree because neither of them
  // decides the question on its own.
  const result: IssueResult & LeanOnly = {
    issue: run.issue,
    status,
    stateFile: stateFileOf(run.issue),
    durationMs: durationOf(steps),
    steps: stepTimings(steps),
    exitCode: code,
    resumable: false,
    driver: "lean",
    usage: resultUsageOf(steps),
    // The same derivation every lean surface uses, so the branch the document
    // names is the branch the steps worked on (`lean/`'s own fallback).
    branch: specifyBranch(run.branch, run.issue),
    prState,
  };
  if (cap !== undefined) result.cap = cap;
  // R3: A review that stopped at its clock still hands back 10 with a ready PR, so
  // nothing else in this projection says "some lanes were never judged" — and a host
  // deciding whether to merge reads this document, not stderr. Read off the step log
  // (the loader validated it, so it cannot disagree with what a resume reads); absent
  // means NO STOP WAS RECORDED, never that a review finished — an older attempt's stop
  // stays named after a later judged review overtook it. The sentence is built by the gates
  // module's own reader so both surfaces that print these two child-authored strings redact
  // them the same way — see `reviewBoundSentence`.
  for (let i = steps.length - 1; i >= 0; i--) {
    const rec = steps[i]?.state === "review" ? steps[i]?.outcome?.reviewBound : undefined;
    if (rec === undefined) continue;
    result.reviewBound = reviewBoundSentence(rec, (s) => redactClip(s, TEXT_MAX));
    break;
  }
  // The newest review fix wave's lower bound, so a host can name the commits the fixer made.
  const preFixHead = [...steps].reverse().find((s) => s.state === "review" && s.outcome?.preFixHead)
    ?.outcome?.preFixHead;
  if (preFixHead !== undefined) result.preFixHead = preFixHead;
  // Written on one switch, and ONLY on the arm that has a cap to pair with: the contract's
  // promise is `reviewComplete: false` beside cap `review-incomplete` and `true` beside
  // `awaiting-human-merge`, so the key goes on the document exactly where one of those caps is.
  // A merged run, a draft, or one that never reached `publish` has no cap to pair with and gets
  // no key — `prState`/`status` are its answer — and a key beside them would assert a review
  // verdict this document does not make. Attached whole or not at all, so the off arm leaves no
  // key holding `undefined` for a host that string-compares the file.
  if (cap !== undefined) result.reviewComplete = reviewComplete;
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
  // The gate events, attached whole or not at all. The projection builds the object
  // separately so the document either carries the key or does not: a field filled
  // conditionally leaves a key holding `undefined` behind for a host that string-compares
  // the JSON.
  result.gates = leanGates(steps, (s) => redactClip(s, TEXT_MAX));
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

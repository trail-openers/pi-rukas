#!/usr/bin/env bun
import type { HeadlessCap } from "../src/headless/caps.ts";
/**
 * #1798 round 3 — a bound kill whose stream the ENDPOINT cut is systemic.
 *
 * Round 1 of this issue made `buildCompletionEvent` stamp `providerMessage` on
 * a `dispatch-failed` that also carries `killCause`, so the fact a killed child
 * died on a severed stream survived into the state file. What round 2 found is
 * that the fact survived and then went unread: `classifyFailureCause` returns
 * from its `killCause` block long before it reads `providerMessage`, so a
 * lens-fix fixer killed at its 45-minute bound BY A SPEND-CAP 429 classified
 * `self-killed:timeout` — and `isSystemicFailure` (work-queue.ts), which halts
 * the remaining groups only on the two terminal provider causes, let every
 * later group start and meet the same cap. That is the #368 failure mode
 * reached through a kill: the queue halted for nothing before, and now runs
 * into a wall for nothing.
 *
 * Three legs, all built through the real `buildCompletionEvent` (a hand-written
 * event would be a second implementation of the very mapper whose behaviour is
 * in question):
 *
 *  1. kill + spend-cap provider text → systemic, and the cause is the terminal
 *     provider class rather than the self-kill;
 *  2. kill + an ordinary transient provider text → still `self-killed:timeout`,
 *     NOT systemic: a blip says nothing about the next group;
 *  3. kill with no provider text → unchanged, `self-killed:timeout`.
 *
 * Plus the two surfaces the same fact feeds: `failureOf` now carries
 * `providerMessage` for a `dispatch-failed` that has one, and the two new
 * fields validate at resume.
 *
 * The kill branch still wins the KIND of every event here, and every cause this
 * file asserts for a killed child has `shouldRetry: false` — a self-kill is
 * never re-dispatched because a provider said something (#296 holds).
 */
import { failureOf } from "../src/headless/failure.ts";
import { buildCompletionEvent } from "../src/work-driver-completion-event.ts";
import { classifyFailureCause } from "../src/work-driver-failure-taxonomy.ts";
import { FIXER_BOUND_SOURCES } from "../src/work-driver-fixer-bound.ts";
import { lensFixBoundKillVerdict } from "../src/work-driver-lens-fix-kill-cause.ts";
import { isSystemicFailure } from "../src/work-queue.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import { type WorkEvent, type WorkState, initialState } from "../src/workflow-state.ts";
import {
  FIXER_BOUND,
  MIN,
  NOW,
  killed,
  killedByProvider,
  lensFixCtx,
  lensFixWindow,
} from "./lib/lens-fix-kill-cause-fixtures.ts";

let exitCode = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exitCode = 1;
  }
}

/** The observed shapes, spelled from the pieces rather than pasted: the
 *  secret-shaped one is assembled at RUNTIME so this file's own text never
 *  carries a credential-class token (the same rule `vipune`'s secret boundary
 *  and `secret-patterns.ts` enforce elsewhere). */
const SPEND_CAP = ["429 status code", "monthly spend cap reached"].join(" — ");
const QUOTA_WINDOW = "Server requested 7200s retry delay (max: 10s). 429 status code";
const TRANSIENT = "Request timed out.";
const SECRET = ["sk-ant", "api03", "AbCdEf0123456789ghi", "jKlMnOpQrStUvwXy"].join("-");

/** The event the driver would store for a killed lens-fix child. */
async function eventFor(result: Parameters<typeof buildCompletionEvent>[4]): Promise<WorkEvent> {
  return buildCompletionEvent(
    lensFixCtx(result) as never,
    "lens-fix",
    "developer",
    "lens-fix",
    result,
  );
}

/** A one-dispatch lens-fix cycle whose kill carried `providerMessage`. */
async function killedCycle(providerMessage: string | undefined): Promise<WorkState> {
  const result = providerMessage === undefined ? killed() : killedByProvider(providerMessage, {});
  return lensFixWindow([result], ["fixer-bound"]);
}

// ───────────────────────────── 1. the kill branch carries the fact ──────────
{
  const ev = (await eventFor(killedByProvider(SPEND_CAP))) as Extract<
    WorkEvent,
    { kind: "dispatch-failed" }
  >;
  assert(
    ev.kind === "dispatch-failed" && ev.killCause === "timeout",
    `the kill branch still owns the event's KIND (got ${ev.kind}/${ev.killCause})`,
  );
  assert(
    ev.providerMessage === SPEND_CAP,
    `the provider's own words ride along (got ${JSON.stringify(ev.providerMessage)})`,
  );
}

// ───────────────── 2. a spend-cap kill is systemic for the queue ────────────
{
  const state = await killedCycle(SPEND_CAP);
  const cls = classifyFailureCause(state.eventLog.at(-2) as never);
  assert(
    cls.cause === "rate-limited:quota-terminal" && cls.shouldRetry === false,
    `a bound kill cut by a spend cap classifies the TERMINAL provider class, not the self-kill, and is still never retried (got ${cls.cause}/retry=${cls.shouldRetry})`,
  );
  const sys = isSystemicFailure(state);
  assert(
    sys.systemic,
    `…and the queue halts: every remaining group meets the same cap (got ${sys.reason})`,
  );
  assert(
    (sys.reason ?? "").includes("spend cap"),
    `…and the reason says which terminal class it halted on (got ${JSON.stringify(sys.reason)})`,
  );
  // The cause classifier's own verdict stays a full abstain: a terminal outage
  // is never a bound to raise.
  assert(
    lensFixBoundKillVerdict(state, "step-failed:lens-fix", undefined, 1798) === undefined,
    "the bound verdict still abstains on an outage — the queue halt and the abstain agree",
  );
}

// ───────────────── 2b. a quota-window kill is systemic too ──────────────────
{
  const state = await killedCycle(QUOTA_WINDOW);
  const cls = classifyFailureCause(state.eventLog.at(-2) as never);
  assert(
    cls.cause === "rate-limited:quota-window" && cls.shouldRetry === false,
    `a 429 whose stated delay is beyond the burst threshold is terminal, kill or no kill (got ${cls.cause})`,
  );
  assert(
    isSystemicFailure(state).systemic,
    "a quota window halts the queue — nothing will succeed until it resets",
  );
}

// ─────────────── 2c. a transient provider text does NOT outrank the kill ────
{
  const state = await killedCycle(TRANSIENT);
  const cls = classifyFailureCause(state.eventLog.at(-2) as never);
  assert(
    cls.cause === "self-killed:timeout",
    `an ordinary provider blip on a killed child is still the self-kill — the kill is the fact the operator acts on (got ${cls.cause})`,
  );
  assert(
    !isSystemicFailure(state).systemic,
    "…and it says nothing about the next group, so the queue continues",
  );
}

// ───────────────────────── 2d. no provider text: unchanged behaviour ─────────
{
  const state = await killedCycle(undefined);
  const ev = state.eventLog.at(-2) as Extract<WorkEvent, { kind: "dispatch-failed" }>;
  assert(
    ev.kind === "dispatch-failed" && ev.providerMessage === undefined,
    "a kill with no error-stop carries no providerMessage at all (not an empty string)",
  );
  assert(
    classifyFailureCause(ev as never).cause === "self-killed:timeout",
    "…and classifies exactly as it did before this change",
  );
  assert(!isSystemicFailure(state).systemic, "…and is not systemic");
  const v = lensFixBoundKillVerdict(state, "step-failed:lens-fix", undefined, 1798);
  assert(
    v?.causeClass === "pi-rukas",
    `…and still gets the bound verdict with a knob to raise (got ${v?.causeClass})`,
  );
}

// ───────────────── 3. the provider text is redacted and bounded ─────────────
{
  // Assembled at runtime (see the note above): the provider's body quotes a
  // key it was refused with, plus a stack trail far past the reason budget.
  const leaking = `429 status code — invalid api key ${SECRET} in request header; ${"x".repeat(2000)}`;
  const ev = (await eventFor(killedByProvider(leaking))) as Extract<
    WorkEvent,
    { kind: "dispatch-failed" }
  >;
  assert(
    ev.providerMessage !== undefined && !ev.providerMessage.includes(SECRET),
    `the STORED providerMessage has the credential redacted (got ${JSON.stringify(ev.providerMessage)?.slice(0, 120)})`,
  );
  assert(
    ev.providerMessage?.includes("[REDACTED]") === true,
    "…and the redaction marker is what replaced it, so a reader can tell",
  );
  assert(
    (ev.errorTail ?? "").length > 0 &&
      !(ev.errorTail ?? "").includes(SECRET) &&
      (ev.errorTail ?? "").includes("[REDACTED]"),
    "…and the SAME text appended to errorTail is redacted too — one reading, both places",
  );
  // The bound: the classifier's own reason budget, applied to both surfaces.
  assert(
    (ev.providerMessage ?? "").length <= 240 && (ev.errorTail ?? "").length < 2000,
    `neither field carries the 2 KB body whole (providerMessage=${ev.providerMessage?.length}, errorTail=${ev.errorTail?.length})`,
  );

  // The headless projection carries the same scrubbed text and no secret.
  const state = await killedCycle(leaking);
  const f = failureOf(state, "step-failed:lens-fix" as HeadlessCap, "lens-fix");
  assert(
    f?.providerMessage !== undefined && !f.providerMessage.includes(SECRET),
    `failureOf projects the provider message for a dispatch-failed, redacted (got ${JSON.stringify(f?.providerMessage)?.slice(0, 120)})`,
  );
  assert(
    f?.killCause === "timeout" && (f.errorTail ?? "").includes("[REDACTED]"),
    "…without losing the kill's own fields",
  );
}

// ───────────────── 4. resume validation of the two new fields ──────────────
{
  const base = () => initialState(1798, NOW) as unknown as Record<string, unknown>;
  const withEvent = (over: Record<string, unknown>) => {
    const s = base();
    s.eventLog = [
      {
        kind: "dispatch-failed",
        step: "lens-fix",
        role: "developer",
        jobId: "lens-fix:x:1:1",
        label: "lens-fix",
        ms: MIN,
        at: NOW,
        killCause: "timeout",
        ...over,
      },
    ];
    return s;
  };
  assert(
    validateDiscriminants(withEvent({})).length === 0,
    "a dispatch-failed with neither new field validates (every pre-#1798 state file resumes)",
  );
  for (const source of FIXER_BOUND_SOURCES) {
    assert(
      validateDiscriminants(withEvent({ fixerBoundSource: source })).length === 0,
      `fixerBoundSource "${source}" validates — it is one of the three the resolver produces`,
    );
  }
  assert(
    validateDiscriminants(withEvent({ fixerBoundSource: "spawn-backstop" })).length === 1,
    "a source no clock produces is refused, naming the field",
  );
  assert(
    (validateDiscriminants(withEvent({ fixerBoundSource: 7 }))[0] ?? "").includes(
      "fixerBoundSource",
    ),
    "…and the finding names the field, not just 'invalid'",
  );
  assert(
    validateDiscriminants(withEvent({ providerMessage: SPEND_CAP })).length === 0,
    "a string providerMessage validates",
  );
  assert(
    (
      validateDiscriminants(withEvent({ providerMessage: { message: SPEND_CAP } }))[0] ?? ""
    ).includes("providerMessage"),
    "a non-string providerMessage is refused — it decides a queue-wide halt",
  );
  // #1798 round 3: the provider kind carries the same two fields and is read
  // by the same classifiers, so it validates under the same rules.
  const providerKind = () => {
    const s = base();
    s.eventLog = [
      {
        kind: "dispatch-failed-provider",
        step: "lens-fix",
        role: "developer",
        jobId: "lens-fix:x:1:1",
        label: "lens-fix",
        ms: MIN,
        at: NOW,
      },
    ];
    return s;
  };
  assert(
    validateDiscriminants(providerKind()).length === 0,
    "a dispatch-failed-provider with neither field validates",
  );
  const pk = providerKind() as { eventLog: Record<string, unknown>[] };
  pk.eventLog[0].fixerBoundSource = "review-clock";
  pk.eventLog[0].providerMessage = 42;
  assert(
    validateDiscriminants(pk).length === 1 &&
      (validateDiscriminants(pk)[0] ?? "").includes("providerMessage"),
    "…and the provider kind is checked by the same two rules",
  );
}

// ─────────── 5. the reader: cap index, the completed-round stop, both kinds ─
{
  // An EARLIER attempt that was retried and RECOVERED must not license the
  // later kill: `dispatch-completed` of this step halts the backward walk, the
  // same #386 rule `isSystemicFailure` applies. Built on the fixture's own
  // window so the only difference from the passing cases is the completed
  // round sitting between the armed kill and the cap.
  const armed = killed({ fixerBoundSource: "fixer-bound" });
  const recovered = await lensFixWindow([armed, killed()], ["fixer-bound", undefined]);
  const log = [...recovered.eventLog];
  // Insert a completed lens-fix dispatch BETWEEN the recovered attempt's
  // failure and the second (sourceless) failure: the armed round came back
  // fine after its kill, so its source is history, not this cap's cause.
  const lastFailed = log.findLastIndex((e) => e.kind === "dispatch-failed");
  log.splice(lastFailed, 0, {
    kind: "dispatch-completed",
    step: "lens-fix",
    role: "developer",
    jobId: "lens-fix:ok:1:1",
    label: "lens-fix",
    ok: true,
    ms: 2 * MIN,
    at: NOW + FIXER_BOUND,
  } as WorkEvent);
  const capped = log.at(-1);
  const state = { ...recovered, eventLog: log } as WorkState;
  assert(
    capped?.kind === "cap-hit" && lastFailed > 0,
    "the fixture still ends on the cap, with a completed round inside the window",
  );
  assert(
    lensFixBoundKillVerdict(state, "step-failed:lens-fix", undefined, 1798) === undefined,
    "a recovered round's bound does not license the round that ended the step",
  );

  // A failure of ANOTHER step inside the window is skipped, not terminal: the
  // scan looks for THIS step's dispatch and keeps walking past a foreign one.
  const foreign = await lensFixWindow([killed()], ["fixer-bound"]);
  const flog = [...foreign.eventLog];
  const capAt = flog.findLastIndex((e) => e.kind === "cap-hit");
  const firstFailed = flog.findIndex((e) => e.kind === "dispatch-failed");
  flog.splice(firstFailed, 0, {
    kind: "dispatch-failed",
    step: "develop",
    role: "developer",
    jobId: "develop:x:1:1",
    label: "developer",
    ms: MIN,
    at: NOW,
    exitCode: 1,
    errorTail: "develop child exited 1",
  } as WorkEvent);
  const foreignState = { ...foreign, eventLog: flog } as WorkState;
  const v = lensFixBoundKillVerdict(foreignState, "step-failed:lens-fix", undefined, 1798);
  assert(
    v?.causeClass === "pi-rukas" && (v.causeReason ?? "").includes("45m"),
    `another step's failed dispatch in the window does not end the scan (got ${v?.causeClass})`,
  );

  // Both failure KINDS resolve: #1682 puts child-supervision kills on the
  // provider kind, and a state file holding one is a real shape.
  const providerKindState = await lensFixWindow([killed()], ["fixer-bound"]);
  const plog = [...providerKindState.eventLog];
  const pi = plog.findIndex((e) => e.kind === "dispatch-failed");
  plog[pi] = { ...(plog[pi] as object), kind: "dispatch-failed-provider" } as WorkEvent;
  const pv = lensFixBoundKillVerdict(
    { ...providerKindState, eventLog: plog } as WorkState,
    "step-failed:lens-fix",
    undefined,
    1798,
  );
  assert(
    pv?.causeClass === "pi-rukas",
    `a lens-fix failure recorded as dispatch-failed-provider is found too (got ${pv?.causeClass})`,
  );
}

console.log(
  exitCode === 0
    ? "\n#1798 round 3 provider fact on a kill: all assertions passed"
    : "\n#1798 round 3 provider fact on a kill: FAILURES above",
);
process.exit(exitCode);

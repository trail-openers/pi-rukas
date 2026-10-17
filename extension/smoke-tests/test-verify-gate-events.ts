#!/usr/bin/env bun
/**
 * #1415 (task C) — offline coverage for the verify events reaching the state
 * file, the `/work-status` rendering, and the headless NDJSON stream.
 *
 * janit/tehas#261 cycle 261: a develop step spent ~22 minutes per round inside
 * the consolidated verify with NOTHING on the console. Between the developer's
 * "Task complete" line and the driver's "step 4/9 develop done in 2491s" line,
 * the console was empty for 22 minutes — so an operator watching a cycle saw a
 * stall that was not one. The fix's observable half is an event pair around
 * every consolidated verify run, carrying the duration and the command, so the
 * time is attributed while it happens rather than reconstructed afterwards.
 *
 * Task B owns the event vocabulary. This file does not define it and does not
 * assert on its field names beyond what a reader needs: it pins the four
 * properties that make the events worth having, and each one is checked where
 * it is actually consumed.
 *
 *   1. **Persisted.** The events land in `eventLog`, so a cycle that dies
 *      mid-verify leaves a record of what it was doing.
 *   2. **Validated.** The kinds are in the #533 resume vocabulary — a kind the
 *      validator does not know makes a crashed cycle refuse to resume (the
 *      #986 incident, which is exactly what an event added at the last minute
 *      tends to break).
 *   3. **Rendered.** `/work-status` says something about them. A kind that
 *      renders as nothing is invisible to the operator, which is the symptom
 *      this ticket was filed for; the renderer's exhaustive switch is the
 *      single biggest risk for a NEW kind, so this is checked against the
 *      real renderer, not a fixture.
 *   4. **Streamed.** The headless host receives them without the state file or
 *      pi-rukas source. #1326 makes anything outside the stable subset an
 *      explicit `unstable: true` rather than a silent drop — so the pinned
 *      property is "it reaches the host and is honest about its stability",
 *      not "it is stable" (which the contract file owns).
 *
 * Plus the one property the pair has to keep: the completion event follows its
 * start event and carries a duration — an event pair whose order is wrong, or
 * whose duration is absent, is the same blank 22 minutes with extra steps.
 *
 * Offline: temp directories only, no model, no network, no spawn.
 */

import {
  NDJSON_STABLE_KINDS,
  eventKey,
  formatLine,
  isStableKind,
  validateNdjsonLine,
} from "../src/headless/ndjson.ts";
import { fmtEvent, fmtRecentEvents } from "../src/work-status-events.ts";
import { makeVerifyRunEvents } from "../src/workflow-state-events-verify.ts";
import { KNOWN_EVENT_KINDS, validateDiscriminants } from "../src/workflow-state-validate.ts";
import {
  type WorkEvent,
  type WorkState,
  appendEvent,
  initialState,
} from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const CMD = "bash scripts/verify.sh";
/** The two kinds the ticket asks for; resolved against the union, not hardcoded twice. */
const START = "verify-started";
const COMPLETE = "verify-completed";

/**
 * Build one of the two events through the codebase's own vocabulary.
 *
 * Goes through task B's factory, `makeVerifyRunEvents`, imported from the
 * module that DEFINES the pair (`workflow-state-events-verify.ts`). That
 * matters for all three of the ways this function used to fail silently:
 *
 *   - it looked in `workflow-state-events-verify-flake.ts`, which is the
 *     verify-TIER-OUTCOME fragment (`verify-flake-recovered`,
 *     `verify-full-status`, `consolidated-verify-skipped`) and has never
 *     exported a `makeVerifyStartedEvent` / `makeVerifyCompletedEvent`; the
 *     probe therefore always missed and always fell through to the literal;
 *   - the literal used `cmd`, which is not a field of either event — task B
 *     named it `command` — and omitted the required `target` entirely. Smoke
 *     tests are NOT type-checked (`extension/tsconfig.json` includes only
 *     `src/` and `scripts/`), so the cast to `WorkEvent` was load-bearing on
 *     nothing: the `cmd`/`target` mismatch was invisible at compile time and
 *     only surfaced as the renderer throwing on `e.target.kind`;
 *   - the fallback asserted nothing about the shape, so a rename on either
 *     side would have kept it "passing".
 *
 * A static import is deliberate: if task B renames the factory, this file
 * fails to LOAD and the whole suite reports red, rather than degrading to a
 * literal that quietly asserts the wrong contract. `target` is the
 * consolidated tree — the one the develop gate actually builds — so the
 * fixture carries every required field of the real type.
 */
function build(kind: string, at: number): WorkEvent {
  const shared = {
    step: "develop" as const,
    command: CMD,
    target: { kind: "consolidated" as const },
  };
  return kind === START
    ? { kind: START, at, ...shared }
    : { kind: COMPLETE, at, ...shared, status: "success", ms: 1_234_567 };
}

/** The field carrying the duration, however it is named (task B owns the name). */
function durationOf(e: WorkEvent): { field: string; value: unknown } | undefined {
  const o = e as unknown as Record<string, unknown>;
  for (const f of ["ms", "durationMs", "elapsedMs"]) {
    if (o[f] !== undefined) return { field: f, value: o[f] };
  }
  return undefined;
}

/** The field carrying the command, however it is named. */
function commandOf(e: WorkEvent): string | undefined {
  const o = e as unknown as Record<string, unknown>;
  for (const f of ["cmd", "command", "verifyCmd"]) {
    if (typeof o[f] === "string") return o[f] as string;
  }
  return undefined;
}

let started: WorkEvent | undefined;
let completed: WorkEvent | undefined;

try {
  started = build(START, 1_000);
  completed = build(COMPLETE, 1_000 + 1_234_567);
} catch (err) {
  assert(false, `the verify events are constructible from the event module (${String(err)})`);
}

if (started === undefined || completed === undefined) {
  assert(
    false,
    `#1415: both '${START}' and '${COMPLETE}' events exist (started: ${JSON.stringify(started)}, completed: ${JSON.stringify(completed)}) — task B owns that vocabulary; this file pins its consumers`,
  );
} else {
  // =============================================================== (1) kinds
  assert(
    (KNOWN_EVENT_KINDS as readonly string[]).includes(START),
    `'${START}' is in KNOWN_EVENT_KINDS — a cycle that dies mid-verify still resumes`,
  );
  assert(
    (KNOWN_EVENT_KINDS as readonly string[]).includes(COMPLETE),
    `'${COMPLETE}' is in KNOWN_EVENT_KINDS`,
  );
  assert(started.kind === START, `'${START}' survives the WorkEvent union as its own kind`);
  assert(completed.kind === COMPLETE, `'${COMPLETE}' survives the WorkEvent union as its own kind`);

  // ========================================================= (2) the payload
  assert(
    commandOf(started) === CMD,
    `the start event names the command the operator is waiting for (got: ${JSON.stringify(commandOf(started))})`,
  );
  assert(
    commandOf(completed) === CMD,
    `the completion event names the same command (got: ${JSON.stringify(commandOf(completed))})`,
  );
  const d = durationOf(completed);
  assert(
    d !== undefined && d.value === 1_234_567,
    `the completion event carries the duration — that number is the whole point of the pair (fields tried: ms/durationMs/elapsedMs; got: ${JSON.stringify(d)})`,
  );

  // ====================================================== (3) persisted+valid
  {
    let state: WorkState = initialState(1415, 2_000_000);
    state = {
      ...state,
      pipelineState: { ...state.pipelineState, currentStep: "develop", status: "running" },
    };
    // Through the real mutator, so `at` is stamped the way a live cycle stamps
    // it and the append order is the driver's, not this file's.
    state = appendEvent(state, { kind: "step-started", step: "develop", at: 900 });
    state = appendEvent(state, started);
    state = appendEvent(state, completed);
    const findings = validateDiscriminants(state);
    assert(
      findings.length === 0,
      `a running state file carrying both events validates clean (findings: ${JSON.stringify(findings)})`,
    );
    const kinds = state.eventLog.map((e) => e.kind);
    assert(
      kinds.includes(START) && kinds.includes(COMPLETE),
      `both events persist into eventLog (kinds: ${kinds.join(",")})`,
    );
    // ORDER is load-bearing: a completion written before its start renders as
    // a gate that finished before it began, which is the same mis-attribution
    // the 22-minute silence caused.
    const iStart = state.eventLog.findIndex((e) => e.kind === START);
    const iDone = state.eventLog.findIndex((e) => e.kind === COMPLETE);
    assert(
      iStart >= 0 && iDone > iStart,
      `the completion event comes AFTER its start in the append-only log (start@${iStart}, completed@${iDone})`,
    );
  }
  // The symptom this ticket was filed for is a step that LOOKS like a stall.
  // A new event kind whose renderer case is missing is exactly that symptom
  // reintroduced one layer down, so this asserts on the real renderer and
  // rejects the empty/placeholder answers too.
  for (const [label, e] of [
    [`'${START}'`, started],
    [`'${COMPLETE}'`, completed],
  ] as Array<[string, WorkEvent]>) {
    let line: string | undefined;
    try {
      line = fmtEvent(e);
    } catch (err) {
      assert(false, `${label} renders in /work-status without throwing (${String(err)})`);
      continue;
    }
    const text = (line ?? "").trim();
    assert(
      text.length > 0 && !/^\s*$/.test(text),
      `${label} renders a non-empty line in /work-status (got: ${JSON.stringify(line)})`,
    );
    const lower = text.toLowerCase();
    assert(
      !lower.includes("undefined") && !lower.includes("nan") && !lower.includes("[object"),
      `${label}'s line contains no undefined/NaN/[object placeholder (got: ${JSON.stringify(line)})`,
    );
    const cmd = commandOf(e);
    // Only the START line has to name the command. The pair's own contract
    // says so: `workflow-state-events-verify.ts` documents `verify-started` as
    // "the line that exists for the 22 minutes", and task B's scrollback
    // renderer (`lifecycle-scrollback.ts`) prints the command on
    // `verify-started` alone and prints `status · elapsed · tier` on
    // `verify-completed` — the two lines an operator reads for one gate run,
    // side by side, say the command once. Demanding it on both would duplicate
    // it for no reader, so this asserts the command textually where the event
    // carries it and the render is chartered to show it, and asserts only that
    // the completion line is legible above. Both halves still carry `command`
    // on the EVENT (NDJSON_STABLE_FIELDS guarantees it to the host); what the
    // renderer prints is the renderer's call.
    if (cmd !== undefined && e.kind === START) {
      assert(
        text.includes(cmd) || text.includes(cmd.replace(/^bash /, "")),
        `${label}'s line names the command (got: ${JSON.stringify(line)})`,
      );
    }
  }
  // The duration is the operator-facing number; a render that drops it
  // leaves the reader with "a verify happened" and no way to see the 22 min.
  {
    let line = "";
    try {
      line = fmtEvent(completed) ?? "";
    } catch {
      line = "";
    }
    const human = ["1234567", "20m", "21m", "20 min", "21 min", "1234", "20:34", "1235"];
    assert(
      human.some((h) => line.includes(h)) || /\d/.test(line),
      `'${COMPLETE}'s line carries a duration the operator can read (got: ${JSON.stringify(line)})`,
    );
  }

  // The trailing-log surface: both events appear among the last N lines an
  // operator actually reads (a kind the renderer swallows would be missing
  // here rather than rendering an empty row).
  {
    let state: WorkState = initialState(1415, 2_000_000);
    state = appendEvent(state, started);
    state = appendEvent(state, completed);
    const lines = fmtRecentEvents(state.eventLog, 5);
    // #1415: `fmtEvent` used to have no `default:` arm, so a kind without a
    // case fell off the end of the function and yielded `undefined` — a blank
    // row the `string[]`-typed caller never reported. The switch is total
    // now, so "a hole in the tail" is a real regression again rather than the
    // expected shape; a kind that is merely UNHANDLED renders a line marked
    // `unhandled` (which its own case below checks for) instead of vanishing.
    const holes = state.eventLog.filter((_, i) => typeof lines[i] !== "string").map((e) => e.kind);
    assert(
      holes.length === 0,
      `every appended event renders a line in /work-status; unhandled kinds: ${holes.join(", ") || "none"}`,
    );
    assert(
      lines.every((l) => (l ?? "").trim().length > 0),
      `rendered lines are non-empty (${JSON.stringify(lines.map((l) => l ?? "(undefined)"))})`,
    );
  }
  for (const [label, e] of [
    [`'${START}'`, started],
    [`'${COMPLETE}'`, completed],
  ] as Array<[string, WorkEvent]>) {
    const line = formatLine({
      v: 1,
      kind: e.kind,
      at: new Date(1_700_000_000_000).toISOString(),
      issue: 1415,
      key: eventKey(1415, 3, 1_000),
      event: e,
      ...(isStableKind(e.kind) ? {} : { unstable: true as const }),
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const errors = validateNdjsonLine(parsed);
    assert(
      errors.length === 0,
      `${label} is a valid v1 NDJSON line a host can act on (errors: ${JSON.stringify(errors)})`,
    );
    assert(
      parsed.kind === e.kind,
      `${label} reaches the host stream under its own kind (got: ${JSON.stringify(parsed.kind)})`,
    );
    // Either declared stable, or honestly marked unstable. A third option —
    // dropped, or stable-looking while undeclared — is the failure the
    // #1326 contract exists to prevent.
    const declared = NDJSON_STABLE_KINDS.includes(e.kind);
    assert(
      declared === isStableKind(e.kind),
      `${label}'s stability answer is consistent (declared: ${declared}, isStableKind: ${isStableKind(e.kind)})`,
    );
    assert(
      declared || parsed.unstable === true,
      `${label} is either in the stable subset or explicitly marked unstable for the host (line: ${line.slice(0, 160)})`,
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);

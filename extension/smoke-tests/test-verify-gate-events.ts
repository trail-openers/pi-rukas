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
import { fmtElapsed, fmtEvent, fmtRecentEvents } from "../src/work-status-events.ts";
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
/** The duration the completion carries — the number this pair exists to surface. */
const MS = 1_234_567;
/** The two kinds the ticket asks for; resolved against the union, not hardcoded twice. */
const START = "verify-started";
const COMPLETE = "verify-completed";

/**
 * Build the pair through the codebase's own vocabulary.
 *
 * Goes through task B's factory, `makeVerifyRunEvents`, imported statically
 * from the module that DEFINES the pair (`workflow-state-events-verify.ts`) and
 * CALLED here — which matters for all three of the ways this function used to
 * fail silently:
 *
 *   - it looked in `workflow-state-events-verify-flake.ts`, which is the
 *     verify-TIER-OUTCOME fragment (`verify-flake-recovered`,
 *     `verify-full-status`, `consolidated-verify-skipped`) and has never
 *     exported a verify-run factory; the probe therefore always missed and
 *     always fell through to a literal;
 *   - the literal used `cmd`, which is not a field of either event — task B
 *     named it `command` — and omitted the required `target` entirely. Smoke
 *     tests are NOT type-checked (`extension/tsconfig.json` includes only
 *     `src/` and `scripts/`), so the cast to `WorkEvent` was load-bearing on
 *     nothing: the `cmd`/`target` mismatch was invisible at compile time and
 *     only surfaced as the renderer throwing on `e.target.kind`;
 *   - the literal asserted nothing about the shape, and reading its fields
 *     through a list of candidate names forgave a rename on either side — so a
 *     `command`→`cmd` rename kept it "passing" while the renderer broke.
 *
 * So: static import (a rename of the factory fails the LOAD and the whole suite
 * reports red), real call (the fixture IS the product's own shape, not a copy
 * this file invented), and direct field reads below — `e.command` / `e.ms`, the
 * names the type declares. `target` is the consolidated tree — the one the
 * develop gate actually builds.
 *
 * `at` is overridden with fixed values so the append-order assertion below has
 * a start and a completion distinguishable by position alone.
 */
function build(): { started: WorkEvent; completed: WorkEvent } {
  const pair = makeVerifyRunEvents({
    step: "develop",
    command: CMD,
    target: { kind: "consolidated" },
    status: "success",
    ms: MS,
  });
  return {
    started: { ...pair.started, at: 1_000 },
    completed: { ...pair.completed, at: 1_000 + MS },
  };
}

let started: WorkEvent | undefined;
let completed: WorkEvent | undefined;

try {
  const pair = build();
  started = pair.started;
  completed = pair.completed;
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
  // Read by the names the TYPE declares — a name-probing helper here would
  // forgive exactly the rename this file exists to catch.
  const startEvent = started as Extract<WorkEvent, { kind: typeof START }>;
  const doneEvent = completed as Extract<WorkEvent, { kind: typeof COMPLETE }>;
  assert(
    startEvent.command === CMD,
    `the start event names the command the operator is waiting for (got: ${JSON.stringify(startEvent.command)})`,
  );
  assert(
    doneEvent.command === CMD,
    `the completion event names the same command (got: ${JSON.stringify(doneEvent.command)})`,
  );
  assert(
    doneEvent.ms === MS,
    `the completion event carries the duration on its documented \`ms\` field — that number is the whole point of the pair (got: ${JSON.stringify(doneEvent.ms)})`,
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
    if (e.kind === START) {
      assert(
        text.includes(CMD) || text.includes(CMD.replace(/^bash /, "")),
        `${label}'s line names the command (got: ${JSON.stringify(line)})`,
      );
    }
  }
  // The duration is the operator-facing number; a render that drops it
  // leaves the reader with "a verify happened" and no way to see the 22 min.
  // No "any digit" fallback: the completion line carries the step name and the
  // target, both of which contain digits, so a looser test passes whether or
  // not the duration is printed at all.
  {
    let line = "";
    try {
      line = fmtEvent(completed) ?? "";
    } catch {
      line = "";
    }
    assert(
      fmtElapsed(MS) !== "" && line.includes(fmtElapsed(MS)),
      `'${COMPLETE}'s line carries the measured duration in the same form fmtElapsed renders it (${JSON.stringify(fmtElapsed(MS))}) (got: ${JSON.stringify(line)})`,
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
    // The console.warn the throwing arm prints is the only signal an operator
    // gets that a row was degraded rather than rendered; captured so the
    // mechanism is pinned, not just the fallback line.
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(" "));
    };
    let threw = false;
    let malformed: string;
    /** Which shape was fed in, so the assertion below asks the right question. */
    let shapeKind: "throws" | "coerces" = "coerces";
    try {
      // A record `validateDiscriminants` accepts (it checks only `eventLog[].kind`)
      // and whose fields are the shapes a hand-edited or half-written state file
      // carries. Two shapes, because only one of them can reach the catch:
      // a missing `command` really throws, while a non-numeric `ms` and a bogus
      // `status` merely coerce — so those are guarded inside the case itself and
      // must be asserted never to fabricate a value rather than to warn.
      if (e.kind === START) {
        shapeKind = "throws";
        malformed = fmtEvent({
          kind: START,
          at: 1,
          step: "develop",
          target: {},
        } as unknown as WorkEvent);
      } else {
        malformed = fmtEvent({
          kind: COMPLETE,
          at: 1,
          step: "develop",
          target: [],
          status: "purple",
          ms: "22 minutes",
        } as unknown as WorkEvent);
      }
    } catch (err) {
      threw = true;
      malformed = '""';
      shapeKind = "throws";
      void err;
    } finally {
      console.warn = realWarn;
    }
    assert(
      !threw,
      `${label} with a malformed target/status/ms renders instead of throwing (the #1415 panel crash)`,
    );
    if (shapeKind === "throws") {
      assert(
        warned.length === 1 && warned[0].includes(e.kind),
        `${label}'s throwing record is reported to the console naming its kind, not swallowed (warned: ${JSON.stringify(warned)})`,
      );
    } else {
      assert(
        warned.length === 0,
        `${label}'s coercing record is handled by its own guards, not by the catch (warned: ${JSON.stringify(warned)})`,
      );
    }
    const malformedText = malformed.trim();
    assert(
      malformedText.length > 0 &&
        malformedText.includes(e.kind) &&
        !/undefined|nan|\[object/.test(malformedText.toLowerCase()),
      `${label}'s malformed record degrades to a legible line naming its kind, with no fabricated value (got: ${JSON.stringify(malformed)})`,
    );
  }
  // The `unhandled` marker mechanism itself, pinned: a kind the switch has no
  // case for must render a line that says so, rather than the blank row (or the
  // `undefined`) the pre-#1415 switch produced. Without this, a regression that
  // relabels a well-formed case as `unhandled` — or drops the marker — is
  // invisible to every test in the suite.
  {
    // …and the tree half of the same disk-trust gap. `target` is what this pair
    // exists to attribute, so a malformed one must read as UNKNOWN rather than
    // fall through to the affirmative `consolidated` — a corrupt row claiming the
    // develop gate's own tree is worse than a row admitting it cannot tell.
    const shape = (target: unknown) =>
      fmtEvent({
        kind: COMPLETE,
        at: 1,
        step: "develop",
        command: CMD,
        status: "success",
        ms: 10,
        target,
      } as unknown as WorkEvent);
    for (const [label, target] of [
      ["{}", {}],
      ["an array", []],
      ["worktree with no path", { kind: "worktree" }],
      ["a bare path", { path: "/x" }],
      ["worktree with an empty path", { kind: "worktree", path: "" }],
      ["worktree with a whitespace path", { kind: "worktree", path: "   " }],
    ] as Array<[string, unknown]>) {
      const line = shape(target);
      assert(
        line.includes("(unknown)") && !line.includes("consolidated") && !/·\s+·/.test(line),
        `a malformed target (${label}) reads as unknown, never as the affirmative 'consolidated' and never as blank padding (got: ${JSON.stringify(line)})`,
      );
    }
    assert(
      shape({ kind: "consolidated" }).includes("consolidated") &&
        shape({ kind: "worktree", id: "a", path: "/x/.worktrees/issue-1415-fix" }).includes(
          "issue-1415-fix",
        ),
      `a well-formed target still renders its real tree — 'consolidated' for the probe, the basename for a worktree (got: ${JSON.stringify(shape({ kind: "consolidated" }))} / ${JSON.stringify(shape({ kind: "worktree", id: "a", path: "/x/.worktrees/issue-1415-fix" }))})`,
    );
  }
  {
    const ghost = fmtEvent({ kind: "totally-new-kind", at: 1 } as unknown as WorkEvent);
    assert(
      /^\s*totally-new-kind · unhandled/.test(ghost),
      `a kind with no case in fmtEvent's switch renders '\`<kind> · unhandled\`' — greppable, not blank (got: ${JSON.stringify(ghost)})`,
    );
    assert(
      !/undefined|nan|\[object/.test(ghost.toLowerCase()),
      `the fallback line carries no placeholder text (got: ${JSON.stringify(ghost)})`,
    );
    // And the arm is total: no kind reaches a `string[]` caller as undefined.
    const tail = fmtRecentEvents([{ kind: "totally-new-kind", at: 1 } as unknown as WorkEvent], 5);
    assert(
      tail.length === 1 && typeof tail[0] === "string" && (tail[0] ?? "").trim().length > 0,
      `fmtRecentEvents never yields a hole for an unhandled kind (got: ${JSON.stringify(tail)})`,
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

#!/usr/bin/env bun
/**
 * lean: a hung model request is ended INSIDE the cell (#2644) — the panel row.
 *
 * Three cells in three panel cycles died the same shape: a 4200 s lean deadline, one
 * model request that emitted nothing for 827 s / 1668 s / 827 s, and the harness's
 * outer wall at 5340 s taking the cell while the step was still open. Lean's deadline
 * is checked BETWEEN steps — the engine's one `deadlineStopsSteps` — so a request hung
 * INSIDE a step outlives it: no result document, no PR branch, the patch lost.
 *
 * The lever this pins lives inside the child's dispatch: a progress stream quiet for
 * the derived window with NO tool call in flight is aborted through the same
 * `AbortController` the turns/tokens levers use, and the step ends as the budget
 * verdict those levers already produce — `limit` naming the stall, so the record, the
 * handback cause line and the host's `failure` all say what stopped the child.
 *
 * No duration is a literal in this file or its fixture: the window is what
 * `requestStallWindowMs` derives from the handoff allowance plus the review reserve,
 * clamped by what the deadline still leaves.
 *
 * (a) the panel row: 4200 s cell, a child silent past every bound, the abort, the
 *     fold of its work, the `budget`/`stall` verdict, and the handback cause inside
 *     the report bound;
 * (b) a child with a tool call in flight is NEVER aborted — the whole offline gate is
 *     one silent bash for tens of minutes and #951 exists for exactly that;
 * (c) the window is the reserve, clamped by the time left, and absent with no deadline
 *     or no room — never a zero timer;
 * (d) the lever discloses itself as inert (a trace line) when caps are off.
 */

import { budgetTrio } from "../src/lean/step-budget.ts";
import { neededFromLog } from "../src/lean/handback.ts";
import { leanIssueResult } from "../src/headless/work-lean-result.ts";
import { INITIAL_COUNTERS, type LeanRun, type Outcome, type Step } from "../src/lean/state.ts";
import { inertWarning, requestStallWindowMs } from "../src/request-stall-policy.ts";
import { REVIEW_DEADLINE_RESERVE_MS } from "../src/lean/review-bound.ts";
import { MINUTE_MS } from "../src/lean/deadline.ts";
import { withEnv } from "./lib/env-scope.ts";
import {
  HUNG_REQUEST_MS,
  PANEL_CELL_S,
  PANEL_START_MS,
  PINNED_ALLOWANCE_MS,
  cellAt,
  handoffReportBoundMs,
  reserveMs,
  stallEnv,
} from "./lib/lean-request-stall-fixture.ts";
import { runBuild } from "./lib/lean-build-fixture.ts";
import type { QuietTickReport } from "./lib/lean-quiet-child-tick.ts";
import { put } from "./lib/lean-build-git.ts";
import { configWithRunner } from "./lib/lean-build-asserts.ts";
import { defaultConfig } from "../src/lean/config.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureWarns } from "./lib/lean-review-bound-fixtures.ts";
import { installLensSkills, stubLensSpawn } from "./lib/lens-stub-spawn.ts";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    failed = 1;
  }
}

/** The build config with its own ceiling levers off — the stall is the only lever. */
function stallOnlyConfig() {
  return {
    ...configWithRunner(),
    budgets: { ...defaultConfig().budgets, build: { turns: 0, tokens: 0, minutes: 0 } },
  };
}

/** The child's own stream stamp: how long the fake child has been quiet. The step's stall
 *  lever measures THIS and fires its own abort — the fixture hands the step nothing. */
function silent(ms: number): number {
  return ms;
}

const PANEL_NOW = cellAt(PANEL_CELL_S - 60);

// ── (a) THE PANEL ROW ────────────────────────────────────────────────────────
{
  let hung: Awaited<ReturnType<typeof runBuild>> | undefined;
  let hungTick: QuietTickReport | undefined;
  await withEnv(stallEnv(), async () => {
    hung = await runBuild({
      issue: 2644,
      config: stallOnlyConfig(),
      clock: { deadlineMs: PANEL_START_MS + PANEL_CELL_S * MINUTE_MS, now: () => PANEL_NOW },
      // The child wrote its implementation; then its request hung and the stream
      // never came back — the field's 1668 s of silence.
      child: (wt) => put(wt, "src/stall.ts", "export const stall = () => 1;\n"),
      silentMs: silent(HUNG_REQUEST_MS),
      quietTick: (r) => {
        hungTick = r;
      },
    });
  });
  // The canary that keeps this cell from being the fixture deciding its own verdict: the poll ran,
  // supervised for its own bounded wait, and was the only thing that could have fired the arm.
  assert(
    hungTick?.supervised === true && hungTick.supervisedMs() > 0,
    `(a) canary: the spawn's own poll supervised the hung child for ${String(hungTick?.supervisedMs())} ms`,
  );
  assert(
    (hungTick?.fires() ?? -1) === 1,
    `(a) the poll handed the breach to the step's freezing of the verdict exactly once (got ${String(hungTick?.fires())})`,
  );

  assert(
    hung?.threw === undefined,
    `(a) a stalled child is a verdict, not infrastructure: ${(hung.threw ?? { message: "clean" }).message}`,
  );
  assert(
    hung!.outcome?.kind === "budget",
    `(a) the step ends as its budget verdict, the kind the table already routes (got ${String(hung!.outcome?.kind)})`,
  );
  const fired = budgetTrio(hung!.outcome as Outcome | undefined);
  assert(
    fired?.limit === "stall",
    `(a) the trio names the stall as the ceiling that fired (got ${JSON.stringify(fired)})`,
  );
  assert(
    fired !== undefined && fired.used >= Math.floor(HUNG_REQUEST_MS / MINUTE_MS),
    `(a) the trio's \`used\` is the silence measured, not a guess (got ${String(fired?.used)} min, field measured ${String(Math.round(HUNG_REQUEST_MS / MINUTE_MS))} min)`,
  );
  assert(
    hung!.headAfter !== hung!.headBefore,
    "(a) the hung child's work is folded into the attempt's commit — the cell keeps its patch",
  );

  // The two surfaces an operator and a host read. Both are rendered from the trio,
  // so both must name the stall rather than a generic timeout.
  const steps: Step[] = [
    {
      key: "2644:build:0",
      state: "build",
      startedAt: PANEL_NOW,
      endedAt: PANEL_NOW + HUNG_REQUEST_MS,
      outcome: hung!.outcome,
    },
  ];
  const needed = neededFromLog(steps);
  assert(
    /stall/i.test(needed),
    `(a) the handback's cause line names the stall (${JSON.stringify(needed)})`,
  );
  const run: LeanRun = {
    schema: 1,
    issue: 2644,
    version: "test",
    models: {},
    baseSha: "sha",
    branch: "lean/issue-2644",
    state: "handed-back",
    counters: { ...INITIAL_COUNTERS },
    steps,
    deadlineMs: PANEL_NOW + 60 * MINUTE_MS,
    result: { code: 10, reason: needed },
  };
  const failure = leanIssueResult(run, 10).failure as
    | { kind?: string; message?: string }
    | undefined;
  assert(
    failure?.kind === "timeout" && /stall/i.test(failure.message ?? ""),
    `(a) the host document says a stall ended the run, not a crash (${JSON.stringify(failure)})`,
  );
  // The row's last claim: the handback ran rather than the outer wall. The hung child
  // ended at its window and the report ran inside the bound the engine gives it.
  const reportedAt = PANEL_NOW + reserveMs();
  assert(
    reportedAt <=
      run.deadlineMs! - PINNED_ALLOWANCE_MS + handoffReportBoundMs(),
    `(a) the handback ran inside the deadline plus the report bound (${String(reportedAt - run.deadlineMs!)} ms past the line, bound ${String(handoffReportBoundMs())} ms)`,
  );
}

// ── (b) a tool call in flight is not a stall ─────────────────────────────────
{
  // The two cells are the SAME child — same edit, same declared silence — and differ only in the
  // lines its stream carried. There is no `toolInFlight` switch to set: the in-flight reading is the
  // real `InFlightTools`'s own, fed by the child's `toolCall` line through the real stdout pump.
  // That is the difference between pinning #951 and describing it: an earlier fixture let a case
  // assert the exemption and stay green with the exemption deleted from production.
  let ran: Awaited<ReturnType<typeof runBuild>> | undefined;
  let ranTick: QuietTickReport | undefined;
  await withEnv(stallEnv(), async () => {
    ran = await runBuild({
      issue: 2645,
      config: stallOnlyConfig(),
      clock: { deadlineMs: PANEL_START_MS + PANEL_CELL_S * MINUTE_MS, now: () => PANEL_NOW },
      // A full offline suite is one silent bash for tens of minutes; the in-flight
      // set is what tells that apart from a hung request (#951). `child` is the same
      // edit case (a) makes, so the ONLY variable between the two cells is the tool call.
      child: (wt) => put(wt, "src/stall.ts", "export const stall = () => 1;\n"),
      toolUses: [{ name: "bash", arguments: { command: "bun run test" } }],
      silentMs: silent(HUNG_REQUEST_MS),
      quietTick: (r) => {
        ranTick = r;
      },
    });
  });
  assert(
    ranTick?.supervised === true,
    "(b) canary: the spawn's own poll supervised this child (a poll that never ran is not a held fire)",
  );
  assert(
    ranTick?.inFlight() === true,
    "(b) canary: the real InFlightTools still holds the child's call open when the poll finished",
  );
  assert(
    (ranTick?.fires() ?? -1) === 0,
    `(b) canary: the poll was ASKED and answered nothing (the step's fire ran ${String(ranTick?.fires())} times)`,
  );
  assert(
    ran?.outcome?.kind === "ok",
    `(b) a silent child WITH a tool in flight finishes its work (got ${String(ran.outcome?.kind)})`,
  );
  // The other half of the pair, and the half that makes the cell above non-vacuous: the same child
  // whose call the stream ANSWERS, under the identical silence. The tracker then holds nothing
  // open, so nothing stands the check down and the exemption can only be what the production
  // reading says it is.
  let live: Awaited<ReturnType<typeof runBuild>> | undefined;
  let liveTick: QuietTickReport | undefined;
  await withEnv(stallEnv(), async () => {
    live = await runBuild({
      issue: 2646,
      config: stallOnlyConfig(),
      clock: { deadlineMs: PANEL_START_MS + PANEL_CELL_S * MINUTE_MS, now: () => PANEL_NOW },
      child: (wt) => put(wt, "src/stall.ts", "export const stall = () => 1;\n"),
      // The same shape as the cell above — a real `bash` call the child opened — plus the
      // `toolResult` the cell above never sends. With the result in the stream the tracker holds
      // NOTHING open and the reader reports the silence its own clock measured; deleting #951 from
      // `stallBreach` cannot make this cell green, and it cannot make the cell above green either.
      toolUses: [{ name: "bash", arguments: { command: "bun run test" } }],
      extraLines: [
        {
          type: "message_end",
          message: { role: "toolResult", toolCallId: "tc-0", toolName: "bash", isError: false },
        },
      ],
      silentMs: silent(HUNG_REQUEST_MS),
      quietTick: (r) => {
        liveTick = r;
      },
    });
  });
  assert(
    liveTick?.inFlight() === false,
    "(b) canary: this child has nothing open, so the ONLY difference from the cell above is the stream",
  );
  assert(
    (liveTick?.fires() ?? -1) === 1,
    `(b) the same silence WITHOUT a call in flight DOES breach — the exemption is the reader's, not a value the case wrote (the step's fire ran ${String(liveTick?.fires())} times)`,
  );
  assert(
    live?.outcome?.kind === "budget",
    `(b) and the frozen verdict is the stall (got ${String(live.outcome?.kind)})`,
  );
}

// ── (c) the window: the reserve, clamped, never zero ─────────────────────────
{
  await withEnv(stallEnv(), async () => {
    const deadline = PANEL_START_MS + PANEL_CELL_S * MINUTE_MS;
    const early = requestStallWindowMs(deadline, PANEL_START_MS + 60 * MINUTE_MS, REVIEW_DEADLINE_RESERVE_MS);
    assert(
      early === reserveMs(),
      `(c) with room to spare the window is the review reserve read through the helpers (got ${String(early)}, reserve ${String(reserveMs())} = allowance + review reserve)`,
    );
    const late = PANEL_START_MS + (PANEL_CELL_S - 20) * MINUTE_MS;
    const clamped = requestStallWindowMs(deadline, late, REVIEW_DEADLINE_RESERVE_MS);
    assert(
      clamped === deadline - late - PINNED_ALLOWANCE_MS,
      `(c) near the line the window is what the deadline leaves MINUS the allowance (got ${String(clamped)})`,
    );
    const none = requestStallWindowMs(
      deadline,
      PANEL_START_MS + (PANEL_CELL_S - 5) * MINUTE_MS,
      REVIEW_DEADLINE_RESERVE_MS,
    );
    assert(
      none === undefined,
      `(c) no room outside the allowance means NO window rather than a zero timer (got ${String(none)})`,
    );
    assert(
      requestStallWindowMs(undefined, PANEL_START_MS, REVIEW_DEADLINE_RESERVE_MS) === undefined,
      "(c) with no resolved deadline the lever is not armed",
    );
  });
}

// ── (d) caps off: the lever says so on the trace ─────────────────────────────
{
  const deadline = PANEL_START_MS + PANEL_CELL_S * MINUTE_MS;
  const warns: string[] = [];
  await captureWarns("stall", warns, async () => {
    // The step's own trace, not a helper call from the test: the disclosure is the
    // step's, and an absent line would be silence mistaken for a pass.
    await withEnv({ ...stallEnv(), PI_ENSEMBLE_DISPATCH_CAPS: "0" }, () =>
      runBuild({
        issue: 2647,
        config: stallOnlyConfig(),
        clock: { deadlineMs: deadline, now: () => PANEL_NOW },
        child: (wt) => put(wt, "src/stall.ts", "export const stall = () => 1;\n"),
        silentMs: silent(HUNG_REQUEST_MS),
      }),
    );
  });
  assert(
    warns.some((w) => /stall/i.test(w) && /PI_ENSEMBLE_DISPATCH_CAPS=0/.test(w)),
    `(d) the trace discloses the lever as inert rather than reporting a bound that held (${JSON.stringify(warns)})`,
  );
}

// ── (e) the composer of the step's inertness line ───────────────────────
{
  // `armBudget` is the only production caller and never inspects the answer, so the join rule is
  // pinned here: the minutes half first, a silent half says nothing, both silent is NO warning.
  const minutes = "20-minute budget is inert: PI_ENSEMBLE_DISPATCH_CAPS=0";
  const stall = "request stall bound is inert: no cycle deadline";
  const capsOff = async (body: () => void) =>
    withEnv({ PI_ENSEMBLE_DISPATCH_CAPS: "0", PI_ENSEMBLE_LEAN_REQUEST_STALL: "1" }, body);
  await capsOff(async () => {
    assert(
      inertWarning(20, stall) === `${minutes}; ${stall}`,
      "(e) both halves ride one line, minutes first, joined by '; '",
    );
    assert(
      inertWarning(20, undefined) === minutes && inertWarning(0, stall) === stall,
      "(e) a silent half contributes nothing to the line",
    );
    assert(
      inertWarning(0, undefined) === undefined,
      "(e) both silent means no warning field at all, not an empty one",
    );
  });
  const capsOn = async (body: () => void) =>
    withEnv({ PI_ENSEMBLE_DISPATCH_CAPS: undefined, PI_ENSEMBLE_LEAN_REQUEST_STALL: "1" }, async () => {
      body();
    });
  await capsOn(() =>
    assert(
      inertWarning(20, stall) === stall,
      `(e) with the caps on the minutes lever arms and only the stall half speaks (got ${JSON.stringify(inertWarning(20, stall))})`,
    ),
  );
}

process.exit(failed);

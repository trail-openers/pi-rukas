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
import { put } from "./lib/lean-build-artifacts.ts";
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
  await withEnv(stallEnv(), async () => {
    hung = await runBuild({
      issue: 2644,
      config: stallOnlyConfig(),
      clock: { deadlineMs: PANEL_START_MS + PANEL_CELL_S * MINUTE_MS, now: () => PANEL_NOW },
      // The child wrote its implementation; then its request hung and the stream
      // never came back — the field's 1668 s of silence.
      child: (wt) => put(wt, "src/stall.ts", "export const stall = () => 1;\n"),
      silentMs: silent(HUNG_REQUEST_MS),
    });
  });

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
  let ran: Awaited<ReturnType<typeof runBuild>> | undefined;
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
    });
  });
  assert(
    ran?.outcome?.kind === "ok",
    `(b) a silent child WITH a tool in flight finishes its work (got ${String(ran.outcome?.kind)})`,
  );
  // The reading above is the production reader's own — `spawn-inactivity-poll.ts`'s `stallLever` over a
  // real `InFlightTools`, fed the child's stream events — so the arm is pinned from both sides:
  // a stream that reports a call in flight is never quiet, whatever the case's declared silence.
  let live: Awaited<ReturnType<typeof runBuild>> | undefined;
  await withEnv(stallEnv(), async () => {
    live = await runBuild({
      issue: 2646,
      config: stallOnlyConfig(),
      clock: { deadlineMs: PANEL_START_MS + PANEL_CELL_S * MINUTE_MS, now: () => PANEL_NOW },
      child: (wt) => put(wt, "src/stall.ts", "export const stall = () => 1;\n"),
      // No declared call, but the stream says one is running — the state a child reaches while a
      // tool result is still to come. The check must stand down on the production reading alone.
      toolInFlight: true,
      silentMs: silent(HUNG_REQUEST_MS),
    });
  });
  assert(
    live?.outcome?.kind === "ok",
    `(b) and the production reader's own in-flight bit is what stands the check down — not the case's tool list (got ${String(live.outcome?.kind)})`,
  );
}

// ── (b2) the step's lever reaches the children whose spawn options are built elsewhere ──
// The review step arms ONE budget and hands it to seams that build their own spawn options by
// hand: the six lens children (`runLensChild`), the adversarial reviewer (`makeRunPhase`) and the
// fixer (`runFixer`). A spread of `budget.opts` delivers the lever to neither of the first two —
// those files construct a literal, they do not spread — so the window travels as data and each
// child puts `stall` on its own spawn. Asserted on what the SPAWN RECEIVED: an assertion on the
// arm's `opts` would pass with the threading deleted, which is how it shipped for a round.
{
  const calls = stubLensSpawn();
  const { armBudget } = await import("../src/lean/step-budget.ts");
  const { reviewDeps } = await import("../src/lean/review-deps.ts");
  const { runLensChild } = await import("../src/lens-review-child.ts");
  const { makeRunPhase } = await import("../src/adversarial-phase.ts");

  const windowMinutes = Math.ceil(reserveMs() / MINUTE_MS);
  /** The lever the step arms for a cell with room to spare — a real `armBudget`, not a fixture's.
   *  A cell begun at `PANEL_START_MS` with the deadline a full cell gives it leaves the reserve
   *  outside the handoff allowance, which is exactly when the window IS the reserve. */
  const armStall = () =>
    armBudget(
      { minutes: 0, turns: 0, tokens: 0 },
      {
        reserveMs: REVIEW_DEADLINE_RESERVE_MS,
        silence: () => ({ sinceMs: 0, toolInFlight: false }),
        deadlineMs: PANEL_START_MS + PANEL_CELL_S * MINUTE_MS,
        startedAt: PANEL_START_MS,
      },
    );

  // The seam, then the child it feeds: the seam can thread a field the child drops, and a child can
  // read an arm no seam ever sent.
  let lensOpts: Record<string, unknown> | undefined;
  await withEnv(stallEnv(), async () => {
    const deps = reviewDeps(false);
    // The seam is the LAYER BELOW `lensChildFn`: `reviewDeps().lens` builds the `runLensReview`
    // options, and `runLensReview` is what spreads them into the per-lens child's opts. Stubbing
    // `lensChildFn` would capture the engine's own reshaping and could not fail when the seam
    // dropped the field, so this drives the real engine and records what IT was handed.
    deps.lensEngine = (async (o: Record<string, unknown>) => {
      lensOpts = o;
      return { verdict: "APPROVED", findings: [], advisory: [], lenses: [], usage: undefined } as never;
    }) as never;
    await deps.lens({
      base: "0123456789abcdef0123456789abcdef01234567",
      head: "0123456789abcdef0123456789abcdef01234568",
      branch: "lean/issue-2644",
      cwd: "/tmp",
      wave: "full",
      pr: undefined,
      context: "ctx",
      evidence: undefined,
      extraFindings: [],
      headless: false,
      budget: armStall(),
    });
  });
  assert(
    lensOpts?.stallWindowMinutes === windowMinutes,
    `(b2) the lens seam hands the per-lens child the step's armed window (captured ${JSON.stringify(
      lensOpts?.stallWindowMinutes,
    )}, expected ${String(windowMinutes)})`,
  );

  calls.length = 0;
  // A real skills dir: `runLensChild` blocks a lens whose SKILL.md is missing BEFORE any spawn, so
  // a non-existent dir would make this assertion green for the wrong reason (no spawn at all).
  const skills = mkdtempSync(path.join(tmpdir(), "stall-skills-"));
  installLensSkills(skills);
  await withEnv(stallEnv(), async () => {
    await runLensChild({
      lens: { name: "SECURITY", skill: "code-review-security", precedence: 10 },
      runId: "run-2644",
      skillsDir: skills,
      context: "",
      roster: [],
      opts: { diff: "", cwd: "/tmp", stallWindowMinutes: windowMinutes },
      bumpBatch: () => {},
    });
  });
  rmSync(skills, { recursive: true, force: true });
  const lensSpawn = calls.find((c) => c.role === "code-review-specialist");
  assert(
    (lensSpawn?.stall as { windowMinutes?: number } | undefined)?.windowMinutes === windowMinutes,
    `(b2) and the lens child's own spawn carried the lever — its wall clock is not the only lever it has (captured ${JSON.stringify(
      lensSpawn?.stall,
    )})`,
  );

  // The reviewer's phase: the same rule one layer down, on the spawn `makeRunPhase` builds itself.
  calls.length = 0;
  await withEnv(stallEnv(), async () => {
    const phase = makeRunPhase({
      runId: "run-2644",
      signal: new AbortController().signal,
      orchestratorJobId: "job-2644",
      processGroup: true,
      childBoundMs: 30 * 60_000,
      stallWindowMinutes: windowMinutes,
    } as never);
    await phase("adversarial-developer", "review", "prompt", "/tmp");
  });
  const reviewerSpawn = calls.find((c) => c.role === "adversarial-developer");
  assert(
    (reviewerSpawn?.stall as { windowMinutes?: number } | undefined)?.windowMinutes ===
      windowMinutes,
    `(b2) the reviewer's spawn carries the lever too — a hung request in the gate is the #2644 shape (captured ${JSON.stringify(
      reviewerSpawn?.stall,
    )})`,
  );

  // With no lever armed nothing carries one: an absent arm stays absent rather than becoming a
  // zero-minute timer that ends the child the instant it starts.
  calls.length = 0;
  await withEnv(stallEnv(), async () => {
    const phase = makeRunPhase({
      runId: "run-2644",
      signal: new AbortController().signal,
      orchestratorJobId: "job-2644",
      processGroup: true,
    } as never);
    await phase("adversarial-developer", "review", "prompt", "/tmp");
  });
  assert(
    calls.find((c) => c.role === "adversarial-developer")?.stall === undefined,
    "(b2) with no armed lever the reviewer's spawn options are those it had before this change",
  );

  // (b3) the enforced threshold is the DERIVED window, not the minutes a verdict prints. A step
  // near its deadline derives a sub-minute window; rounding it up to a whole minute and enforcing
  // THAT would let a hung request sit past the time the deadline leaves, and the verdict would
  // print a bound that never held. Same arms, two different fields, each carrying its own job.
  const SUB_MINUTE_MS = 40_000;
  const sub = armBudget(
    { minutes: 0, turns: 0, tokens: 0 },
    {
      reserveMs: REVIEW_DEADLINE_RESERVE_MS,
      silence: () => ({ sinceMs: 0, toolInFlight: false }),
      // The deadline sits SUB_MINUTE_MS past the handoff allowance from `startedAt`, so the window
      // the step derives — the one the poll enforces — is that sub-minute remainder.
      deadlineMs: PANEL_NOW + PINNED_ALLOWANCE_MS + SUB_MINUTE_MS,
      startedAt: PANEL_NOW,
    },
  ).opts.stall;
  assert(
    sub?.windowMs === SUB_MINUTE_MS,
    `(b3) the window enforced is the one the step derived (got ${String(sub?.windowMs)} ms)`,
  );
  assert(
    sub?.windowMinutes === Math.ceil(SUB_MINUTE_MS / MINUTE_MS),
    `(b3) …while the verdict still prints whole minutes, never 0 (got ${String(sub?.windowMinutes)})`,
  );
  assert(
    sub?.windowMinutes !== undefined && sub.windowMinutes * MINUTE_MS > sub.windowMs,
    "(b3) the two disagree by construction here, so a mutant enforcing the minutes is caught",
  );

}

// ── (b4) THE FIELD SHAPE: a child that already worked is still stallable ─────
// Three cells died with a developer that had written code, run tests and spent tokens for
// dozens of turns BEFORE its request hung. An arm that decides off the child's turn or token
// count is an arm that only ever catches a child that died before its first turn — which is no
// cell from the field. The progress snapshot here carries the child's REAL counts (the fixture
// hands over what the case declares), so the lever is judged on the reading a real spawn gives it.
{
  /** A developer that did real work: turns and tokens, then silence. */
  const WORKED = { turns: 14, totalTokens: 250_000 };
  let hung: Awaited<ReturnType<typeof runBuild>> | undefined;
  await withEnv(stallEnv(), async () => {
    hung = await runBuild({
      issue: 2648,
      config: stallOnlyConfig(),
      clock: { deadlineMs: PANEL_START_MS + PANEL_CELL_S * MINUTE_MS, now: () => PANEL_NOW },
      child: (wt) => put(wt, "src/stall.ts", "export const stall = () => 1;\n"),
      worked: WORKED,
      silentMs: silent(HUNG_REQUEST_MS),
    });
  });
  assert(
    hung?.outcome?.kind === "budget",
    `(b4) a child that had completed turns and spent tokens is still ended as a stall, the field shape (got ${String(hung!.outcome?.kind)})`,
  );
  const b4 = budgetTrio(hung!.outcome as Outcome | undefined);
  assert(
    b4?.limit === "stall",
    `(b4) and the trio names the stall rather than nothing (got ${JSON.stringify(b4)})`,
  );
  assert(
    hung!.headAfter !== hung!.headBefore,
    "(b4) the worked child's patch is kept, like the panel row",
  );

  // …and the two exemptions still hold for THAT child, not only for a pristine one.
  let live: Awaited<ReturnType<typeof runBuild>> | undefined;
  await withEnv(stallEnv(), async () => {
    live = await runBuild({
      issue: 2649,
      config: stallOnlyConfig(),
      clock: { deadlineMs: PANEL_START_MS + PANEL_CELL_S * MINUTE_MS, now: () => PANEL_NOW },
      child: (wt) => put(wt, "src/stall.ts", "export const stall = () => 1;\n"),
      worked: WORKED,
      toolInFlight: true,
      silentMs: silent(HUNG_REQUEST_MS),
    });
  });
  assert(
    live?.outcome?.kind === "ok",
    `(b4) the same worked child with a tool in flight is not a stall (got ${String(live.outcome?.kind)})`,
  );
  let quick: Awaited<ReturnType<typeof runBuild>> | undefined;
  await withEnv(stallEnv(), async () => {
    quick = await runBuild({
      issue: 2650,
      config: stallOnlyConfig(),
      clock: { deadlineMs: PANEL_START_MS + PANEL_CELL_S * MINUTE_MS, now: () => PANEL_NOW },
      child: (wt) => put(wt, "src/stall.ts", "export const stall = () => 1;\n"),
      worked: WORKED,
      // Half the window: inside it the lever holds its fire whatever the child did before.
      silentMs: silent(Math.floor(HUNG_REQUEST_MS / 2)),
    });
  });
  assert(
    quick?.outcome?.kind === "ok",
    `(b4) the same worked child, quiet inside the window, finishes (got ${String(quick.outcome?.kind)})`,
  );
}

// ── (b5) a ceiling that is exceeded outranks the stall, and a turn tick is never a stall ─
// The two rules the zero guard was imitating, pinned without the guard: the turns / tokens
// ceilings must still win on the tick that crosses them, and a tick that arrives AFTER a long
// quiet (the first message back, carrying a tool call) must not be read as a stall — the
// progress tracker has not yet seen that line, so the silence the reader reports is stale.
{
  const { armBudget } = await import("../src/lean/step-budget.ts");
  const { emptyRunningState } = await import("../src/progress.ts");
  const deadlineMs = PANEL_START_MS + PANEL_CELL_S * MINUTE_MS;
  const arms = () => ({
    reserveMs: REVIEW_DEADLINE_RESERVE_MS,
    silence: () => ({ sinceMs: HUNG_REQUEST_MS, toolInFlight: false }),
    deadlineMs,
    startedAt: PANEL_START_MS,
  });
  const snapshot = (turns: number, totalTokens: number) => ({
    ...emptyRunningState("developer"),
    turns,
    totalTokens,
  });

  // Turns ceiling exceeded on the same tick the child is also quiet past the window.
  const bothTurns = armBudget({ minutes: 0, turns: 3, tokens: 0 }, arms());
  bothTurns.opts.onProgress?.(snapshot(9, 0));
  const turnsVerdict = bothTurns.fired({ role: "developer", ok: true, ms: 1 });
  assert(
    turnsVerdict?.limit === "turns",
    `(b5) a turns ceiling that is exceeded still wins over the stall (got ${JSON.stringify(turnsVerdict)})`,
  );

  const bothTokens = armBudget({ minutes: 0, turns: 0, tokens: 1000 }, arms());
  bothTokens.opts.onProgress?.(snapshot(2, 9_999));
  const tokensVerdict = bothTokens.fired({ role: "developer", ok: true, ms: 1 });
  assert(
    tokensVerdict?.limit === "tokens",
    `(b5) a tokens ceiling that is exceeded still wins over the stall (got ${JSON.stringify(tokensVerdict)})`,
  );

  // The tick the rule exists for: the child was quiet past the window and then its first
  // message back arrives, carrying a tool call. That tick is not a stall, whatever the reader
  // says, because the tracker has not observed this line yet.
  const turnTick = armBudget({ minutes: 0, turns: 0, tokens: 0 }, arms());
  turnTick.opts.onProgress?.(snapshot(1, 0));
  assert(
    turnTick.fired({ role: "developer", ok: true, ms: 1 }) === undefined,
    `(b5) a turn tick after a long quiet never freezes a stall verdict (got ${JSON.stringify(turnTick.fired({ role: "developer", ok: true, ms: 1 }))})`,
  );
  turnTick.opts.onProgress?.(snapshot(7, 120_000));
  assert(
    turnTick.fired({ role: "developer", ok: true, ms: 1 }) === undefined,
    "(b5) nor does one on a child that had worked for turns and tokens",
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

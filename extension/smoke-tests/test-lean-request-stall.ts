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
import { requestStallWindowMs } from "../src/request-stall-policy.ts";
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
  // The reading above is the production reader's own — `spawn-inflight.ts`'s `stallLever` over a
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
  /** The lever the step arms for a cell with room to spare — a real `armBudget`, not a fixture's. */
  const armStall = () =>
    armBudget(
      { minutes: 0, turns: 0, tokens: 0 },
      {
        windowMs: reserveMs(),
        silence: () => ({ sinceMs: 0, toolInFlight: false }),
        deadlineMs: PANEL_START_MS + PANEL_CELL_S * MINUTE_MS,
        now: PANEL_NOW,
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

process.exit(failed);

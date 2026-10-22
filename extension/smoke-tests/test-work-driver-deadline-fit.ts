#!/usr/bin/env bun
/**
 * #1567 item 6 — deadline, partial fit (#1447, #1547, #1242).
 *
 * janit/tehas cycle 37-261016-175224 started `lens-fix` with 35m29s left of
 * its caller deadline; the child ran 2,098 s and the cap fired only when it
 * returned, past the deadline. The policy: clamp a step to the remaining time
 * while at least 15 min (develop, lens-fix) or 10 min (lens) of useful time is
 * left — the deadline less the handoff grace — otherwise park
 * `deadline:no-fit`; every child gets `min(own bound, deadline − now − grace)`.
 * The review loop's own 90-min clock gets the same minimums: a lens round was
 * started at 84 of 90 min and ran 27 (#1242), and a lens-fix with ≤ 9 min
 * left ran with no loop bound at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clampToCycleDeadline,
  noteCycleDeadline,
  runWithCycleClock,
} from "../src/cycle-deadline-clock.ts";
import { FIXED_CAPS } from "../src/headless/caps.ts";
import { deadlineCheck } from "../src/work-driver-deadline.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import {
  MIN_FIX_DISPATCH_MS,
  parkLensFixOverrun,
  parkLensRoundNoFit,
  reviewFixDispatchBoundMs,
} from "../src/work-driver-lens-fix-budget.ts";
import { runLens } from "../src/work-driver-lens.ts";
import { terminalReasonAtHandoff } from "../src/work-driver-terminal-reason.ts";
import { humanActionFor } from "../src/work-queue.ts";
import type { WorkStep } from "../src/workflow-state-events.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string, detail?: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}${detail ? `\n  ${detail}` : ""}`);
    exit = 1;
  }
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const GRACE = 8 * MIN; // handoffDispatchTimeoutMs() default
const T0 = 1_792_188_075_000; // cycle 37's lens-fix start, epoch ms
const tmp = mkdtempSync(path.join(tmpdir(), "pi-ens-deadline-fit-"));
const ctx = {
  repoRoot: tmp,
  issue: 1447,
  host: { sendUserMessage: () => {}, sendUserMessageAsync: () => {}, emit: () => {} },
} as unknown as Parameters<typeof deadlineCheck>[0];
delete process.env.PI_ENSEMBLE_CYCLE_BUDGET_MS;
delete process.env.PI_ENSEMBLE_HANDOFF_TIMEOUT_MS;
delete process.env.PI_ENSEMBLE_REVIEW_ENFORCE;
delete process.env.PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS;

async function checkAt(step: WorkStep, usefulMs: number) {
  process.env.PI_ENSEMBLE_CYCLE_DEADLINE = String(T0 + GRACE + usefulMs);
  const r = await deadlineCheck(ctx, initialState(1447, 1) as WorkState, step, T0);
  const tail = r.state.eventLog[r.state.eventLog.length - 1];
  return { r, cap: tail?.kind === "cap-hit" ? tail : undefined };
}

try {
  // 1. The boundary: each step's minimum of useful time.
  for (const [step, need] of [
    ["develop", 15 * MIN],
    ["lens-fix", 15 * MIN],
    ["lens-review", 10 * MIN],
  ] as const) {
    const short = await checkAt(step, need - 1);
    assert(
      short.r.parked && short.cap?.cap === "deadline:no-fit" && short.cap.nextStep === "handoff",
      `${step} with 1 ms less than ${need / MIN} min of useful time parks deadline:no-fit`,
    );
    assert(
      (short.cap?.evidence ?? "").includes(`"${step}" needs at least ${need}ms`) &&
        (short.cap?.evidence ?? "").includes(`${need - 1}ms of useful time remained`),
      `…and the evidence names the step, the time left and the time it needed`,
      short.cap?.evidence,
    );
    const fits = await checkAt(step, need);
    assert(!fits.r.parked && !fits.cap, `${step} with exactly ${need / MIN} min starts`);
  }
  const adv = await checkAt("adversarial", MIN);
  assert(!adv.r.parked, "a step with no minimum starts with any useful time left");
  const none = await checkAt("develop", 0);
  assert(
    none.cap?.cap === "deadline",
    "no useful time left at all is still the plain `deadline` cap, not no-fit",
  );

  // The #1447 shape: 35m29s to the deadline, 8 min grace → 27m29s useful.
  const cycle37 = await checkAt("lens-fix", 35 * MIN + 29_000 - GRACE);
  assert(!cycle37.r.parked, "cycle 37's lens-fix (27m29s useful) fits, so it starts…");
  await runWithCycleClock(async () => {
    const deadline = T0 + 35 * MIN + 29_000;
    noteCycleDeadline(deadline, GRACE, "lens-fix");
    const c = clampToCycleDeadline(30 * MIN, T0);
    assert(
      c.clamped && c.timeoutMs === deadline - T0 - GRACE,
      `…and its child is bounded at deadline − now − grace (${c.timeoutMs}ms), not its 30-min bound, nor the 2,098 s it ran`,
    );
  });

  // 2. A step that ran into deadline − grace is ended by the deadline.
  {
    const deadline = T0 + HOUR;
    let s = initialState(1447, 1) as WorkState;
    s = appendEvent(s, { kind: "step-started", step: "lens-fix", at: T0 });
    s = appendEvent(s, {
      kind: "cap-hit",
      at: deadline - GRACE + 1,
      cap: "verify-failed:develop",
      reviewRound: 1,
      nextStep: "handoff",
    });
    const out = terminalReasonAtHandoff(s, deadline, deadline - GRACE + 1, GRACE);
    const tail = out.eventLog[out.eventLog.length - 1];
    assert(
      tail?.kind === "cap-hit" &&
        tail.cap === "deadline" &&
        /passed while step "lens-fix"/.test(tail.evidence ?? ""),
      "a step that ended past deadline − grace records `deadline` after its own verdict",
    );
    const earlier = terminalReasonAtHandoff(s, deadline, deadline - GRACE - 1, GRACE);
    assert(earlier === s, "…and one that ended before it keeps its verdict");
  }

  // 3. The cap is a known, published, explained literal.
  {
    const s = initialState(1447, 1) as WorkState;
    s.pipelineState.currentStep = "handoff";
    s.eventLog.push({
      kind: "cap-hit",
      at: 1,
      cap: "deadline:no-fit",
      reviewRound: 0,
      nextStep: "handoff",
      evidence:
        'caller deadline 1 (absolute epoch ms); 60000ms of useful time remained after the 480000ms handoff grace, and "develop" needs at least 900000ms — step "develop" not started',
    });
    assert(validateDiscriminants(s).length === 0, "the validator accepts deadline:no-fit");
    assert(
      (FIXED_CAPS as readonly string[]).includes("deadline:no-fit"),
      "the headless vocabulary publishes it",
    );
    const ex = explainCap("deadline:no-fit", s);
    assert(
      ex.includes("too little time") && ex.includes("--restart"),
      "explainCap has its own sentence",
      ex,
    );
    const action = humanActionFor("cap deadline:no-fit", 1447);
    assert(
      action.includes("PI_ENSEMBLE_CYCLE_DEADLINE"),
      "the queue gives the deadline action",
      action,
    );
  }

  // 4. The review loop's own clock (#1242).
  {
    const CAP = 90 * MIN;
    const at = (elapsed: number, round = 1): WorkState => {
      const s = initialState(1242, 1) as WorkState;
      return {
        ...s,
        pipelineState: { ...s.pipelineState, reviewRound: round, reviewCapStartedAt: T0 - elapsed },
      };
    };
    assert(
      reviewFixDispatchBoundMs(at(CAP - 5 * MIN), "lens-fix", T0) === MIN_FIX_DISPATCH_MS,
      "a fix pass with 5 min of the loop left is floored at the minimum (#1742: the owed round's reserve eats what used to be the bound)",
    );
    const fix = await parkLensFixOverrun(ctx, at(CAP - 14 * MIN), T0);
    const fixTail = fix.eventLog[fix.eventLog.length - 1];
    assert(
      fixTail?.kind === "cap-hit" &&
        fixTail.cap === "lens-review-timeout" &&
        fix.pipelineState.currentStep === "handoff",
      "a lens-fix with 14 min of the loop left is not dispatched — it parks lens-review-timeout",
    );
    // #1742: the fixer's need is now 15m PLUS the 10m owed-round reserve —
    // 15 min left no longer fits a fixer; 25 min does.
    const fixNo = at(CAP - 15 * MIN);
    assert(
      (await parkLensFixOverrun(ctx, fixNo, T0)) !== fixNo,
      "…15 min of the loop left is NO LONGER enough: the owed round's reserve has to survive the fixer too",
    );
    const fixOk = at(CAP - 25 * MIN);
    assert(
      (await parkLensFixOverrun(ctx, fixOk, T0)) === fixOk,
      "…with 25 min (the 15m fixer + the 10m owed round) it is dispatched",
    );

    const round84 = at(84 * MIN);
    const parked = await parkLensRoundNoFit(ctx, round84, T0);
    const tail = parked.eventLog[parked.eventLog.length - 1];
    assert(
      tail?.kind === "cap-hit" &&
        tail.cap === "lens-review-timeout" &&
        /lens-review round 2 not started/.test(tail.evidence ?? "") &&
        /needs at least 10m/.test(tail.evidence ?? ""),
      "#1242: a lens round with 6 min of the loop left is not started, and the evidence says so",
      tail?.kind === "cap-hit" ? tail.evidence : tail?.kind,
    );
    const ok = at(80 * MIN);
    assert((await parkLensRoundNoFit(ctx, ok, T0)) === ok, "…with 10 min left the round starts");
    const first = initialState(1242, 1) as WorkState;
    assert(
      (await parkLensRoundNoFit(ctx, first, T0)) === first,
      "the first round (no clock yet) always starts",
    );

    // runLens itself refuses the round before it counts or starts it.
    const out = await runLens(ctx, round84, T0);
    assert(
      out.pipelineState.reviewRound === 1 &&
        out.pipelineState.currentStep === "handoff" &&
        !out.eventLog.some((e) => e.kind === "step-started"),
      "runLens parks before incrementing the round or starting the step",
    );
  }
} finally {
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_CYCLE_DEADLINE");
  rmSync(tmp, { recursive: true, force: true });
}

process.exit(exit);

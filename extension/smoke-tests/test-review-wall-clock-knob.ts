#!/usr/bin/env bun
/**
 * #1429 — the review wall clock is a KNOB, on every surface an operator reads.
 *
 * Two 90-minute constants were hardcoded and one literal was printed:
 *   - `REVIEW_WALL_CLOCK_MS` (work-driver-context.ts) — the driver's budget,
 *     read by `nextStep`, the lens-cap check, the fix-dispatch bound and the
 *     `/work-status` cap line;
 *   - `const REVIEW_CAP_MS` (review-cap.ts) — the ceiling `check_review_cap`
 *     answers against and names in prose;
 *   - `` `cap ${capElapsed}/90m` `` (work-widget.ts) — a string literal, so no
 *     helper could have moved it.
 *
 * The last one is why a single-knob fix was rejected: an operator who tuned the
 * driver still read `…/90m` in the footer and `cap is 90 minutes` from the
 * tool. So the assertions below are made on RENDERED STRINGS, not on internal
 * numbers — a test that only checked `reviewWallClockMs() === 45m` would pass
 * with the widget still printing `90m`.
 *
 * Both-directions: every "unset ⇒ 90" case sits beside its "set ⇒ not 90"
 * case, and the clamp case is asserted on an EXACT value. An earlier draft of
 * the clamp assertion accepted `undefined`, which made it vacuously true
 * whatever the clamp did — caught here rather than shipped.
 */

import {
  MIN_REVIEW_BUDGET_MS,
  REVIEW_CAP_DEFAULT_MS,
  REVIEW_WALL_CLOCK_MS,
  reviewCapMs,
  reviewWallClockMs,
} from "../src/review-budget.ts";
import { checkReviewCap, reset as resetCap } from "../src/review-cap.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import {
  parkLensFixOverrun,
  reviewFixDispatchBoundMs,
} from "../src/work-driver-lens-fix-budget.ts";
import { createEmitSink } from "../src/work-state-emit.ts";
import { renderRunningStatus } from "../src/work-status.ts";
import * as widget from "../src/work-widget.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const MIN = 60_000;
const WALL = "PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS";
const CAPV = "PI_ENSEMBLE_REVIEW_CAP_MS";
const ENFORCE = "PI_ENSEMBLE_REVIEW_ENFORCE";

/** Snapshot/restore the vars this suite owns, so case order never matters. */
async function withEnv(
  patches: Record<string, string | undefined>,
  body: () => void | Promise<void>,
): Promise<void> {
  const names = Object.keys(patches);
  const saved = names.map((n) => process.env[n]);
  for (const n of names) {
    const v = patches[n];
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
  try {
    await body();
  } finally {
    names.forEach((n, i) => {
      if (saved[i] !== undefined) process.env[n] = saved[i];
      else delete process.env[n];
    });
  }
}

/** Fixed epoch for the pure-arithmetic readers. */
const NOW = 1_800_000_000_000;

/**
 * Pin `Date.now()` for a block.
 *
 * Two readers take `now` as a parameter (`reviewFixDispatchBoundMs`,
 * `parkLensFixOverrun`) and two call `Date.now()` themselves (the widget and
 * `renderRunningStatus`). Pinning serves both: the arithmetic stays exact and
 * the renderers get a sane numerator instead of the wildly negative value a
 * NOW-pinned fixture produces against a live clock.
 */
async function atNow<T>(now: number, body: () => T | Promise<T>): Promise<T> {
  const real = Date.now;
  try {
    Date.now = () => now;
    return await body();
  } finally {
    Date.now = real;
  }
}

function stateWithClock(elapsedMs: number): WorkState {
  const base = initialState(1429);
  return {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      status: "running",
      currentStep: "lens-fix",
      reviewRound: 1,
      reviewCapStartedAt: NOW - elapsedMs,
    },
  };
}

function ctxFor(notices: string[]): DriverContext {
  return {
    host: { sendUserMessage: (t: unknown) => notices.push(String(t)) } as never,
    repoRoot: "/tmp",
    issue: 1429,
    emitSink: createEmitSink(() => undefined),
  } as unknown as DriverContext;
}

/**
 * Render one footer line for the current environment.
 *
 * Does NOT `clear()` afterwards: `clear` writes `setStatus(undefined)`, and
 * since `writes` is captured inside the helper the last entry would be the
 * blank, not the render.
 */
function renderFooter(state: WorkState, stepStartedAt: number): string {
  const writes: Array<string | undefined> = [];
  // biome-ignore lint/suspicious/noExplicitAny: only ui.setStatus is used
  widget.attach({ ui: { setStatus: (_k: string, v?: string) => writes.push(v) } } as any);
  widget.update(state, stepStartedAt);
  const line = writes.at(-1) ?? "";
  widget.clear(state.issue);
  return line;
}

async function main() {
  // ═════════════════════════════════ 1. defaults: byte-identical to today
  await withEnv({ [WALL]: undefined, [CAPV]: undefined, [ENFORCE]: undefined }, async () => {
    assert(reviewWallClockMs() === 90 * MIN, "unset → driver budget is exactly 90 minutes");
    assert(reviewCapMs() === 90 * MIN, "unset → check_review_cap ceiling is exactly 90 minutes");
    assert(
      REVIEW_WALL_CLOCK_MS === 90 * MIN && REVIEW_CAP_DEFAULT_MS === 90 * MIN,
      "the exported defaults themselves are unchanged at 90 minutes",
    );
    resetCap();
    const started = checkReviewCap("issue-1429", { reset: true });
    assert(
      started.message === 'Started review wall-clock timer for "issue-1429" — cap is 90 minutes.',
      `unset → the tool's start message is byte-identical (got: ${started.message})`,
    );
    const within = checkReviewCap("issue-1429");
    assert(
      within.ok === true && within.capMs === 90 * MIN,
      "unset → tool reports ok and the 90-minute capMs",
    );
    // Unset footer must still read exactly `90m`, not `90m00s`.
    const line = await atNow(NOW + 1, () => renderFooter(stateWithClock(3 * MIN), NOW + 1));
    assert(
      /cap 3m00s\/90m$/.test(line),
      `unset → the footer renders the ORIGINAL "…/90m" exactly (got ${JSON.stringify(line)})`,
    );
    resetCap();
  });

  // ═════════════════ 2. ONE env var moves EVERY reader at once
  await withEnv({ [WALL]: String(45 * MIN), [CAPV]: undefined, [ENFORCE]: "1" }, async () => {
    assert(reviewWallClockMs() === 45 * MIN, "wall-clock knob → reviewWallClockMs() is 45m");

    // (a) the fix-dispatch bound arithmetic
    const bound = await atNow(NOW, () =>
      reviewFixDispatchBoundMs(stateWithClock(20 * MIN), "lens-fix", NOW),
    );
    assert(
      bound === 25 * MIN,
      `…→ the fixer is bound to what REMAINS under the moved ceiling (20m into 45m → 25m, got ${bound})`,
    );
    // Both-directions partner: under the DEFAULT ceiling the same state leaves
    // 70m, so a reader still hardcoded to 90 cannot produce 25m above.
    await withEnv({ [WALL]: undefined }, async () => {
      const dflt = await atNow(NOW, () =>
        reviewFixDispatchBoundMs(stateWithClock(20 * MIN), "lens-fix", NOW),
      );
      assert(
        dflt === 70 * MIN,
        `canary: same state, knob unset → 70m remains, so the 25m above is the knob and not an accident (got ${dflt})`,
      );
    });

    // (b) parkLensFixOverrun's EVIDENCE STRING must name 45, never 90.
    const notices: string[] = [];
    const ctx = ctxFor(notices);
    // 50m elapsed against a 45m ceiling: over the cap though UNDER 90m — so a
    // reader still hardcoded to 90 would not park at all.
    const parked = await atNow(NOW, () => parkLensFixOverrun(ctx, stateWithClock(50 * MIN), NOW));
    const tail = parked.eventLog[parked.eventLog.length - 1];
    assert(
      tail?.kind === "cap-hit" && tail.cap === "wall-clock",
      `…→ past the moved ceiling the cycle records a wall-clock cap-hit (got ${tail?.kind})`,
    );
    const ev = (tail as { evidence?: string }).evidence ?? "";
    assert(
      /against the 45-minute cap/.test(ev),
      `…→ the park EVIDENCE says "45-minute cap", not 90 (got: ${ev.slice(0, 150)})`,
    );
    assert(!/90-minute/.test(ev), "…→ and the stale 90-minute string is gone from the evidence");
    assert(
      notices.some((n) => /45-minute review-loop cap/.test(n)) &&
        !notices.some((n) => /90-minute/.test(n)),
      "…→ the operator notification names 45 minutes and never 90",
    );

    // (c) the WORK-STATUS "wall-clock x/y" line
    const rendered = await atNow(NOW, () => renderRunningStatus(stateWithClock(10 * MIN), "/tmp"));
    assert(
      /wall-clock 10m00s\/45m00s/.test(rendered),
      `…→ /work-status renders the moved denominator 45m00s (got: ${(rendered.match(/wall-clock [^\s·]+/) ?? ["<none>"])[0]})`,
    );
    assert(!/\/90m00s/.test(rendered), "…→ and no longer the hardcoded 90m00s");

    // (d) THE WIDGET LITERAL — the item no helper could have moved.
    const line = await atNow(NOW + 1, () => renderFooter(stateWithClock(3 * MIN), NOW + 1));
    assert(
      /cap 3m00s\/45m$/.test(line),
      `…→ the FOOTER renders "cap 3m00s/45m" from the knob, not the old literal 90m (got ${JSON.stringify(line)})`,
    );
    assert(!/\/90m/.test(line), "…→ and the hardcoded /90m literal is gone from the footer");
  });

  // ═════════════════════ 3. the second knob moves the tool path only
  await withEnv({ [CAPV]: String(30 * MIN), [WALL]: undefined }, async () => {
    resetCap();
    const started = checkReviewCap("issue-1429-cap", { reset: true });
    assert(
      /cap is 30 minutes\./.test(started.message),
      `check_review_cap start message follows its own knob (got: ${started.message})`,
    );
    assert(started.capMs === 30 * MIN, "…and capMs reports 30 minutes");
    // Advance the pinned clock BETWEEN start and check: `checkReviewCap`
    // stamps and compares against `Date.now()`, so both calls under one pinned
    // value would read 0m elapsed and the exceeded branch would be unreachable.
    const exceeded = await atNow(NOW, () => {
      checkReviewCap("issue-1429-cap-2", { reset: true });
      return atNow(NOW + 31 * MIN, () => checkReviewCap("issue-1429-cap-2"));
    });
    assert(
      exceeded.ok === false,
      `…→ 31m into a 30m ceiling the tool answers ok:false (got ${exceeded.ok})`,
    );
    assert(
      /cap is 30m/.test(exceeded.message),
      `…→ and its message names 30m, not 90m (got: ${exceeded.message})`,
    );
    assert(!/90m/.test(exceeded.message), "…→ with no stale 90m anywhere in the message");
    // Orthogonal by construction: the driver budget did NOT move.
    assert(
      reviewWallClockMs() === 90 * MIN,
      "canary: moving the CAP knob does NOT move the driver wall clock (two ceilings, two knobs)",
    );
    // …and moving it back does not move the driver either.
    const footer = await atNow(NOW + 1, () => renderFooter(stateWithClock(2 * MIN), NOW + 1));
    assert(
      /cap 2m00s\/90m$/.test(footer),
      `canary: with only the CAP knob set the footer still reads 90m — the knobs are independent (got ${JSON.stringify(footer)})`,
    );
    resetCap();
  });

  // ═══════════════════════════ 4. invalid / hostile values fall back
  const BAD: Array<[string, string]> = [
    ["zero", "0"],
    ["negative", "-1"],
    ["negative ms", "-5400000"],
    ["non-numeric", "banana"],
    ["empty", ""],
    ["whitespace", "   "],
    ["float", "45.5"],
    ["exponential float", "1e3.5"],
    ["NaN", "NaN"],
    ["below the floor (9m)", String(9 * MIN)],
    ["below the floor (30s)", "30000"],
  ];
  for (const [label, value] of BAD) {
    await withEnv({ [WALL]: value }, () => {
      assert(
        reviewWallClockMs() === 90 * MIN,
        `invalid wall-clock "${value}" (${label}) falls back to the 90-minute default`,
      );
    });
    await withEnv({ [CAPV]: value }, () => {
      assert(
        reviewCapMs() === 90 * MIN,
        `invalid cap "${value}" (${label}) falls back to the 90-minute default`,
      );
    });
  }

  // The clamp is OBSERVABLE: a sub-grace ceiling must not reach any surface.
  await withEnv({ [WALL]: String(30_000), [ENFORCE]: "1" }, async () => {
    // 0m elapsed against a REJECTED 30s ceiling ⇒ the default 90m applies, so
    // the bound is exactly 90m. Exact-value assertion: the first draft accepted
    // `undefined` here, which was vacuously true whatever the clamp did.
    const bound = await atNow(NOW, () =>
      reviewFixDispatchBoundMs(stateWithClock(0), "lens-fix", NOW),
    );
    assert(
      bound === 90 * MIN,
      `a sub-grace ceiling (30s) is REJECTED so the bound is the 90m default, not 30s — got ${bound}`,
    );
    const line = await atNow(NOW + 1, () => renderFooter(stateWithClock(2 * MIN), NOW + 1));
    assert(
      /cap 2m00s\/90m$/.test(line),
      `the rejected 30s value is OBSERVABLY absent from the footer, which reads 90m — got ${JSON.stringify(line)}`,
    );
  });

  assert(
    MIN_REVIEW_BUDGET_MS > 8 * MIN,
    `the clamp floor (${MIN_REVIEW_BUDGET_MS / MIN}m) sits above the 8-minute default handoff grace, so any accepted value leaves an armable window`,
  );

  // ═════════ 5. ORTHOGONALITY: the knob bounds the ceiling; ENFORCE removes it
  // Knob set AND enforcement off must mean "no enforcement", not "enforcement
  // at a different number" — the knob must never become a substitute for it.
  await withEnv({ [WALL]: String(10 * MIN), [ENFORCE]: "0" }, async () => {
    const bound = await atNow(NOW, () =>
      reviewFixDispatchBoundMs(stateWithClock(11 * MIN), "lens-fix", NOW),
    );
    assert(
      bound === undefined,
      `knob=10m + ENFORCE=0 → no bound armed at all; the knob did not become a replacement for enforcement (got ${bound})`,
    );
    const ctx = ctxFor([]);
    const st = stateWithClock(11 * MIN);
    const out = await atNow(NOW, () => parkLensFixOverrun(ctx, st, NOW));
    assert(out === st, "…→ and the park helper is a no-op, exactly the pre-#1416 shape");
    // With enforcement ON the identical state DOES park — so the two lines
    // above are the switch working, not the state sitting under some ceiling.
    await withEnv({ [ENFORCE]: "1" }, async () => {
      const armed = await atNow(NOW, () =>
        reviewFixDispatchBoundMs(stateWithClock(11 * MIN), "lens-fix", NOW),
      );
      assert(
        armed === MIN,
        `canary: same state, ENFORCE=1 → the fixer IS bound (got ${armed}), proving ENFORCE is the switch`,
      );
      const parked = await atNow(NOW, () => parkLensFixOverrun(ctx, st, NOW));
      assert(
        parked !== st,
        "…→ and with enforcement on the same state does park (the knob alone does not)",
      );
    });
    // And the knob still RENDERED its value while enforcement was off: the
    // number is display, ENFORCE is behaviour.
    const line = await atNow(NOW + 1, () => renderFooter(stateWithClock(2 * MIN), NOW + 1));
    assert(
      /cap 2m00s\/10m$/.test(line),
      `with enforcement OFF the footer still shows the configured 10m — the two knobs are orthogonal (got ${JSON.stringify(line)})`,
    );
  });

  process.exit(exit);
}

await main();

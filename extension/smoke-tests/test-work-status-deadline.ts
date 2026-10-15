#!/usr/bin/env bun
/**
 * #1238 (task-a) — the deadline display in both status surfaces.
 *
 * Covers:
 *  1. `renderStatus` (work-widget.ts footer): the deadline segment appears
 *     beside the loop cap when `cycleDeadlineMs` is set; absent when unset.
 *  2. `renderStatus` (work-status.ts running view): the "deadline: …
 *     remaining" line appears when set; absent when unset.
 */

import { renderStatus as renderFooter } from "../src/work-widget.ts";
import { renderStatus as renderTerminal } from "../src/work-status.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const now = Date.now();

// --- 1. Footer widget (work-widget.ts renderStatus) ---

// 1a. Deadline set — segment appears.
{
  const state = initialState(42, now - 60_000) as WorkState;
  state.pipelineState.cycleDeadlineMs = now + 1_800_000; // 30 min from now
  state.pipelineState.currentStep = "develop";
  const out = renderFooter(state, now - 30_000, now);
  assert(out.includes("deadline"), "footer widget shows 'deadline' segment when cycleDeadlineMs is set");
  assert(/\d+m\d+s/.test(out), "footer widget shows a formatted elapsed time for the deadline");
}

// 1b. Deadline not set — no segment.
{
  const state = initialState(43, now - 60_000) as WorkState;
  state.pipelineState.currentStep = "develop";
  const out = renderFooter(state, now - 30_000, now);
  assert(!out.includes("deadline"), "footer widget does NOT show 'deadline' when cycleDeadlineMs is unset");
}

// 1c. Deadline in the past — clamped to 0, still shown.
{
  const state = initialState(44, now - 120_000) as WorkState;
  state.pipelineState.cycleDeadlineMs = now - 5_000; // already past
  state.pipelineState.currentStep = "develop";
  const out = renderFooter(state, now - 60_000, now);
  assert(out.includes("deadline 0ms"), "footer widget clamps a past deadline to 0ms (got: " + out + ")");
}

// --- 2. Running status (work-status.ts renderRunningStatus) ---

// 2a. Deadline set — line appears.
{
  const state = initialState(55, now - 300_000) as WorkState;
  state.pipelineState.cycleDeadlineMs = now + 3_600_000; // 1 hour from now
  state.pipelineState.currentStep = "lens-fix";
  const out = renderTerminal(state, "/tmp/fake");
  assert(out.includes("deadline:"), "running status shows 'deadline:' line when cycleDeadlineMs is set");
  assert(out.includes("remaining"), "running status deadline line says 'remaining'");
}

// 2b. Deadline not set — no line.
{
  const state = initialState(56, now - 300_000) as WorkState;
  state.pipelineState.currentStep = "lens-fix";
  const out = renderTerminal(state, "/tmp/fake");
  assert(!out.includes("deadline:"), "running status does NOT show 'deadline:' when cycleDeadlineMs is unset");
}

// 2c. Deadline in the past — clamped, still shown.
{
  const state = initialState(57, now - 600_000) as WorkState;
  state.pipelineState.cycleDeadlineMs = now - 1_000;
  state.pipelineState.currentStep = "develop";
  const out = renderTerminal(state, "/tmp/fake");
  assert(out.includes("deadline: 0ms remaining"), "running status clamps a past deadline to '0ms remaining'");
}

console.log(`\nexit ${exit}`);
process.exit(exit);

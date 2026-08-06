#!/usr/bin/env bun
/**
 * #288 — the footer cursor and scrollback under more than one live cycle.
 *
 * The regression being fixed is destructive and already reachable today
 * (two `/work` invocations can overlap): `clear()` took no argument, cleared
 * the SHARED status key and killed the ticker, so the FIRST cycle to finish
 * blanked the footer for every cycle still running — for the rest of their
 * runtime, with no recovery until the next step transition.
 */

import * as lifecycle from "../src/lifecycle-events.ts";
import * as widget from "../src/work-widget.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function mkState(issue: number, step = "develop"): WorkState {
  return {
    schemaVersion: 1,
    issue,
    updatedAt: Date.now(),
    // biome-ignore lint/suspicious/noExplicitAny: only the fields the widget reads
    pipelineState: { status: "running", currentStep: step, reviewRound: 0 } as any,
    eventLog: [],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any;
}

/** Captures what the widget writes to the single status key Pi gives us. */
function fakeCtx() {
  const writes: Array<string | undefined> = [];
  return {
    writes,
    // biome-ignore lint/suspicious/noExplicitAny: only ui.setStatus is used
    ctx: { ui: { setStatus: (_k: string, v?: string) => writes.push(v) } } as any,
  };
}

const { writes, ctx } = fakeCtx();
widget.attach(ctx);

// ---------------------------------------------------- independent updates

widget.update(mkState(101), Date.now() - 5000);
widget.update(mkState(202, "lens-review"), Date.now() - 2000);

assert(widget.snapshot().cycles.join(",") === "101,202", "both cycles are tracked independently");
{
  const line = writes.at(-1) ?? "";
  assert(/#101/.test(line) && /#202/.test(line), "the footer shows BOTH cycles at once");
  assert(/ │ /.test(line), "segments use a separator distinct from the intra-segment ' · '");
}

// ------------------------------------- the regression: clear is per-cycle

widget.clear(101);
{
  const line = writes.at(-1) ?? "";
  assert(line !== undefined && line.length > 0, "clearing one cycle does NOT blank the footer");
  assert(
    /#202/.test(line),
    "the surviving cycle is still rendered — this is the bug that made siblings invisible",
  );
  assert(!/#101/.test(line), "the finished cycle's segment is gone");
}
assert(widget.snapshot().cycles.join(",") === "202", "only the finished cycle was removed");

widget.clear(202);
assert(writes.at(-1) === undefined, "the status key is cleared only once the LAST cycle ends");
assert(widget.snapshot().cycles.length === 0, "no cycles remain");

// Clearing an unknown issue must be harmless — a resumed or crashed cycle
// can call it for an issue the widget never saw.
widget.clear(999);
assert(widget.snapshot().cycles.length === 0, "clearing an unknown cycle is a no-op, not a throw");

// ----------------------------------------------- single-cycle unchanged

{
  const { writes: w2, ctx: c2 } = fakeCtx();
  widget.attach(c2);
  widget.update(mkState(303), Date.now() - 1000);
  const line = w2.at(-1) ?? "";
  assert(line.startsWith("▸ /work #303"), "a single cycle renders exactly as before");
  assert(!/ │ /.test(line), "no segment separator appears when only one cycle is live");
  widget.clear(303);
}

// --------------------------------------------- lifecycle attribution

{
  // With one cycle live the tag is noise and must be suppressed; with two it
  // is the only thing telling otherwise byte-identical lines apart.
  lifecycle.setLiveCycleCount(1);
  const single = lifecycle.formatLine({
    kind: "step-started",
    jobId: "develop",
    label: "develop",
    role: "develop",
    stepNumber: 4,
    stepTotal: 9,
    issue: 101,
  });
  assert(
    single === "▸ ensemble: ▶ step 4/9 develop started",
    `single-cycle scrollback is byte-identical (got "${single}")`,
  );

  lifecycle.setLiveCycleCount(2);
  const multi = lifecycle.formatLine({
    kind: "step-started",
    jobId: "develop",
    label: "develop",
    role: "develop",
    stepNumber: 4,
    stepTotal: 9,
    issue: 101,
  });
  assert(/#101/.test(multi), "with two cycles live the line names its issue");
  assert(
    multi.startsWith("▸ ensemble: #101 ▶"),
    "the tag sits after the prefix so the glyph column stays aligned",
  );
  lifecycle.setLiveCycleCount(0);
}

console.log(`\nexit ${exit}`);
process.exit(exit);

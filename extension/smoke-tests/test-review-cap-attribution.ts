#!/usr/bin/env bun
/**
 * The handoff must name the gate that actually stopped the cycle.
 *
 * `nextStep` routes to handoff when `reviewRound >= MAX_REVIEW_ROUNDS` or the
 * review wall clock expires — but it is a PURE function of state and cannot
 * append, so nothing recorded WHY. Four renderers then defaulted the missing
 * cap to `"adversarial-loop"`.
 *
 * Measured across 53 handoffs: **23 (43%) said "adversarial gate ran its
 * 3-round internal loop and could not reach APPROVED", and 14 of those had
 * `Last step: lens-review` with adversarial APPROVING every round.** So 26% of
 * every handoff message sent the operator to the wrong gate. That is the same
 * class of harm as the two wrong root-cause theories this investigation
 * disproved — a confident, specific, false explanation costs more than silence.
 *
 * The `round-cap` and `wall-clock` values were already in the event union and
 * already had correct `explainCap` cases. They were unreachable: dead type
 * members with dead prose behind them.
 *
 * Note why the fallbacks could not simply be deleted before: `explainCap(cap)`
 * did `cap.startsWith(...)`, so an absent cap THREW and the operator got no
 * handoff at all. It is total now, which is what makes their removal safe.
 */

import { explainCap } from "../src/work-driver-explain.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const state = { pipelineState: {}, eventLog: [] } as unknown as WorkState;

// ------------------------------------------- an absent cap is not a lie

{
  let text = "";
  let threw = false;
  try {
    text = explainCap(undefined, state);
  } catch {
    threw = true;
  }
  assert(
    !threw,
    "canary: explainCap survives an absent cap — it threw, so the operator got no handoff",
  );
  assert(
    !/adversarial/i.test(text),
    "canary: ...and does NOT blame the adversarial gate — that default was 26% of all handoff messages",
  );
  assert(
    /without recording which gate/i.test(text),
    "...it says the cap was not recorded, which is the honest answer",
  );
}

// ----------------------------------- the review caps say what they are

{
  const round = explainCap("round-cap", state);
  assert(/lens-review/.test(round), "round-cap names lens-review");
  assert(!/adversarial/i.test(round), "...and not adversarial");

  const wall = explainCap("wall-clock", state);
  assert(/lens-review/.test(wall) && /wall-clock/.test(wall), "wall-clock names lens-review too");

  const incomplete = explainCap("review-incomplete", state);
  assert(
    /not fully reviewed/.test(incomplete) && !/adversarial/i.test(incomplete),
    "canary: REVIEW_INCOMPLETE is its own cap — it emitted `adversarial-loop`, a copy-paste that blamed a gate which had approved",
  );
}

{
  // The real adversarial cap must still say so, or this trades one
  // misattribution for another.
  assert(
    /adversarial/i.test(explainCap("adversarial-loop", state)),
    "a genuine adversarial cap still names the adversarial gate",
  );
}

// --------------------------- no renderer invents a cap any more

{
  const { readFileSync, readdirSync } = await import("node:fs");
  const path = await import("node:path");
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const offenders: string[] = [];
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".ts"))) {
    const text = readFileSync(path.join(SRC, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    if (/:\s*\("adversarial-loop" as const\)/.test(text)) offenders.push(f);
  }
  assert(
    offenders.length === 0,
    `canary: nothing defaults a missing cap to "adversarial-loop"${offenders.length ? ` — still in ${offenders.join(", ")}` : ""}`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

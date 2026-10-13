#!/usr/bin/env bun
/**
 * #1132 addendum (blocking rule + cap routing) — the gate loop's split at the
 * iteration cap. Every CRITICAL still unresolved at the cap is an OPEN POINT,
 * listed in the filed body with the gate's proposal when it gave one. Nothing
 * CRITICAL is demoted to the residual section, and no text heuristic decides
 * which CRITICAL counts. The cap files the spec; the driver decides filing.
 */

import { openPointsSection, residualGapsSection } from "../src/plan-gap-disclosure.ts";
import { type GapGateDispatch, runGapGateLoop } from "../src/plan-gaps.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A dispatch that replays one reply per round (the last one repeats). */
function replies(...texts: string[]): GapGateDispatch {
  let i = 0;
  return async () => {
    const text = texts[Math.min(i, texts.length - 1)] ?? "";
    i++;
    return { ok: true, text, toolUses: [] };
  };
}

const PROPOSED =
  "GAP: CRITICAL the retry cap contradicts the quota rule — proposed resolution: name the winner — resolution-type: concrete\nVERDICT: NEEDS_ITERATION";
const OPEN = "GAP: CRITICAL the retry cap contradicts the quota rule\nVERDICT: NEEDS_ITERATION";

// 1. A CRITICAL with a proposal is still an open point at the cap, shown with
//    its proposal, and is not repeated in the residual section.
{
  const r = await runGapGateLoop(
    replies(PROPOSED, PROPOSED),
    () => "P",
    2,
    () => {},
  );
  assert(
    r.capHit && r.capReason === "unresolved-blocking",
    "proposal CRITICAL: the cap is reached",
  );
  assert(r.openPoints.length === 1, "proposal CRITICAL: an open point at the cap");
  assert(
    openPointsSection(r.openPoints).includes("proposed: name the winner"),
    "proposal CRITICAL: the open point carries the gate's proposal",
  );
  assert(
    !residualGapsSection(r.residualForDisclosure).includes("retry cap contradicts"),
    "proposal CRITICAL: not repeated in the residual section",
  );
}

// 2. A placeholder CRITICAL is the open point at the cap, and not in the residual.
{
  const r = await runGapGateLoop(
    replies(OPEN, OPEN),
    () => "P",
    2,
    () => {},
  );
  assert(r.openPoints.length === 1, "placeholder CRITICAL: is the open point");
  assert(
    !r.residualForDisclosure.some((g) => g.severity === "CRITICAL"),
    "placeholder CRITICAL: not repeated in the residual",
  );
  assert(
    openPointsSection(r.openPoints).includes("no proposed resolution"),
    "placeholder CRITICAL: the open point says no resolution was proposed",
  );
  assert(
    openPointsSection(r.openPoints).startsWith("## Open points (unresolved at the gap-gate cap)"),
    "open points render under the marked heading",
  );
}

// 3. An operator-vs-operator CRITICAL is an open point at the cap, like any other.
{
  const conflict =
    "GAP: CRITICAL do not change protectedPathsIn for any caller versus a caller must change protectedPathsIn — proposed resolution: pick one — resolution-type: operator-decision\nVERDICT: NEEDS_ITERATION";
  const r = await runGapGateLoop(
    replies(conflict, conflict),
    () => "P",
    2,
    () => {},
  );
  assert(r.openPoints.length === 1, "operator-vs-operator CRITICAL: an open point at the cap");
}

// 4. The gate's proposal for a CRITICAL is shown with the open point, so the
//    operator sees what the gate offered next to what is unresolved.
{
  const r = await runGapGateLoop(
    replies(
      "GAP: CRITICAL the retry cap is 3 contradicts the retry cap is 5 — proposed resolution: keep 3\nVERDICT: NEEDS_ITERATION",
    ),
    () => "P",
    1,
    () => {},
  );
  assert(r.openPoints.length === 1, "single round at the cap: the CRITICAL is an open point");
  assert(
    openPointsSection(r.openPoints).includes("proposed: keep 3"),
    "single round at the cap: the open point shows the proposal",
  );
}

// 5. A silent reviewer with a CRITICAL proposal does not pass as READY.
{
  const silent =
    "GAP: CRITICAL the retry cap contradicts the quota rule — proposed resolution: name the winner — resolution-type: concrete";
  const r = await runGapGateLoop(
    replies(silent, silent),
    () => "P",
    2,
    () => {},
  );
  assert(r.capHit, "silent verdict + CRITICAL proposal: not READY (reaches the cap)");
}

process.exit(exit);

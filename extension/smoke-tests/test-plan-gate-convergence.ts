#!/usr/bin/env bun
/**
 * #1132 addendum (blocking rule + cap routing) — the gate loop's split at the
 * iteration cap. A CRITICAL with the placeholder resolution, or an operator-vs-
 * operator clash, is an OPEN POINT (listed in the filed body). A CRITICAL with a
 * proposed resolution is NOT an open point: it travels in the residual section
 * with its proposal. Neither refuses filing (filing is decided by the driver).
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

// 1. A CRITICAL with a proposal is not an open point at the cap: residual, not open points.
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
  assert(r.openPoints.length === 0, "proposal CRITICAL: NOT an open point");
  assert(
    r.residualForDisclosure.some(
      (g) => g.severity === "CRITICAL" && g.resolution === "name the winner",
    ),
    "proposal CRITICAL: disclosed in the residual with its proposal",
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
    openPointsSection(r.openPoints).startsWith("## Open points (unresolved at the gap-gate cap)"),
    "open points render under the marked heading",
  );
}

// 3. An operator-vs-operator CRITICAL still caps: open point even with a proposal.
{
  const op = ["do not change protectedPathsIn for any caller"];
  const conflict =
    "GAP: CRITICAL do not change protectedPathsIn for any caller versus a caller must change protectedPathsIn — proposed resolution: pick one — resolution-type: operator-decision\nVERDICT: NEEDS_ITERATION";
  const r = await runGapGateLoop(
    replies(conflict, conflict),
    () => "P",
    2,
    () => {},
    {
      operatorLines: [...op, "a caller must change protectedPathsIn for every run"],
      investigationLines: [],
    },
  );
  assert(
    r.openPoints.length === 1,
    "operator-vs-operator CRITICAL: still an open point at the cap",
  );
}

// 4. A discarded operator-vs-investigation conflict is disclosed even when the gate is READY.
{
  const conflict =
    "GAP: CRITICAL every caller keeps protectedPathsIn unchanged versus callers thread a per-cycle set through protectedPathsIn — proposed resolution: pick one\nVERDICT: NEEDS_ITERATION";
  const r = await runGapGateLoop(
    replies(conflict),
    () => "P",
    2,
    () => {},
    {
      operatorLines: ["every caller keeps protectedPathsIn unchanged"],
      investigationLines: ["callers thread a per-cycle set through protectedPathsIn"],
    },
  );
  assert(r.discardedConflicts.length === 1, "discard: the conflict is recorded");
  assert(
    residualGapsSection(r.residualForDisclosure).includes("per-cycle set"),
    "discard: the conflict is disclosed in the residual section on every path",
  );
  assert(r.openPoints.length === 0 && r.gaps.length === 0, "discard: it neither blocks nor caps");
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

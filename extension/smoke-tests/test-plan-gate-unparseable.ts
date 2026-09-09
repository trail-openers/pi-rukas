#!/usr/bin/env bun
/**
 * The gap gate FAILS CLOSED on an unparseable review (operator bug report,
 * 2026-09-09: the synthetic `[MEDIUM] no structured gaps parsed → proceed`
 * gap made an unreadable review a guaranteed pass under CRITICAL-only
 * blocking — fired twice in six fixture rounds, both escapes filed real
 * contradictions).
 *
 * Pins the report's outcome table:
 *   valid + 0 findings            → Reviewed  → FILED, dispositions '(none)'
 *   valid + MEDIUM/LOW only       → Reviewed  → FILED with residual
 *   valid + ≥1 CRITICAL           → Reviewed  → BLOCKED (cap-surface)
 *   empty reply                   → Unavail.  → NOT filed (review-unparseable)
 *   prose, no markers, no verdict → Unavail.  → NOT filed (after ONE strict retry)
 *   truncated (gaps, no verdict)  → Reviewed  → D3 handling (CRITICAL blocks)
 *   dispatch failure              → Unavail.  → NOT filed (gate-unavailable)
 * ...and the load-bearing invariant: NO reply shape reaches `filed: true`
 * without a parsed review (a verdict line or GAP: findings).
 */

import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { forgeStub, gatePrompts, installForgeStub, makeDispatchStub } from "./plan-test-stubs.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

installForgeStub();
const DESCRIPTOR = "add a start_plan_driver tool for the plan pipeline in extension";

async function run(gateReplies: string[] | string) {
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  gatePrompts.length = 0;
  setPlanDispatch(makeDispatchStub(gateReplies) as never);
  const r = await runPlanPipeline({} as never, { descriptor: DESCRIPTOR }, process.cwd());
  setPlanDispatch(null);
  return r;
}

{
  // Reviewed, clean: READY + zero markers → FILED, zero gaps.
  const r = await run("All sections are sound. Nothing to flag.\nVERDICT: READY");
  assert(r.filed === true, "clean review files");
  assert(r.gaps.length === 0, "clean review carries ZERO gaps (no synthetic fallback)");
  assert(gatePrompts.length === 1, "clean review: one gate dispatch, no retry");
}

{
  // Reviewed, MEDIUM/LOW only → FILED with residual disclosure.
  const r = await run(
    "GAP: MEDIUM — clarify the boundary — proposed resolution: sharpen it\nVERDICT: NEEDS_ITERATION",
  );
  assert(
    r.filed === true && r.capReason === "residual-medium-low",
    "MEDIUM-only review files with residual",
  );
  assert(
    (forgeStub.created[0]?.body ?? "").includes("Residual gap-gate findings"),
    "…and discloses it",
  );
}

{
  // Reviewed, CRITICAL persists both rounds → BLOCKED.
  const r = await run([
    "GAP: CRITICAL — contradiction A — proposed resolution: pick one\nVERDICT: NEEDS_ITERATION",
    "GAP: CRITICAL — contradiction A — proposed resolution: pick one\nVERDICT: NEEDS_ITERATION",
  ]);
  assert(r.filed === false && r.capReason === "unresolved-blocking", "CRITICAL review blocks");
}

{
  // Empty reply → strict retry → still empty → review-unparseable, NOT filed.
  const r = await run(["", ""]);
  assert(r.filed === false, "empty review does NOT file");
  assert(r.capReason === "review-unparseable", `capReason review-unparseable (got ${r.capReason})`);
  assert(r.filingFailure?.reason === "review-unparseable", "filingFailure carries the reason");
  assert(gatePrompts.length === 2, `exactly ONE strict retry (${gatePrompts.length} dispatches)`);
  assert(
    /STRICT OUTPUT CONTRACT/.test(gatePrompts[1] ?? ""),
    "the retry prompt carries the strict output contract",
  );
}

{
  // Prose with no markers and no verdict → retry → same → NOT filed, raw head kept.
  const raw = "I reviewed everything carefully and it seems broadly reasonable to me.";
  const r = await run([raw, raw]);
  assert(
    r.filed === false && r.capReason === "review-unparseable",
    "markerless prose does NOT file",
  );
  assert(
    (r.filingFailure?.detail ?? "").includes("broadly reasonable"),
    "the raw reviewer output head travels in the detail (parser-vs-prompt drift is diagnosable)",
  );
}

{
  // Retry RESCUES a transient format miss: unparseable round 1, valid retry.
  const r = await run(["total garbage with no structure", "VERDICT: READY"]);
  assert(r.filed === true && r.gaps.length === 0, "a rescued retry files as a clean review");
  assert(gatePrompts.length === 2, "…after exactly one retry dispatch");
}

{
  // Truncated mid-structure: GAP lines present, verdict missing → REVIEWED
  // (D3): CRITICAL without a verdict routes to iteration, then blocks.
  const r = await run([
    "GAP: CRITICAL — the retry cap contradicts the quota rule",
    "GAP: CRITICAL — the retry cap contradicts the quota rule",
  ]);
  assert(
    r.filed === false && r.capReason === "unresolved-blocking",
    "truncated-but-reviewed (CRITICAL, no verdict) still blocks via D3 — not misclassified as unparseable",
  );
}

{
  // INVARIANT: no reply shape reaches filed:true without a parsed review.
  const shapes: { reply: string; parsedReview: boolean }[] = [
    { reply: "VERDICT: READY", parsedReview: true },
    { reply: "GAP: LOW — nit — proposed resolution: fix\nVERDICT: READY", parsedReview: true },
    { reply: "", parsedReview: false },
    { reply: "no structure here at all", parsedReview: false },
    { reply: "### Findings\nplenty of prose, zero markers", parsedReview: false },
  ];
  for (const s of shapes) {
    const r = await run([s.reply, s.reply]);
    if (s.parsedReview) {
      assert(r.filed === true, `parsed review files: ${JSON.stringify(s.reply.slice(0, 30))}`);
    } else {
      assert(
        r.filed === false,
        `INVARIANT: unparsed review NEVER files: ${JSON.stringify(s.reply.slice(0, 30))}`,
      );
    }
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);

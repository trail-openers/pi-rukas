#!/usr/bin/env bun
/**
 * #878 — killCause render scenarios for renderSummary (moved out of
 * test-lens-review.ts to keep it under the 500-line gate; the scenarios are
 * verbatim from the issue-878 workstream).
 *
 * Asserts the per-lens BLOCKED tag suffix, the blocked-banner per-lens line,
 * and the three-branch banner header — exact strings, offline, no spawns.
 */

import type { LensRunResult } from "../src/lens-review.ts";
import { renderSummary } from "../src/lens-review.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function lensResult(
  lens:
    | "SECURITY"
    | "ERROR_HANDLING"
    | "TYPE_SAFETY"
    | "PERFORMANCE"
    | "ARCHITECTURE"
    | "SIMPLICITY",
  opts: {
    ok: boolean;
    attempts: number;
    blocked: boolean;
    parseError?: string;
    killCause?: "timeout" | "inactivity" | "abort" | "loop" | "token-budget" | "plan-timeout";
    loopEvidence?: { tool: string; count: number };
    tokenBudget?: { budget: number; used: number };
  },
): LensRunResult {
  return {
    lens,
    ok: opts.ok,
    ms: 1000,
    findings: [],
    attempts: opts.attempts,
    blocked: opts.blocked,
    parseError: opts.parseError,
    killCause: opts.killCause,
    loopEvidence: opts.loopEvidence,
    tokenBudget: opts.tokenBudget,
  };
}

// #878 — killCause render scenarios (d4)
const _sv = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
const _bs = (l: LensRunResult, ...r: LensRunResult[]) =>
  renderSummary(
    {
      verdict: "REVIEW_INCOMPLETE" as const,
      totalFindings: 0,
      bySeverity: _sv,
      findings: [],
      lenses: [l, ...r],
    },
    4,
  );
{
  const r = _bs(
    lensResult("SECURITY", {
      ok: false,
      attempts: 1,
      blocked: true,
      parseError: "attempt 1/4: exit 143",
      killCause: "loop",
      loopEvidence: { tool: "bash", count: 10 },
    }),
    lensResult("ERROR_HANDLING", { ok: true, attempts: 1, blocked: false }),
  );
  assert(
    r.includes(
      "BLOCKED after 1 attempts — attempt 1/4: exit 143 (killed: loop — bash ×10; not retried: self-inflicted cap, #543)",
    ),
    "#878: loop+evidence exact tag",
  );
}
{
  const r = _bs(
    lensResult("SECURITY", {
      ok: false,
      attempts: 1,
      blocked: true,
      parseError: "attempt 1/4: exit 143",
      killCause: "loop",
    }),
  );
  assert(
    r.includes(
      "BLOCKED after 1 attempts — attempt 1/4: exit 143 (killed: loop; not retried: self-inflicted cap, #543)",
    ),
    "#878: loop bare",
  );
}
{
  const r = _bs(
    lensResult("PERFORMANCE", {
      ok: false,
      attempts: 1,
      blocked: true,
      parseError: "attempt 1/4: exit 143",
      killCause: "token-budget",
      tokenBudget: { budget: 100000, used: 100500 },
    }),
  );
  assert(
    r.includes(
      "BLOCKED after 1 attempts — attempt 1/4: exit 143 (killed: token-budget — 100500/100000 tokens; not retried: self-inflicted cap, #543)",
    ),
    "#878: token-budget",
  );
}
{
  const r = _bs(
    lensResult("TYPE_SAFETY", {
      ok: false,
      attempts: 4,
      blocked: true,
      parseError: "attempt 4/4: timeout",
      killCause: "inactivity",
    }),
  );
  assert(
    r.includes("BLOCKED after 4 attempts — attempt 4/4: timeout (killed: inactivity)"),
    "#878: inactivity",
  );
  assert(!r.includes("not retried"), "#878: inactivity no not-retried");
}
{
  const r = _bs(
    lensResult("SIMPLICITY", {
      ok: false,
      attempts: 1,
      blocked: true,
      parseError: "aborted by user",
      killCause: "abort",
    }),
  );
  assert(r.includes("BLOCKED after 1 attempts — aborted by user (aborted)"), "#878: abort");
  assert(!r.includes("not retried"), "#878: abort no not-retried");
}
{
  const r = _bs(
    lensResult("PERFORMANCE", {
      ok: false,
      attempts: 1,
      blocked: true,
      parseError: "attempt 1/4: exit 143",
      killCause: "token-budget",
    }),
  );
  assert(
    r.includes(
      "BLOCKED after 1 attempts — attempt 1/4: exit 143 (killed: token-budget; not retried: self-inflicted cap, #543)",
    ),
    "#878: token-budget bare (no budget data)",
  );
}
{
  const r = _bs(
    lensResult("ARCHITECTURE", {
      ok: false,
      attempts: 4,
      blocked: true,
      parseError: "attempt 4/4: plan timeout",
      killCause: "timeout",
    }),
    lensResult("SIMPLICITY", {
      ok: false,
      attempts: 4,
      blocked: true,
      parseError: "attempt 4/4: plan timeout",
      killCause: "plan-timeout",
    }),
  );
  assert(
    r.includes("BLOCKED after 4 attempts — attempt 4/4: plan timeout (killed: timeout)"),
    "#878: timeout",
  );
  assert(
    r.includes("BLOCKED after 4 attempts — attempt 4/4: plan timeout (killed: plan-timeout)"),
    "#878: unknown cause fallback (plan-timeout)",
  );
  assert(!r.includes("not retried"), "#878: timeout/plan-timeout no not-retried");
}
{
  const r = _bs(
    lensResult("SECURITY", {
      ok: false,
      attempts: 1,
      blocked: true,
      parseError: "exit 143",
      killCause: "loop",
      loopEvidence: { tool: "bash", count: 5 },
    }),
    lensResult("PERFORMANCE", {
      ok: false,
      attempts: 1,
      blocked: true,
      parseError: "exit 143",
      killCause: "token-budget",
      tokenBudget: { budget: 50000, used: 50200 },
    }),
    lensResult("ERROR_HANDLING", { ok: true, attempts: 1, blocked: false }),
    lensResult("TYPE_SAFETY", { ok: true, attempts: 1, blocked: false }),
    lensResult("ARCHITECTURE", { ok: true, attempts: 1, blocked: false }),
    lensResult("SIMPLICITY", { ok: true, attempts: 1, blocked: false }),
  );
  assert(
    r.includes(
      "SECURITY: exit 143 (killed: loop — bash ×5; not retried: self-inflicted cap, #543)",
    ),
    "#878: banner SECURITY",
  );
  assert(
    r.includes(
      "PERFORMANCE: exit 143 (killed: token-budget — 50200/50000 tokens; not retried: self-inflicted cap, #543)",
    ),
    "#878: banner PERF",
  );
  assert(r.includes("was stopped by a self-inflicted cap (not retried)"), "#878: all-cap header");
  assert(
    r.includes("⛔ REVIEW INCOMPLETE: 2/6 lens(es) was stopped by a self-inflicted cap (not retried):"),
    "#878: all-cap full header line",
  );
  assert(!r.includes("failed all"), "#878: all-cap no failed-all");
}
{
  const r = _bs(
    lensResult("SECURITY", {
      ok: false,
      attempts: 1,
      blocked: true,
      parseError: "exit 143",
      killCause: "loop",
      loopEvidence: { tool: "bash", count: 3 },
    }),
    lensResult("ARCHITECTURE", {
      ok: false,
      attempts: 4,
      blocked: true,
      parseError: "spawn error",
    }),
    lensResult("ERROR_HANDLING", { ok: true, attempts: 1, blocked: false }),
    lensResult("TYPE_SAFETY", { ok: true, attempts: 1, blocked: false }),
    lensResult("PERFORMANCE", { ok: true, attempts: 1, blocked: false }),
    lensResult("SIMPLICITY", { ok: true, attempts: 1, blocked: false }),
  );
  assert(r.includes("did not complete (see each lens)"), "#878: mixed header");
  assert(
    r.includes("⛔ REVIEW INCOMPLETE: 2/6 lens(es) did not complete (see each lens):"),
    "#878: mixed full header line",
  );
  assert(!r.includes("failed all"), "#878: mixed no failed-all");
  assert(!r.includes("was stopped by a self-inflicted cap"), "#878: mixed no all-cap");
}
{
  const r = _bs(
    lensResult("SECURITY", {
      ok: false,
      attempts: 1,
      blocked: true,
      parseError: "attempt 1/4: exit 143",
    }),
  );
  assert(
    r.includes("BLOCKED after 1 attempts — attempt 1/4: exit 143"),
    "#878: no killCause byte-identical",
  );
  assert(!r.includes("(killed:"), "#878: no killCause no suffix");
  assert(
    r.includes("⛔ REVIEW INCOMPLETE: 1/1 lens(es) failed all 4 attempts:\n  - SECURITY: attempt 1/4: exit 143"),
    "#878: no killCause banner byte-identical (line + old header)",
  );
}


console.log(`\nexit ${exit}`);
process.exit(exit);

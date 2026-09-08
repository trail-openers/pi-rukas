#!/usr/bin/env bun
/**
 * #606 — the gap-gate prompt's parsing contract, unit-tested in isolation.
 *
 * The gap gate's reviewer reply is parsed by `parseGaps` / `parseGapsForTest`
 * in `plan-driver.ts`. The invariants this suite pins:
 *
 *   - only structured `GAP:` markers parse as gaps — bare severity words in
 *     prose are inert (the earlier regex matched them and the gate saw
 *     pseudo-gaps it could never fix),
 *   - the reviewer's own `proposed resolution:` carries through, absent
 *     resolutions keep the default placeholder,
 *   - a missing verdict defaults to READY with the MEDIUM fallback gap —
 *     silence = READY, a parse change is a conscious decision,
 *   - Bug 3 (#606): `draftSpec` renders open questions with a status — items
 *     carried from a prior gate round render as `status: resolved`, fresh ones
 *     as `status: pending`, and the `resolved:` marker itself is stripped.
 *
 * The pipeline-level e2e coverage (gate dispatch, re-injection, cap-hit)
 * lives in `test-plan-tool.ts`; this file owns the pure parsing seam.
 */

import { draftSpec } from "../src/plan-draft.ts";
import { parseGaps, parseGapsForTest } from "../src/plan-driver.ts";
import { planTitle } from "../src/plan-types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// --------------------------------- unit: parseGapsForTest (verdict + fallback)

{
  // parseGapsForTest is the seam the driver's gap gate runs on; pin the
  // verdict default (silence = READY) and the MEDIUM fallback for
  // unparseable replies so a future parse change is a conscious decision.
  const clean = parseGapsForTest("No issues found.\nVERDICT: READY");
  assert(clean.verdict === "READY", "parseGaps: explicit READY verdict");
  const silent = parseGapsForTest("looks good, nothing to flag");
  assert(
    silent.verdict === "READY" && silent.gaps.length === 1 && silent.gaps[0]?.severity === "MEDIUM",
    "parseGaps: missing verdict defaults to READY with the MEDIUM fallback gap",
  );
  const prose = parseGapsForTest("- CRITICAL — something important is missing\nVERDICT: NEEDS_ITERATION");
  assert(
    prose.verdict === "NEEDS_ITERATION" && prose.gaps.length === 1 && prose.gaps[0]?.severity === "MEDIUM",
    "parseGaps: bare severity lines without GAP: markers do NOT parse as gaps (fallback only)",
  );
}

// --------------------------------------- unit: parseGaps (GAP: markers only)

{
  // Structured markers parse with the reviewer's own resolution carried through.
  const r1 = parseGaps(
    "GAP: CRITICAL — no failure-mode criterion — proposed resolution: add the retry criterion\nGAP: HIGH — boundary unnamed\nVERDICT: NEEDS_ITERATION",
  );
  assert(r1.gaps.length === 2, `two GAP: markers parse: ${r1.gaps.length}`);
  assert(r1.gaps[0]?.severity === "CRITICAL", "severity comes from the marker");
  assert(r1.gaps[0]?.resolution === "add the retry criterion", "reviewer's resolution flows through");
  assert(r1.gaps[1]?.resolution === "address during /work plan phase", "absent resolution keeps the default placeholder");
  assert(r1.verdict === "NEEDS_ITERATION", "last verdict line wins");

  // Hyphen separator and prose severity words that must NOT parse.
  const r2 = parseGaps(
    "In summary: 0 CRITICAL, 2 HIGH gaps found overall. The HIGH items are listed below.\nGAP: LOW - cosmetic heading nit - proposed resolution: retitle\nVERDICT: READY",
  );
  assert(r2.gaps.length === 1, `prose severity words do NOT parse (1 GAP: line only): ${r2.gaps.length}`);
  assert(r2.gaps[0]?.severity === "LOW", "hyphen separator accepted");
  assert(r2.verdict === "READY", "READY verdict parsed");

  // The prompt's own example line is inert: it never begins with GAP:.
  const r3 = parseGaps(
    "Example: GAP: CRITICAL — no failure-mode acceptance criterion — proposed resolution: add a criterion\nVERDICT: NEEDS_ITERATION",
  );
  assert(r3.gaps.length === 1, "the word 'Example:' before GAP: does not match (marker must be at line start)");

  // No markers at all: the MEDIUM fallback, whatever the verdict says.
  const r4 = parseGaps("Looks fine to me.\nVERDICT: READY");
  assert(r4.gaps.length === 1 && r4.gaps[0]?.description === "no structured gaps parsed", "no-marker reply falls to the MEDIUM fallback");
  assert(r4.gaps[0]?.severity === "MEDIUM", "fallback gap is MEDIUM");
}

// --------------------------------- unit: draftSpec status rendering (Bug 3)

{
  // Bug 3 (#606): draftSpec renders open questions with a status. Items the
  // driver carries from a prior gate round are prefixed `resolved:` and
  // render as `status: resolved`; plain strings stay `status: pending`.
  const withResolved = draftSpec(
    "feature",
    "descriptor",
    [],
    [],
    ["resolved: missing acceptance criterion — proposed resolution: sharper criterion", "a fresh open question"],
    [],
    0,
  );
  assert(
    /status: resolved/.test(withResolved.body),
    "draftSpec: carried gate items render as status: resolved",
  );
  assert(
    /status: pending/.test(withResolved.body),
    "draftSpec: fresh open questions still render as status: pending",
  );
  assert(
    !/resolved: missing acceptance criterion/.test(withResolved.body),
    "draftSpec: the resolved: marker itself is stripped from the rendered question",
  );
  const plain = draftSpec("feature", "descriptor", [], [], ["no prefix, just a question"], [], 0);
  assert(
    !/status: resolved/.test(plain.body) && /status: pending/.test(plain.body),
    "draftSpec: no prefix → no resolved rendering (backward compatible)",
  );
}

// ------------------------------------------------- unit: planTitle (moved with the draft)

{
  const t = planTitle("add a start_plan_driver tool for the plan pipeline", "feature");
  assert(t.startsWith("feat: "), `title prefix: ${t}`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);

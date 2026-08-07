#!/usr/bin/env bun
/**
 * #378 — intent resolution across the real range of spec quality.
 *
 * `/work` used to assume the issue told it what to build, and a MISSING
 * verdict meant "build it" — silence was permission. Externally, 38.3% of
 * real GitHub issues are underspecified (SWE-bench Verified) and 41.77% of
 * multi-agent failures are specification-level (MAST), so underspecification
 * is the modal case rather than an edge case.
 *
 * The fixtures below are what a real backlog actually contains: a full spec, a
 * one-line human bug report, an issue contradicted by the code, an issue
 * already implemented, and a reply that drifted off-format entirely.
 */

import {
  type NormalisedSpec,
  explainPark,
  intentResolutionEnabled,
  parkAction,
  parseNormalisedSpec,
  reconcileVerdict,
  renderAssumptions,
} from "../src/work-driver-intent.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const resolve = (t: string) => {
  const p = parseNormalisedSpec(t);
  return p ? reconcileVerdict(p) : undefined;
};

// ------------------------------------------------ a well-formed spec

const WELL_FORMED = `
INTENT-VERDICT: proceed

## Spec

### Intent
Make the branch step refuse to rebuild an issue that already has an open PR.

### Deliverables
- preflight: query open PRs and match on the issue number [paths: src/work-driver-pr-preflight.ts, src/work-driver-branch-develop.ts]
- handoff: render the existing PR in the handoff body [paths: src/work-driver-handoff-message.ts]

### Acceptance criteria
- A fresh cycle with no open PR is unaffected
- A cycle with an open PR halts before any dispatch

### Out of scope
- Adopting the existing branch

### Evidence
- gh pr create is called unconditionally — src/work-driver-commit.ts:212 — confirmed

## Rationale
The issue names concrete files that exist and the behaviour matches the code.
`;

{
  const s = resolve(WELL_FORMED);
  assert(s?.verdict === "proceed", "a well-formed spec resolves to proceed");
  assert(s?.deliverables.length === 2, "deliverables are derived (2)");
  assert(
    s?.deliverables[0]?.paths.includes("src/work-driver-pr-preflight.ts") === true,
    "deliverable paths are parsed",
  );
  assert(s?.deliverables[0]?.id === "preflight", "deliverable ids are parsed");
  assert(
    s?.acceptanceCriteria.length === 2,
    "acceptance criteria are kept SEPARATE from deliverables",
  );
  assert(s?.outOfScope.length === 1, "out-of-scope is captured");
  assert(s?.evidence[0]?.verdict === "confirmed", "evidence verdicts are parsed");
}

// ------------------------------------- a one-line human bug report

{
  // The shape that matters most: no structure at all. The resolver must park
  // rather than invent deliverables.
  const s = resolve(`
INTENT-VERDICT: park
PARK-REASON: underspecified

## Spec

### Intent
Unclear — "login is broken on mobile" names no component, platform, or expected behaviour.

### Open questions
- Which login flow, and on which platform?

## Rationale
Nothing in the repo obviously corresponds to this. Building from a guess here
would produce a confident change to the wrong thing.
`);
  assert(s?.verdict === "park", "a one-line human bug report parks rather than guessing");
  assert(s?.parkReason === "underspecified", "park reason is underspecified");
  assert(s?.deliverables.length === 0, "no deliverables are invented");
  assert(
    explainPark("underspecified", 42).includes("#42"),
    "the operator explanation names the issue",
  );
  assert(
    /add acceptance criteria/.test(parkAction("underspecified", 42)),
    "the human action is specific, not 'inspect the state file'",
  );
}

// ---------------------------------- contradicted by the code

{
  // The highest-value signal this step can produce.
  const s = resolve(`
INTENT-VERDICT: park
PARK-REASON: contradicted-by-code

## Spec

### Intent
Reported: the retry budget is shared between infra and semantic failures.

### Evidence
- retryAttempts and transientRetryAttempts are separate counters — src/work-driver-step-router.ts:192 — contradicted

## Rationale
The issue describes behaviour that was changed in #366. It is stale.
`);
  assert(s?.parkReason === "contradicted-by-code", "a stale/contradicted issue parks as such");
  assert(
    s?.evidence.some((e) => e.verdict === "contradicted"),
    "the contradicting evidence is retained for the handoff",
  );
}

{
  // The resolver is an LLM and can contradict itself. Evidence wins — ignoring
  // a recorded contradiction is exactly how a wrong bug report gets built.
  const s = resolve(`
INTENT-VERDICT: proceed

## Spec

### Intent
Fix the thing.

### Deliverables
- d1: change it [paths: src/a.ts]

### Evidence
- the described function does not exist — src/a.ts — contradicted
`);
  assert(
    s?.verdict === "park" && s.parkReason === "contradicted-by-code",
    "a 'proceed' claimed alongside contradicting evidence is overridden to park",
  );
}

// ---------------------------------------- already implemented / too large

{
  const s = resolve(
    "INTENT-VERDICT: park\nPARK-REASON: already-implemented\n\n## Spec\n\n### Intent\nAlready done.\n",
  );
  assert(s?.parkReason === "already-implemented", "already-implemented parks as such");
  assert(/close/.test(parkAction("already-implemented", 9)), "its action is to confirm and close");
}
{
  const s = resolve(
    "INTENT-VERDICT: park\nPARK-REASON: too-large\n\n## Spec\n\n### Intent\nEverything.\n",
  );
  assert(s?.parkReason === "too-large", "too-large parks as such");
  assert(/split/.test(parkAction("too-large", 9)), "its action is to split the issue");
}

// ------------------------------------------------- silence is not permission

{
  // The inversion. Pre-#378, `work-driver-plan.ts` defaulted a missing verdict
  // to NEEDS_WORK, so an agent that simply forgot the token got code written.
  const s = resolve("## Spec\n\n### Intent\nSomething.\n\n### Deliverables\n- d1: do it\n");
  assert(s?.verdict === "park", "a MISSING verdict parks — silence is not permission");
  assert(s?.parkReason === "underspecified", "and carries an honest default reason");
}
{
  const s = resolve("INTENT-VERDICT: banana\n\n## Spec\n\n### Intent\nx\n");
  assert(s?.verdict === "park", "an unparseable verdict parks");
}
{
  // A reply with no Spec block at all returns undefined, so runExplore falls
  // back to the legacy router rather than parking every cycle on drift.
  assert(
    parseNormalisedSpec("VERDICT: NEEDS_WORK\n\nSome prose, no spec block.") === undefined,
    "no `## Spec` block → undefined, so the legacy verdict router still applies",
  );
}

// ------------------------------------------------------- assumptions

{
  const s = resolve(`
INTENT-VERDICT: proceed-with-assumptions

## Spec

### Intent
Add a retry.

### Deliverables
- d1: add the retry [paths: src/a.ts]

### Assumptions
- Retry 3 times — matches the existing TRANSIENT_MAX_RETRIES elsewhere in the driver
`);
  assert(s?.verdict === "proceed-with-assumptions", "gaps with defensible defaults proceed");
  assert(
    s?.assumptions[0]?.basis.includes("TRANSIENT_MAX_RETRIES") === true,
    "the basis is parsed",
  );
  const block = renderAssumptions(s as NormalisedSpec);
  assert(/## Assumptions made/.test(block), "assumptions render into the PR body");
  assert(
    /Retry 3 times/.test(block),
    "the assumption text reaches review — otherwise 'proceed-with-assumptions' is not honest",
  );
}
{
  // Recording assumptions while claiming a plain `proceed` understates what
  // review needs to see.
  const s = resolve(
    "INTENT-VERDICT: proceed\n\n## Spec\n\n### Intent\nx\n\n### Assumptions\n- assumed a default — no basis given\n",
  );
  assert(
    s?.verdict === "proceed-with-assumptions",
    "a plain 'proceed' carrying assumptions is promoted so they reach the PR body",
  );
}
{
  assert(
    renderAssumptions({ assumptions: [] } as unknown as NormalisedSpec) === "",
    "no assumptions → no block (no empty section in the PR body)",
  );
}

// ------------------------------------------------------------ escape hatch

{
  const prev = process.env.PI_ENSEMBLE_INTENT;
  process.env.PI_ENSEMBLE_INTENT = "0";
  try {
    assert(!intentResolutionEnabled(), "PI_ENSEMBLE_INTENT=0 disables intent resolution");
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_INTENT;
    else process.env.PI_ENSEMBLE_INTENT = prev;
  }
  assert(intentResolutionEnabled(), "and it is ON by default");
}

console.log(`\nexit ${exit}`);
process.exit(exit);

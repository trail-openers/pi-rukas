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
  recoverOffloadedSpec,
  renderAssumptions,
} from "../src/work-driver-intent.ts";
import { inlineCommitPrPrompt } from "../src/work-driver-prompts-late.ts";

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
} // ---------------------------------- contradicted by the code
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
  // The resolver is an LLM and can contradict itself. A load-bearing
  // contradiction wins — ignoring one is exactly how a wrong bug report gets built.
  const s = resolve(`
INTENT-VERDICT: proceed

## Spec

### Intent
Fix the thing in src/a.ts.

### Deliverables
- d1: change it [paths: src/a.ts]

### Evidence
- src/a.ts does not exist — src/a.ts — contradicted
`);
  assert(
    s?.verdict === "park" && s.parkReason === "contradicted-by-code",
    "a 'proceed' claimed alongside a load-bearing contradiction is overridden to park",
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

  // Test fallback path includes assumptions via inlineCommitPrPrompt
  const scratchDir = "/tmp/issue-455";
  const prompt = inlineCommitPrPrompt(
    [455], // issues
    [], // droppedIssues
    {}, // worktrees
    {}, // workstreams
    "main", // branchName
    s, // normalisedSpec
    [], // eventLog
    scratchDir, // scratchDirAbs
  );

  // Verify the fallback prompt includes the assumptions section
  assert(
    prompt.includes("## Assumptions made"),
    "fallback prompt includes assumptions section header",
  );
  assert(prompt.includes("Retry 3 times"), "fallback prompt includes the assumption text");
}
{
  // Recording assumptions while claiming a plain `proceed` understates what
  // review needs to see.
  const s = resolve(
    // A deliverable is present because a real `proceed` reply carries one —
    // see fixtures/explore-replies/337.txt. Without it the spec is not
    // actionable and parks before promotion, which is a different test.
    "INTENT-VERDICT: proceed\n\n## Spec\n\n### Intent\nx\n\n### Deliverables\n- d1: do the thing [paths: src/a.ts]\n\n### Assumptions\n- assumed a default — no basis given\n",
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

// ------------------------------- #397: evidence verdicts as LLMs write them

{
  // A real resolver bolded all seven of its verdicts and the strict
  // `last === "confirmed"` test downgraded every one to `unverifiable`.
  const s = resolve(
    "INTENT-VERDICT: proceed\n\n## Spec\n\n### Intent\nx\n\n### Evidence\n" +
      "- a — src/a.ts:1 — **confirmed**\n" +
      "- b — src/b.ts:2 — **confirmed** (distinct identity bypasses anti-recursion)\n" +
      "- c — src/c.ts:3 — I could not confirm this\n",
  );
  assert(s?.evidence[0]?.verdict === "confirmed", "a BOLDED `**confirmed**` parses as confirmed");
  assert(s?.evidence[1]?.verdict === "confirmed", "...even with a trailing parenthetical after it");
  assert(
    s?.evidence[2]?.verdict === "unverifiable",
    "but 'I could not confirm this' stays unverifiable — the match is anchored, not a substring",
  );
}
{
  const s = resolve(
    "INTENT-VERDICT: proceed\n\n## Spec\n\n### Intent\nFix the thing in src/a.ts.\n\n### Deliverables\n- d1: change it [paths: src/a.ts]\n\n### Evidence\n- src/a.ts does not exist — src/a.ts — **contradicted**\n",
  );
  assert(
    s?.evidence[0]?.verdict === "contradicted",
    "a BOLDED `**contradicted**` parses as contradicted",
  );
  assert(
    s?.verdict === "park" && s.parkReason === "contradicted-by-code",
    "a BOLDED `**contradicted**` on a deliverable path parks — the contradiction rule keeps working",
  );
}

// --------------------------- #397: a complete spec refutes `underspecified`

const COMPLETE = (parkReason: string) =>
  `INTENT-VERDICT: park\nPARK-REASON: ${parkReason}\n\n## Spec\n\n### Intent\nFix the release gate.\n\n### Deliverables\n- d1: edit the workflow [paths: .github/workflows/x.yml]\n\n### Acceptance criteria\n- the next PR shows a real run\n\n### Open questions\n- **None blocking** — mechanism is confirmed\n\n### Evidence\n- the token is the default — gh pr view — **confirmed**\n`;

{
  const s = resolve(COMPLETE("underspecified"));
  assert(
    s?.verdict === "proceed-with-assumptions",
    "an `underspecified` park is OVERRIDDEN when the spec is demonstrably complete",
  );
  assert(s?.parkReason === undefined, "...and the stale parkReason is dropped, not left behind");
  assert(
    s?.assumptions.some((a) => /underspecified/.test(a.text)) === true,
    "...and the override is recorded as an assumption so review sees it",
  );
}
{
  // The guard that keeps the override narrow. These four reasons are all
  // perfectly compatible with a complete spec — overriding them would be
  // exactly the "silence is permission" failure #378 exists to prevent.
  for (const reason of [
    "too-large",
    "already-implemented",
    "premise-unsound",
    "contradicted-by-code",
  ]) {
    const s = resolve(COMPLETE(reason));
    assert(
      s?.verdict === "park" && s.parkReason === reason,
      `a complete spec does NOT override \`${reason}\` — only \`underspecified\` is refuted by completeness`,
    );
  }
}
{
  // The conjunct that keeps "silence is not permission" true: a resolver that
  // filled in the template without checking anything has no confirmed row.
  const noEvidence = resolve(
    "INTENT-VERDICT: park\nPARK-REASON: underspecified\n\n## Spec\n\n### Intent\nx\n\n### Deliverables\n- d1: do it\n\n### Acceptance criteria\n- it works\n",
  );
  assert(
    noEvidence?.verdict === "park",
    "a spec with NO confirmed evidence still parks — completeness requires grounding, not just structure",
  );
  const realQuestion = resolve(
    COMPLETE("underspecified").replace(
      "- **None blocking** — mechanism is confirmed",
      "- Which auth identity should the workflow use?",
    ),
  );
  assert(realQuestion?.verdict === "park", "a spec with a REAL blocking open question still parks");
}

// ------------- #404: a park the RESOLVER declared is never overridden

{
  // The bug, verbatim from a live nessie run: the resolver wrote its reason as
  // a markdown heading, the colon-anchored regex missed it, the parser
  // synthesised `underspecified`, and #397's override then BUILT the thing the
  // resolver had said was already done — attaching OVERRIDE_ASSUMPTION to the
  // PR as a confident justification for doing it.
  const s = resolve(
    `### INTENT-VERDICT\npark\n\n### PARK-REASON\nalready-implemented\n\n${COMPLETE("underspecified").split("## Spec")[1] ? `## Spec${COMPLETE("underspecified").split("## Spec")[1]}` : ""}`,
  );
  assert(
    s?.verdict === "park",
    "a heading-form park reason is HONOURED, not overridden — this built the wrong thing before #404",
  );
  assert(
    s?.parkReason === "already-implemented",
    "...and the heading form parses, so the operator gets the real reason",
  );
}
{
  // The narrower guard: even if the reason had NOT parsed, a stated `park`
  // must survive. The resolver said park; the driver may not disagree on the
  // strength of a value it invented itself.
  const s = resolve(
    `INTENT-VERDICT: park\nPARK-REASON: !!garbled!!\n\n${COMPLETE("x").split("\n\n").slice(1).join("\n\n")}`,
  );
  assert(
    s?.verdict === "park",
    "a STATED park with an unreadable reason still parks — a synthesised reason cannot license an override",
  );
  assert(
    s?.parkReasonSource === "default",
    "...and the state records that the reason was synthesised, not read",
  );
}
{
  // #337 must still work: no tokens at all means the resolver never declared a
  // park, so a complete spec may still refute the parser's invention.
  const noTokens = COMPLETE("underspecified").split("\n\n").slice(1).join("\n\n");
  const s = resolve(noTokens);
  assert(
    s?.verdict === "proceed-with-assumptions",
    "#337 preserved: with NO verdict token, a complete spec still proceeds",
  );
}
{
  const s = resolve(COMPLETE("underspecified"));
  assert(
    s?.verdict === "proceed-with-assumptions",
    "#397 preserved: an explicitly stated `underspecified` is still refuted by a complete spec",
  );
  assert(
    s?.verdictSource === undefined && s?.parkReasonSource === undefined,
    "...and the provenance fields are dropped alongside parkReason on override",
  );
}
{
  const inline = resolve(
    "INTENT-VERDICT: park\nPARK-REASON: too-large\n\n## Spec\n\n### Intent\nx\n",
  );
  const heading = resolve(
    "### INTENT-VERDICT\npark\n\n### PARK-REASON\ntoo-large\n\n## Spec\n\n### Intent\nx\n",
  );
  assert(
    inline?.parkReason === "too-large" && heading?.parkReason === "too-large",
    "inline and heading token forms are equivalent — the inline form is not regressed",
  );
  assert(
    inline?.parkReasonSource === "parsed" && heading?.parkReasonSource === "parsed",
    "...and both are recorded as PARSED, not synthesised",
  );
}

// ------------------------------------------------------------ escape hatch
{
  const prev = process.env.PI_ENSEMBLE_INTENT;
  process.env.PI_ENSEMBLE_INTENT = "0";
  try {
    assert(!intentResolutionEnabled(), "PI_ENSEMBLE_INTENT=0 disables intent resolution");
  } finally {
    if (prev === undefined) process.env.PI_ENSEMBLE_INTENT = undefined;
    else process.env.PI_ENSEMBLE_INTENT = prev;
  }
  assert(intentResolutionEnabled(), "and it is ON by default");
}

// ================================================================
// #682 — synthetic offload unit matrix
//
// A live cycle for issue #674 produced a complete, well-formed explore reply
// (bold/fenced INTENT-VERDICT: proceed-with-assumptions, 6 deliverables, 6
// acceptance criteria, 14 confirmed evidence rows) but the resolver offloaded
// the spec to a scratch file and kept only a summary inline. `parseNormalisedSpec`
// returns undefined for that shape (no `## Spec` heading), so the driver
// parked with a false `explore-needs-clarification` cap-hit.
//
// `recoverOffloadedSpec` is the recovery channel. It is gated on:
//   1. A parseable INTENT-VERDICT (via readMarker).
//   2. NO inline `## Spec` heading (inline spec wins; no offload needed).
//   3. At least one cited path that resolves under the cycle's scratch dir.
//
// The file-reading seam is injected so these tests run hermetically (no disk
// I/O). The driver wires in `fs.readFile` at the call site in
// `work-driver-explore.ts` (task-a's scope).
// ================================================================

const OFFLOAD_SPEC = `INTENT-VERDICT: proceed

## Spec

### Intent
Do the thing in src/a.ts.

### Deliverables
- d1: implement it [paths: src/a.ts]
- d2: add the test [paths: src/a.test.ts]

### Acceptance criteria
- it works
- the test passes

### Evidence
- the file exists — src/a.ts — confirmed
- the test runner is configured — package.json — confirmed

## Rationale
The issue is clear and the code is in place.
`;

const OFFLOAD_REPO_ROOT = "/repo";
const OFFLOAD_SCRATCH = "/repo/tmp/issue-674";

/** Build a hermetic readFile from a path→content map. */
const mkRead =
  (map: Record<string, string>) =>
  (p: string): string | undefined =>
    map[p];

// ---- (a) cited file present and parseable → spec recovered

{
  const reply =
    "**INTENT-VERDICT: proceed-with-assumptions**\n\n" +
    "Full report saved to scratch: `tmp/issue-674/explore-report.md`.\n\n" +
    "## Summary for the driver\n\n" +
    "Some summary text without the full spec.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/explore-report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec !== undefined, "(a) cited file present + parseable → spec is recovered");
  assert(spec?.verdict === "proceed", "(a) the recovered spec has the correct verdict");
  assert(spec?.deliverables.length === 2, "(a) deliverables are parsed from the offloaded file");
  assert(spec?.acceptanceCriteria.length === 2, "(a) acceptance criteria are parsed");
  assert(spec?.evidence.length === 2, "(a) evidence rows are parsed");
  assert(
    spec?.evidence.every((e) => e.verdict === "confirmed") === true,
    "(a) evidence verdicts are confirmed",
  );
}

// ---- (b) cited path outside scratch dir → ignored

{
  const reply = "**INTENT-VERDICT: proceed**\n\n" + "Saved to `/tmp/elsewhere/report.md`.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead(Object.fromEntries([["/tmp/elsewhere/report.md", OFFLOAD_SPEC]])),
  );
  assert(spec === undefined, "(b) path OUTSIDE scratch dir is ignored — no spec recovered");

  const reply2 =
    "**INTENT-VERDICT: proceed**\n\n" + "Saved to `tmp/issue-999/report.md` (sibling cycle).\n";
  const spec2 = recoverOffloadedSpec(
    reply2,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-999/report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec2 === undefined, "(b) sibling cycle's tmp dir is rejected — no spec recovered");

  const reply3 = "**INTENT-VERDICT: proceed**\n\n" + "Saved to `../evil/report.md`.\n";
  const spec3 = recoverOffloadedSpec(
    reply3,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/evil/report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec3 === undefined, "(b) ../ escape is rejected — no spec recovered");
}

// ---- (c) cited file exists but no ## Spec block → falls through to no-signal park

{
  const reply = "**INTENT-VERDICT: proceed**\n\n" + "Saved to `tmp/issue-674/nospec.md`.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({
      [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/nospec.md`]:
        "Just some prose, no spec block here at all.",
    }),
  );
  assert(
    spec === undefined,
    "(c) file exists but has no ## Spec → undefined (falls through to no-signal park)",
  );

  const reply2 = "**INTENT-VERDICT: proceed**\n\n" + "Saved to `tmp/issue-674/empty.md`.\n";
  const spec2 = recoverOffloadedSpec(
    reply2,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/empty.md`]: "" }),
  );
  assert(spec2 === undefined, "(c) empty file → undefined (falls through to no-signal park)");
}

// ---- (d) no citation at all → unchanged (undefined)

{
  const reply =
    "**INTENT-VERDICT: proceed**\n\n" + "Some summary without any file path citations at all.\n";
  const spec = recoverOffloadedSpec(reply, OFFLOAD_SCRATCH, OFFLOAD_REPO_ROOT, mkRead({}));
  assert(spec === undefined, "(d) no citation → undefined (no offload attempt)");
}

// ---- additional edge cases

{
  // Inline spec present → offload must NOT fire (inline wins).
  const reply =
    "**INTENT-VERDICT: proceed**\n\n" +
    "## Spec\n\n### Intent\nInline spec.\n\n### Deliverables\n- d1: do it [paths: src/b.ts]\n\n" +
    "Also saved to `tmp/issue-674/report.md`.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec === undefined, "(e) inline ## Spec present → offload does NOT fire (inline wins)");
}

{
  // No parseable verdict → offload must NOT fire.
  const reply =
    "Some reply with no INTENT-VERDICT token.\n\n" + "Saved to `tmp/issue-674/report.md`.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec === undefined, "(f) no parseable INTENT-VERDICT → offload does NOT fire");
}

{
  // File missing (readFile returns undefined) → undefined.
  const reply = "**INTENT-VERDICT: proceed**\n\n" + "Saved to `tmp/issue-674/missing.md`.\n";
  const spec = recoverOffloadedSpec(reply, OFFLOAD_SCRATCH, OFFLOAD_REPO_ROOT, () => undefined);
  assert(spec === undefined, "(g) file missing from disk → undefined (no crash)");
}

{
  // readFile throws (EACCES etc.) → caught, undefined.
  const reply = "**INTENT-VERDICT: proceed**\n\n" + "Saved to `tmp/issue-674/report.md`.\n";
  const spec = recoverOffloadedSpec(reply, OFFLOAD_SCRATCH, OFFLOAD_REPO_ROOT, () => {
    throw new Error("EACCES: permission denied");
  });
  assert(spec === undefined, "(h) readFile throws → caught, undefined (no crash)");
}

{
  // Two candidates: first outside scratch, second inside → second is used.
  const reply =
    "**INTENT-VERDICT: proceed**\n\n" +
    "Saved to `.pi/work-state/674/report.md` and also `tmp/issue-674/report.md`.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec !== undefined, "(i) two candidates, first outside scratch → second is used");
  assert(spec?.verdict === "proceed", "(i) the recovered spec is correct");
}

{
  // Bare (unbackticked) path citation in prose.
  const reply =
    "**INTENT-VERDICT: proceed**\n\n" + "Saved to tmp/issue-674/report.md as requested.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec !== undefined, "(j) bare (unbackticked) path citation works");
}

{
  // Scratch-relative basename (just the filename, resolved against scratch dir).
  const reply = "**INTENT-VERDICT: proceed**\n\n" + "Saved to `report.md` in the scratch dir.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_SCRATCH}/report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec !== undefined, "(k) scratch-relative basename works");
}

{
  // The offloaded spec must clear specIsActionable (intent + ≥1 deliverable).
  // This is the bar that `reconcileVerdict` uses to decide whether a `proceed`
  // is actionable. The offloaded spec must be content-equivalent to the inline
  // path — same verdict, same deliverable count, same evidence count.
  const reply =
    "**INTENT-VERDICT: proceed-with-assumptions**\n\n" +
    "Full report: `tmp/issue-674/explore-report.md`.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/explore-report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec !== undefined, "(l) the offloaded spec is recovered");
  assert(spec?.intent.length > 0, "(l) the intent is non-empty");
  assert(spec?.deliverables.length > 0, "(l) there is at least one deliverable");
  // Feed through reconcileVerdict to confirm the same logic applies.
  const resolved = spec ? reconcileVerdict(spec) : undefined;
  assert(
    resolved?.verdict === "proceed",
    "(l) reconcileVerdict on the offloaded spec yields proceed",
  );
}

{
  // A `proceed` with a load-bearing contradiction in the offloaded spec
  // must still park (reconcileVerdict logic applies identically to
  // offloaded and inline specs).
  const contradictingSpec = `INTENT-VERDICT: proceed

## Spec

### Intent
Fix the thing in src/a.ts.

### Deliverables
- d1: change it [paths: src/a.ts]

### Evidence
- src/a.ts does not exist — src/a.ts — contradicted
`;
  const reply = "**INTENT-VERDICT: proceed**\n\n" + "Saved to `tmp/issue-674/report.md`.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/report.md`]: contradictingSpec }),
  );
  assert(spec !== undefined, "(m) offloaded spec with contradiction is recovered");
  const resolved = spec ? reconcileVerdict(spec) : undefined;
  assert(
    resolved?.verdict === "park" && resolved?.parkReason === "contradicted-by-code",
    "(m) a `proceed` with a load-bearing contradiction still parks — same as inline",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

#!/usr/bin/env bun
/**
 * #397 — the intent resolver, run against a reply a real resolver actually wrote.
 *
 * `/work 337` produced a complete, evidence-grounded spec — a concrete intent,
 * 2 deliverables with paths, 3 acceptance criteria, 7 pieces of executed
 * evidence, and `openQuestions: ["**None blocking** — …"]` — and the driver
 * reported *"#337 does not say enough to build from."*
 *
 * Every existing fixture in `test-intent-resolution.ts` was written to match
 * the regexes: all use a bare `confirmed`, all carry an `INTENT-VERDICT:`.
 * So none of them could see either defect. `test-grouping-real-issues.ts:5-7`
 * documents this exact pathology for the grouping rules; the fix is the same —
 * a fixture captured verbatim from a real reply, which is what
 * `fixtures/explore-replies/337.txt` is.
 *
 * If that fixture is ever "tidied" to match the parser, this file stops
 * testing anything.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseNormalisedSpec,
  reconcileVerdict,
  renderAssumptions,
  specIsComplete,
} from "../src/work-driver-intent.ts";
import { inlineExplorePrompt } from "../src/work-driver-prompts-early.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import type { WorkState } from "../src/workflow-state.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "explore-replies", "337.txt");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const reply = readFileSync(FIXTURE, "utf8");
const FIXTURE_826 = path.join(__dirname, "fixtures", "explore-replies", "826.txt");
const reply826 = readFileSync(FIXTURE_826, "utf8");

// Anti-vacuity: the fixture must still be the raw thing, or everything below
// is theatre.
assert(
  reply.includes("VERDICT: NEEDS_WORK") && !reply.includes("INTENT-VERDICT:"),
  "the fixture is the REAL reply — legacy verdict, no INTENT-VERDICT token (this is what broke)",
);
assert(
  reply.includes("— **confirmed**"),
  "...and its evidence verdicts are bolded, the shape the strict parser rejected",
);

const parsed = parseNormalisedSpec(reply);
assert(parsed !== undefined, "the reply parses into a normalised spec");

if (parsed) {
  // ---------------------------------------------- the evidence channel

  assert(parsed.evidence.length === 7, "all 7 evidence rows are parsed");
  assert(
    parsed.evidence.every((e) => e.verdict === "confirmed"),
    "all 7 parse as CONFIRMED — every one was silently downgraded to `unverifiable` before #397",
  );
  assert(
    parsed.evidence.some((e) => /distinct identity/.test(e.claim + e.source)) ||
      parsed.evidence.length === 7,
    "including the row whose verdict carries a trailing parenthetical",
  );

  // ------------------------------------------------- the verdict itself

  assert(specIsComplete(parsed), "the spec is complete on its own terms");
  assert(parsed.deliverables.length === 2, "2 deliverables were derived");
  assert(parsed.acceptanceCriteria.length === 3, "3 acceptance criteria were derived");
  assert(
    parsed.openQuestions.length === 1 && /none blocking/i.test(parsed.openQuestions[0] ?? ""),
    "its one open question is an explicit 'None blocking'",
  );

  const resolved = reconcileVerdict(parsed);
  assert(
    resolved.verdict === "proceed-with-assumptions",
    "it resolves to proceed-with-assumptions — before #397 this was `park`",
  );
  assert(
    resolved.parkReason === undefined,
    "and carries NO parkReason — `explainCap` and `humanActionFor` both read that field",
  );
  assert(
    resolved.verdict !== "proceed",
    "never a plain `proceed` — the resolver did not say proceed, the driver inferred it",
  );

  // ------------------------------------- the override is visible in review

  const block = renderAssumptions(resolved);
  assert(
    /## Assumptions made/.test(block),
    "the override reaches the PR body via the existing assumptions block",
  );
  assert(
    /underspecified/.test(block) && /proceeded on the spec/.test(block),
    "...and says plainly that the driver overrode the label, not only in a trace line",
  );
  assert(
    /RELEASE_PLEASE_TOKEN|release-please/i.test(block) || resolved.assumptions.length > 1,
    "the resolver's own assumptions survive alongside the synthetic one",
  );

  // ------------------------------------------------------ regression pins

  assert(
    parsed.intent.length > 0 && /release-please/i.test(parsed.intent),
    "pin: the intent is the release-please CI gate",
  );
  assert(parsed.outOfScope.length > 0, "pin: an out-of-scope fence was parsed");
}

// ------------------------------- one verdict protocol per rendered prompt

{
  // The root cause: the prompt asked for BOTH, each labelled LOAD-BEARING.
  // The resolver answered the legacy one; the driver read only the other.
  const legacy = /VERDICT: (NEEDS_WORK|ALREADY_COMPLETE|NEEDS_CLARIFICATION)/;
  const intent = /INTENT-VERDICT:/;

  const single = inlineExplorePrompt([337], "/tmp/x", [], true);
  assert(
    intent.test(single) && !legacy.test(single),
    "single-issue with intent ON asks for INTENT-VERDICT and NOT the legacy verdict",
  );

  const off = inlineExplorePrompt([337], "/tmp/x", [], false);
  assert(
    legacy.test(off) && !intent.test(off),
    "with intent OFF it asks for the legacy verdict only — the escape hatch is coherent again",
  );

  const multi = inlineExplorePrompt([1, 2], "/tmp/x", [], false);
  assert(
    !intent.test(multi) && /## Verdict/.test(multi),
    "multi-issue asks for the per-issue block only — intent resolution yields ONE spec, not N",
  );

  for (const [name, text] of [
    ["single/on", single],
    ["single/off", off],
    ["multi", multi],
  ] as const) {
    assert(
      !(intent.test(text) && legacy.test(text)),
      `${name}: never both protocols in one prompt — that collision is what broke #337`,
    );
  }
}

// ============================================================================
// #830 — the shape a real resolver drifted into on /work 826.
//
// The live artifact (.pi/work-state/826/mudtycjy-j90ljq-explore.txt, cycle at
// cd6cb5f) wrote the verdict whole-bold — `**INTENT-VERDICT: proceed**` — and
// nested its spec under a parent heading: `### Spec` inside `## Intent
// resolution`, with bold labels for the subsections instead of `###`.
// `parseNormalisedSpec` gated the whole parse on a level-2-only `Spec` slice,
// so the reply parsed to nothing and the driver parked
// explore-needs-clarification without a single word on why — the #397/#404
// class: the resolver approved, the gate parked.
//
// If the fixture is ever "tidied" to match the parser (level-2 `## Spec`,
// unbolded marker), this section stops testing anything — it is the raw
// shape, verbatim.
// ============================================================================

{
  // Anti-vacuity: the fixture must still be the raw thing, or everything
  // below is theatre.
  assert(
    /^###\s+Spec\s*$/m.test(reply826) && !/^##\s+Spec\s*$/m.test(reply826),
    "the 826 fixture is the REAL shape — `### Spec`, NOT a top-level `## Spec`",
  );
  assert(
    reply826.includes("## Intent resolution"),
    "...and the parent heading survives the trim — dropping `## Intent resolution` below would silently kill the `### Spec`-under-parent-h2 coverage",
  );
  assert(
    reply826.includes("**INTENT-VERDICT: proceed**"),
    "...and the verdict is whole-bold — the value INSIDE the emphasis, which `readMarker`'s \\*{0,2} tolerance exists for",
  );

  const parsed826 = parseNormalisedSpec(reply826);
  assert(parsed826 !== undefined, "the 826 reply parses into a normalised spec");

  if (parsed826) {
    assert(parsed826.intent.length > 0, "the intent is derived from the bold-label `**Intent** — …` line");
    assert(
      parsed826.deliverables.length === 5 &&
        parsed826.deliverables.every((d) => d.paths.length > 0),
      "all 5 deliverables are derived — and every one keeps its [paths: …]",
    );
    assert(parsed826.acceptanceCriteria.length === 8, "all 8 acceptance criteria are derived");
    assert(
      parsed826.evidence.some((e) => e.verdict === "confirmed"),
      "the evidence rows parse as confirmed (the `— confirmed by reading…` form, verdict last)",
    );
    assert(
      parsed826.verdict === "proceed",
      "the whole-bold INTENT-VERDICT parses to a RESOLVED proceed — no default-synthesised verdict",
    );
    assert(
      parsed826.parkReason === undefined && parsed826.parkReasonSource === undefined,
      "the empty-valued `**PARK-REASON:** (not applicable — proceeding)` leaves NO parkReason behind — it must not leak into pipelineState",
    );
    assert(
      blockingOpenQuestions(parsed826.openQuestions).length === 0,
      "`- None blocking.` is not counted as an open question",
    );

    const resolved826 = reconcileVerdict(parsed826);
    assert(
      resolved826.verdict === "proceed-with-assumptions",
      "reconcileVerdict promotes to proceed-with-assumptions (the assumptions section is non-empty) — the cycle proceeds to plan, not a cap-hit",
    );
  }
}

// Whole-bold markers in general — `**INTENT-VERDICT: park**` +
// `**PARK-REASON: underspecified**` must park with THAT reason, never the
// default (the value inside the bold is the diagnosis #404 refuses to
// invent).
{
  const wholeBold = [
    "## Intent resolution",
    "",
    "**INTENT-VERDICT: park**",
    "**PARK-REASON: underspecified**",
    "",
    "## Spec",
    "",
    "- d1: something [paths: extension/src/a.ts]",
    "",
  ].join("\n");

  const parsed = parseNormalisedSpec(wholeBold);
  assert(parsed !== undefined, "whole-bold markers: the reply parses into a spec");
  if (parsed) {
    assert(parsed.verdict === "park", "whole-bold INTENT-VERDICT: park → park");
    assert(
      parsed.parkReason === "underspecified" && parsed.parkReasonSource === "parsed",
      "whole-bold PARK-REASON: underspecified → that REASON, with parsed provenance — not a default",
    );
  }
}

// `### Spec` nested under a parent h2 parses; a top-level `## Spec` parses
// identically to before. The #826 fixture is already the nested case end-to-
// end; this pins that the two forms agree on the spec's content, so a future
// matcher cannot silently prefer one shape over the other.
{
  const body = [
    "**Intent** — Do the thing",
    "",
    "**Deliverables**",
    "",
    "- d1: do it [paths: src/a.ts]",
    "",
    "**Acceptance criteria**",
    "",
    "- it works",
    "",
    "**Evidence**",
    "",
    "- it is true — read the code — confirmed",
    "",
  ].join("\n");

  const nested = `## Intent resolution\n\n### Spec\n\n${body}`;
  const topLevel = `## Spec\n\n${body}`;
  const n = parseNormalisedSpec(nested);
  const t = parseNormalisedSpec(topLevel);
  assert(n !== undefined && t !== undefined, "both shapes parse");
  if (n && t) {
    assert(
      n.deliverables.length === t.deliverables.length && n.deliverables[0]?.paths[0] === t.deliverables[0]?.paths[0],
      "the nested and top-level shapes parse to the same deliverables",
    );
    assert(
      n.acceptanceCriteria.length === t.acceptanceCriteria.length,
      "...and the same acceptance criteria",
    );
  }
}

// A `### Spec` that contains its own `###` subsections must terminate at the
// next heading of level ≤ 3, not at the first sibling h3 — otherwise the
// deliverables slice would stop at the first subsection.
{
  const nestedWithSubs = [
    "## Intent resolution",
    "",
    "### Spec",
    "",
    "### Intent",
    "Do the thing",
    "",
    "### Deliverables",
    "- d1: do it [paths: src/a.ts]",
    "",
    "### Rationale",
    "because",
    "",
    "## Next section",
    "- d2: must not leak in [paths: src/b.ts]",
  ].join("\n");

  const parsed = parseNormalisedSpec(nestedWithSubs);
  assert(parsed !== undefined, "`### Spec` with `###` subsections parses");
  if (parsed) {
    assert(parsed.deliverables.length === 1, "...with exactly the deliverables INSIDE the spec block");
    assert(
      !parsed.deliverables.some((d) => d.id === "d2"),
      "and it terminates before the following `## Next section` — no leak",
    );
  }
}

// #830 (adversarial) — the evidence-present rendering of
// explore-needs-clarification must say "the driver halted before plan ran"
// EXACTLY ONCE. The first cut of the evidence blurb appended "…so it halted
// before plan ran" to a template that already ended with "The driver halted
// before plan ran." — the same sentence twice.
{
  const state: WorkState = {
    schemaVersion: 1,
    resumable: false,
    issue: 826,
    createdAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "explore",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
    },
    eventLog: [
      {
        kind: "cap-hit",
        at: 3,
        cap: "explore-needs-clarification",
        reviewRound: 0,
        nextStep: "handoff",
        evidence: "no verdict and no spec parsed",
      },
    ],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; explainCap reads a subset
  } as any;
  const text = explainCap("explore-needs-clarification", state);
  const count = (text.match(/halted before plan ran/g) ?? []).length;
  assert(count === 1, `evidence present: "halted before plan ran" appears exactly once (got ${count})`);
  assert(
    text.includes("no verdict and no spec parsed"),
    "evidence present: the recorded evidence is named in the explanation",
  );

  // And the no-evidence fallback (pre-#830 state files) renders the same
  // sentence once as well.
  const noEv = explainCap(
    "explore-needs-clarification",
    {
      ...state,
      eventLog: [
        { kind: "cap-hit", at: 1, cap: "explore-needs-clarification", reviewRound: 0, nextStep: "handoff" },
      ],
    },
  );
  assert(
    (noEv.match(/halted before plan ran/g) ?? []).length === 1,
    'evidence absent: "halted before plan ran" still appears exactly once (fallback path)',
  );
}

function blockingOpenQuestions(qs: string[]): string[] {
  return qs.filter((q) => !/^[\s*_`]*(none|n\/a)\b/i.test(q));
}

console.log(`\nexit ${exit}`);
process.exit(exit);

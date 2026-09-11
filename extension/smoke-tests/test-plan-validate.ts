#!/usr/bin/env bun
/**
 * Phase 3b — deterministic draft validation (plan-validate.ts).
 *
 * A draft whose load-bearing sections fell back to placeholder strings used
 * to reach the LLM gap gate (paying a reviewer dispatch to notice junk) or
 * — for the types the gate does not cover — the forge. The validator is
 * narrow by design: bug/feature need a non-fallback Acceptance criteria
 * section; an epic (below the depth limit) needs an actual decomposition of
 * sane size; chore/spike add nothing beyond the all-angles-failed guard.
 *
 * The fallback strings are single-sourced in plan-validate.ts and imported
 * by draftSpec — these tests build bodies THROUGH draftSpec so a reworded
 * placeholder that stops matching the validator fails here.
 */

import { draftSpec } from "../src/plan-draft.ts";
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { applyNeverClaimFilter } from "../src/plan-investigate.ts";
import { EPIC_SUB_ISSUE_MAX, bodyContainsForbiddenPhrase, validateDraft } from "../src/plan-validate.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };

function findingsWith(items: { kind: string; text: string }[]) {
  return [
    {
      name: "x",
      ok: true,
      text: "prose",
      toolUses: items.map((i) => ({ ...i, angle: "x" })),
    },
  ];
}

// ------------------------------------------------------------------- units

{
  // Feature with only edge-case items → AC section falls back → invalid.
  const noAc = draftSpec(
    "feature",
    "d",
    findingsWith([{ kind: "edge-case", text: "a pitfall" }]),
    [],
    [],
    [],
    0,
    NO_DIRS,
    [],
  );
  const v = validateDraft("feature", noAc.body, 0);
  assert(!v.ok, "feature with fallback Acceptance criteria is invalid");
  assert(/Acceptance criteria/.test(v.problems[0] ?? ""), "the problem names the section");

  // Feature with a real AC → valid.
  const withAc = draftSpec(
    "feature",
    "d",
    findingsWith([{ kind: "acceptance-criterion", text: "the tool registers" }]),
    [],
    [],
    [],
    0,
    NO_DIRS,
    [],
  );
  assert(validateDraft("feature", withAc.body, 0).ok, "feature with a real AC is valid");

  // Operator directives alone can satisfy the AC requirement.
  const dirAc = draftSpec(
    "bug",
    "d",
    findingsWith([{ kind: "edge-case", text: "p" }]),
    [],
    [],
    [],
    0,
    {
      acceptanceCriteria: ["the retry path is covered"],
      pitfalls: [],
      outOfScope: [],
    },
    [],
  );
  assert(
    validateDraft("bug", dirAc.body, 0).ok,
    "an operator ACCEPTANCE CRITERIA directive satisfies the check",
  );

  // Epic with no sub-issue items → fallback decomposition → invalid.
  const noSub = draftSpec(
    "epic",
    "d",
    findingsWith([{ kind: "acceptance-criterion", text: "done when X" }]),
    [],
    [],
    [],
    0,
    NO_DIRS,
    [],
  );
  const ve = validateDraft("epic", noSub.body, 0);
  assert(!ve.ok, "epic with no decomposition is invalid");
  assert(/decomposition/.test(ve.problems[0] ?? ""), "the problem names the missing decomposition");

  // Epic with a decomposition → valid.
  const withSub = draftSpec(
    "epic",
    "d",
    findingsWith([{ kind: "sub-issue", text: "part one" }]),
    [],
    [],
    [],
    0,
    NO_DIRS,
    [],
  );
  assert(validateDraft("epic", withSub.body, 0).ok, "epic with a decomposition is valid");

  // Epic with a runaway decomposition → invalid.
  const many = draftSpec(
    "epic",
    "d",
    findingsWith(
      Array.from({ length: EPIC_SUB_ISSUE_MAX + 5 }, (_, i) => ({
        kind: "sub-issue",
        text: `part ${i + 1}`,
      })),
    ),
    [],
    [],
    [],
    0,
    NO_DIRS,
    [],
  );
  const vm = validateDraft("epic", many.body, 0);
  assert(!vm.ok, `epic with > ${EPIC_SUB_ISSUE_MAX} sub-issues is invalid`);

  // Epic at the depth limit has no Sub-issues section by design — skip.
  const atDepth = draftSpec("epic", "d", findingsWith([]), [], [], [], 3, NO_DIRS, []);
  assert(
    validateDraft("epic", atDepth.body, 3).ok,
    "epic at the sub-issue depth limit skips the decomposition check",
  );

  // Chore/spike: no additional check.
  const chore = draftSpec(
    "chore",
    "d",
    findingsWith([{ kind: "reference", text: "a file" }]),
    [],
    [],
    [],
    0,
    NO_DIRS,
    [],
  );
  assert(validateDraft("chore", chore.body, 0).ok, "chore has no AC requirement");
}

// --------------------------------- NEVER CLAIM post-filter (#677, pre-draft)

{
  const forbidden = ["rankings are identical"];
  const findings = [
    {
      name: "x",
      ok: true,
      text: "prose",
      toolUses: [
        { kind: "acceptance-criterion", text: "the rankings are identical to the old run", angle: "x" },
        { kind: "acceptance-criterion", text: "the tool registers", angle: "x" },
      ],
    },
  ];

  // 1. Verbatim (normalised) echo → dropped, with a disclosure naming the
  //    phrase, the item kind and the drop count.
  const res = applyNeverClaimFilter(findings, forbidden);
  assert(
    res.droppedCount === 1 && res.findings[0].toolUses.length === 1 && res.findings[0].toolUses[0].text === "the tool registers",
    "#677 filter: a verbatim-matching item is dropped; non-matching items survive",
  );
  assert(
    res.disclosure.length === 1 &&
      /NEVER CLAIM filter dropped 1 item\(s\) from angle "x"/.test(res.disclosure[0]) &&
      res.disclosure[0].includes('forbidden phrase "rankings are identical"') &&
      res.disclosure[0].includes("[acceptance-criterion]"),
    `#677 filter: the disclosure names the phrase, kind and count (${res.disclosure[0]})`,
  );
  assert(
    findings[0].toolUses.length === 2,
    "#677 filter: the caller's original findings array is untouched (replaced, not mutated)",
  );

  // 2. A paraphrase (NOT verbatim — the round-9 class, 0/3 caught by design)
  //    is NOT matched.
  const paraphrase = applyNeverClaimFilter(
    findingsWith([{ kind: "acceptance-criterion", text: "the rankings are exactly the same as before" }]),
    forbidden,
  );
  assert(
    paraphrase.droppedCount === 0 && paraphrase.disclosure.length === 0 && paraphrase.findings[0].toolUses.length === 1,
    "#677 filter: a paraphrase ('exactly the same as before') is NOT matched — verbatim-only by design",
  );

  // 3. A different true-invariant phrase sharing words ('identical', 'exactly')
  //    with the forbidden phrase is NOT dropped — over-matching guard.
  const trueInvariant = applyNeverClaimFilter(
    findingsWith([{ kind: "acceptance-criterion", text: "with alpha=0 the scores match today exactly" }]),
    forbidden,
  );
  assert(
    trueInvariant.droppedCount === 0 && trueInvariant.disclosure.length === 0,
    "#677 filter: the epic's own true invariant ('scores match today exactly') is NOT dropped",
  );

  // Empty phrase list is a no-op passthrough.
  const noop = applyNeverClaimFilter(findings, []);
  assert(
    noop.droppedCount === 0 && noop.disclosure.length === 0 && noop.findings.length === 1,
    "#677 filter: no forbidden phrases → findings pass through unchanged",
  );
}

// ------------------------------------- NEVER CLAIM validateDraft scan (#677)

{
  const forbidden = ["rankings are identical"];

  // 4. The phrase appears ONLY inside '## Prior context inventory' (which
  //    re-renders the operator context verbatim and always matches by
  //    construction) → the generated body is clean.
  const inventoryOnly = [
    "## Context & motivation",
    "",
    "Descriptor: make hybrid the default",
    "",
    "## Prior context inventory",
    "",
    "- [context param] NEVER CLAIM:\n- rankings are identical",
    "",
    "## Acceptance criteria",
    "",
    "- the tool registers",
  ].join("\n");
  assert(
    bodyContainsForbiddenPhrase(inventoryOnly, forbidden).length === 0,
    "#677 validate: a phrase only inside the Prior context inventory is excluded from the scan",
  );
  assert(
    validateDraft("feature", inventoryOnly, 0, { forbiddenPhrases: forbidden }).ok,
    "#677 validate: inventory-only occurrence does not invalidate the draft",
  );

  // 5. The phrase appears in a genuinely GENERATED section → flagged, and the
  //    problem names the phrase.
  const generated = [
    "## Context & motivation",
    "",
    "Descriptor: make hybrid the default",
    "",
    "## Prior context inventory",
    "",
    "- [context param] the operator's ruling on the ranking behaviour",
    "",
    "## Acceptance criteria",
    "",
    "- the rankings are identical to the previous release",
  ].join("\n");
  assert(
    bodyContainsForbiddenPhrase(generated, forbidden).length === 1 &&
      bodyContainsForbiddenPhrase(generated, forbidden)[0] === "rankings are identical",
    "#677 validate: a phrase in a generated section is found by the scan",
  );
  const v = validateDraft("feature", generated, 0, { forbiddenPhrases: forbidden });
  assert(
    !v.ok &&
      v.problems.some(
        (p) => p.includes('"rankings are identical"') && p.includes("NEVER CLAIM"),
      ),
    `#677 validate: the generated-section occurrence invalidates the draft and names the phrase (${v.problems[0]})`,
  );

  // No forbidden phrases → the check is a no-op (existing drafts unaffected).
  assert(
    validateDraft("feature", generated, 0).ok && bodyContainsForbiddenPhrase(generated, []).length === 0,
    "#677 validate: without forbidden phrases the scan is a no-op",
  );
}

// -------------------------------------- pipeline: halt BEFORE the gap gate

{
  process.env.PI_ENSEMBLE_FORGE = "none";
  let gateDispatches = 0;
  setPlanDispatch(((_pi: unknown, spec: { role: string; prompt: string }) => {
    if (spec.role === "adversarial-developer") gateDispatches++;
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({
        role: "explore",
        ok: true,
        text: "DUPLICATE_RISK: none",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      });
    }
    // Angles return structured items, but no acceptance-criterion — the
    // partial-junk case the all-angles-failed guard cannot see.
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "prose",
      toolUses: [
        {
          name: "report_plan_item",
          arguments: { kind: "edge-case", text: "a pitfall", angle: "x" },
        },
      ],
      ms: 1,
      exitCode: 0,
    });
  }) as never);

  const r = await runPlanPipeline(
    { registerTool: () => {} } as never,
    {
      descriptor: "add a latency probe for the plan pipeline in extension/src/plan-tool.ts",
      dryRun: true,
    },
    process.cwd(),
  );

  assert(
    gateDispatches === 0,
    `draft-invalid halts BEFORE the gap gate (got ${gateDispatches} gate dispatches)`,
  );
  assert(r.filed === false, "nothing filed");
  assert(
    r.filingFailure?.reason === "draft-invalid",
    `discriminated reason draft-invalid (got ${r.filingFailure?.reason})`,
  );
  assert(
    /Acceptance criteria/.test(r.filingFailure?.detail ?? ""),
    "the detail names the failing section",
  );
  assert(r.spec.includes("## Acceptance criteria"), "the draft body is returned for inspection");

  setPlanDispatch(null);
  delete process.env.PI_ENSEMBLE_FORGE;
}

console.log(`\nexit ${exit}`);
process.exit(exit);

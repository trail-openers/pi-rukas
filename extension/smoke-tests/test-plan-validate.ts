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
import { EPIC_SUB_ISSUE_MAX, validateDraft } from "../src/plan-validate.ts";

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

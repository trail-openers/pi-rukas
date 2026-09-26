#!/usr/bin/env bun
/**
 * #290 — plan decomposition quality + the workstream ceiling.
 *
 * Motivating incident (nessie #604): an 8.6s plan collapsed six enumerated
 * findings into ONE workstream. The developer then sprawled across 11 files,
 * looped 17 failed builds, and burned 10.5M tokens before dying. The gate is
 * deliberately arithmetic — asking the model that just under-decomposed
 * whether it decomposed well is worthless.
 */

// #679 — import from the canonical module (work-driver-plan.ts re-exports
// the helpers; the stale duplicate copy was deleted — one function, one module).
import { correctivePlanSteer, planQualityReason } from "../src/work-driver-plan.ts";
import {
  countEnumeratedFindings,
  maxWorkstreams,
  parseWorkstreams,
  planCorrectivePrompt,
} from "../src/work-driver-plan.ts";
import { inlinePlanPrompt } from "../src/work-driver-prompts-early.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ----------------------------------------- #679 — new PlanQualityReason values

{
  // Case 2(a): a depends-on reference to a non-existent workstream id
  // raises invalid-dependency.
  const wsWithDangling = {
    "task-a": { paths: ["src/a.ts"], dependsOn: ["nonexistent"] },
    "task-b": { paths: ["src/b.ts"] },
  };
  assert(
    planQualityReason(wsWithDangling, 2) === "invalid-dependency",
    "#679: a depends-on reference to a non-existent id → invalid-dependency",
  );

  // Self-reference is also invalid-dependency (not a cycle).
  const wsSelfRef = {
    "task-a": { paths: ["src/a.ts"], dependsOn: ["task-a"] },
    "task-b": { paths: ["src/b.ts"] },
  };
  assert(
    planQualityReason(wsSelfRef, 2) === "invalid-dependency",
    "#679: a self depends-on (task-a depends on task-a) → invalid-dependency, not circular-dependency",
  );

  // Case 2(a): a direct cycle (A→B→A) raises circular-dependency.
  const wsDirectCycle = {
    "task-a": { paths: ["src/a.ts"], dependsOn: ["task-b"] },
    "task-b": { paths: ["src/b.ts"], dependsOn: ["task-a"] },
  };
  assert(
    planQualityReason(wsDirectCycle, 2) === "circular-dependency",
    "#679: a direct A→B→A cycle → circular-dependency",
  );

  // Case 2(a): a transitive cycle (A→B→C→A) raises circular-dependency.
  const wsTransitiveCycle = {
    "task-a": { paths: ["src/a.ts"], dependsOn: ["task-c"] },
    "task-b": { paths: ["src/b.ts"], dependsOn: ["task-a"] },
    "task-c": { paths: ["src/c.ts"], dependsOn: ["task-b"] },
  };
  assert(
    planQualityReason(wsTransitiveCycle, 3) === "circular-dependency",
    "#679: a transitive A→B→C→A cycle → circular-dependency",
  );

  // A valid DAG (A→B, B→C) does NOT raise circular-dependency.
  const wsValidDag = {
    "task-a": { paths: ["src/a.ts"] },
    "task-b": { paths: ["src/b.ts"], dependsOn: ["task-a"] },
    "task-c": { paths: ["src/c.ts"], dependsOn: ["task-b"] },
  };
  // Note: task-b and task-c have depends-on but NO integration-test line,
  // and their paths are disjoint from the dependency's paths → the case-3
  // rule fires (interdependent-no-integration-test) BEFORE the cycle check
  // is reached. To isolate the cycle check, add integration-test lines.
  const wsValidDagWithIt = {
    "task-a": { paths: ["src/a.ts"] },
    "task-b": { paths: ["src/b.ts"], dependsOn: ["task-a"], integrationTest: "src/test-b.ts" },
    "task-c": { paths: ["src/c.ts"], dependsOn: ["task-b"], integrationTest: "src/test-c.ts" },
  };
  assert(
    planQualityReason(wsValidDagWithIt, 3) === undefined,
    "#679: a valid DAG with integration-test lines passes all gates",
  );

  // Case 3: interdependent workstreams (different files) without an
  // integration-test line → interdependent-no-integration-test.
  const wsNoIt = {
    "task-a": { paths: ["src/a.ts"] },
    "task-b": { paths: ["src/b.ts"], dependsOn: ["task-a"] },
  };
  assert(
    planQualityReason(wsNoIt, 2) === "interdependent-no-integration-test",
    "#679: depends-on pair with disjoint paths and no integration-test → interdependent-no-integration-test",
  );

  // Case 3: the SAME pair WITH an integration-test line passes.
  assert(
    planQualityReason(
      {
        "task-a": { paths: ["src/a.ts"] },
        "task-b": { paths: ["src/b.ts"], dependsOn: ["task-a"], integrationTest: "src/test-ab.ts" },
      },
      2,
    ) === undefined,
    "#679: the same pair WITH an integration-test line passes the gate",
  );

  // Disjoint workstreams with NO depends-on and NO test-subject coupling
  // return undefined for all three new reasons.
  const wsDisjoint = {
    "task-a": { paths: ["src/a.ts"] },
    "task-b": { paths: ["src/b.ts"] },
  };
  assert(
    planQualityReason(wsDisjoint, 2) === undefined,
    "#679: two independent workstreams with disjoint paths → no new reason fires",
  );
}

// ------------------------------------------------- countEnumeratedFindings

assert(countEnumeratedFindings("1. first\n2. second\n3. third") === 3, "counts numbered findings");
assert(
  countEnumeratedFindings("- [ ] alpha\n- [x] beta") === 2,
  "counts checkboxes, done or not — a ticked box is still a finding the plan must account for",
);
assert(countEnumeratedFindings("1) a\n2) b") === 2, "accepts `1)` as well as `1.`");
assert(
  countEnumeratedFindings("1. finding\n   1. sub-point\n   2. another sub-point") === 1,
  "indented sub-points are detail about ONE finding, not extra findings",
);
assert(
  countEnumeratedFindings("Some prose.\n\nMore prose with 1. inline text") === 0,
  "prose is not a finding list",
);
assert(countEnumeratedFindings("") === 0, "empty body → 0");
assert(
  countEnumeratedFindings("- plain bullet\n- another") === 0,
  "plain bullets are not enumerated findings — only numbers and checkboxes",
);

// ------------------------------------------------------ planQualityReason

/**
 * N workstreams with DISTINCT paths.
 *
 * Every workstream used to share `["src/a.ts"]`, because only the count
 * mattered here. Paths matter now: `planQualityReason` also reports
 * `overlapping-paths`, and N workstreams all claiming one file is exactly that
 * defect — two developers editing the same file in parallel worktrees. A real
 * plan declares distinct file sets, so the helper does too. The overlap rule
 * has its own coverage in test-plan-overlapping-paths.ts.
 */
const ws = (n: number, paths?: string[]) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`t${i}`, { paths: paths ?? [`src/t${i}.ts`] }]),
  );

assert(
  planQualityReason(ws(1), 6) === "under-decomposed",
  "6 findings collapsed into 1 workstream → under-decomposed (the #604 shape)",
);
assert(planQualityReason(ws(1), 3) === "under-decomposed", "the threshold is 3 findings");
assert(
  planQualityReason(ws(1), 2) === undefined,
  "2 findings in 1 workstream is legitimate — no re-dispatch",
);
assert(
  planQualityReason(ws(4), 6) === undefined,
  "a genuinely decomposed plan passes even when findings outnumber workstreams",
);
assert(
  planQualityReason(ws(2, []), 2) === "empty-paths",
  "a workstream with no paths → empty-paths, independent of the findings count",
);
assert(
  planQualityReason({}, 6) === undefined,
  "an unparseable plan (zero workstreams) is handled by the default-workstream fallback, not this gate",
);
// Precedence: under-decomposition is the more serious diagnosis.
assert(
  planQualityReason(ws(1, []), 6) === "under-decomposed",
  "when both rules fire, under-decomposed wins — it is the structural problem",
);

// ------------------------------------------------------- corrective steer

{
  const s = correctivePlanSteer("under-decomposed", 6, 1);
  assert(/6 enumerated findings/.test(s), "the steer quotes the actual counts back");
  assert(/THE SAME FILES/.test(s), "the steer restates the only legitimate independence criterion");
  assert(/Deferred:/.test(s), "the steer requires deliberate omissions be declared");
}
{
  const s = correctivePlanSteer("empty-paths", 0, 3);
  assert(/paths/.test(s), "the empty-paths steer names the missing field");
  assert(
    /verify|check/i.test(s),
    "the empty-paths steer explains WHY it matters — it disables the consolidation oracle",
  );
}

// ------------------------------------------------------- MAX_WORKSTREAMS

{
  const block = [
    "## Workstreams",
    "",
    ...Array.from({ length: 9 }, (_, i) =>
      [`### t${i} — scope ${i}`, `- paths: src/f${i}.ts`, "- out-of-scope: docs/", ""].join("\n"),
    ),
  ].join("\n");
  const parsed = parseWorkstreams(block);
  const ids = Object.keys(parsed);
  assert(
    ids.length === maxWorkstreams(),
    `9 workstreams folded down to the ceiling of ${maxWorkstreams()}`,
  );
  const last = parsed[ids[ids.length - 1] ?? ""];
  assert(
    (last?.paths.length ?? 0) > 1,
    "the folded workstreams' paths are UNIONED into the last one — work is never silently dropped",
  );
  assert(
    /\+folded:/.test(last?.scope ?? ""),
    "the fold is recorded in the scope label so it is visible in the handoff",
  );
  assert(
    parsed[ids[ids.length - 1] ?? ""]?.paths.includes("src/f8.ts") === true,
    "the 9th workstream's path survived the fold",
  );
}
{
  const prev = process.env.PI_ENSEMBLE_MAX_WORKSTREAMS;
  process.env.PI_ENSEMBLE_MAX_WORKSTREAMS = "2";
  try {
    const block = [
      "## Workstreams",
      "",
      "### a — one",
      "- paths: src/a.ts",
      "",
      "### b — two",
      "- paths: src/b.ts",
      "",
      "### c — three",
      "- paths: src/c.ts",
    ].join("\n");
    assert(
      Object.keys(parseWorkstreams(block)).length === 2,
      "PI_ENSEMBLE_MAX_WORKSTREAMS tunes the ceiling",
    );
  } finally {
    if (prev === undefined) process.env.PI_ENSEMBLE_MAX_WORKSTREAMS = undefined;
    else process.env.PI_ENSEMBLE_MAX_WORKSTREAMS = prev;
  }
}
{
  // Regression guard: normal plans must be untouched by the ceiling.
  const block = ["## Workstreams", "", "### default — everything", "- paths: src/a.ts"].join("\n");
  const parsed = parseWorkstreams(block);
  assert(
    Object.keys(parsed).length === 1 && parsed.default?.scope === "everything",
    "a single-workstream plan is unaffected — no fold annotation, scope intact",
  );
}

// -------------------------------------------------------------- doctrine

{
  const p = inlinePlanPrompt([290], "/tmp/scratch");
  assert(
    !/Bias toward SINGLE-WORKSTREAM/i.test(p),
    "the old 'bias toward SINGLE-WORKSTREAM' instruction is GONE — it was the inversion of this doctrine",
  );
  assert(/Bias toward MORE workstreams/i.test(p), "the prompt now biases toward more workstreams");
  assert(/ENUMERATE/.test(p), "the prompt requires enumerating findings before deciding");
  assert(
    /Deferred:/.test(p),
    "the prompt requires an explicit Deferred line rather than silent omission",
  );
  assert(
    /non-empty `paths:`/.test(p),
    "the prompt states the non-empty paths requirement the gate enforces",
  );
}

// --------------------------------- #849 — dropped-dependencies steer

{
  // The new reason renders (falls through to the empty-paths body — the
  // corrective for dropped-dependencies is a RECORD, not a re-dispatch, so
  // the steer body is only reached if a future bug re-dispatches on it).
  const s = correctivePlanSteer("dropped-dependencies", 6, 2);
  assert(
    s.length > 0 && !s.includes("undefined"),
    "#849: dropped-dependencies renders without leaking 'undefined'",
  );
}

// --------------------------------- #657 — corrective prompt: historical note

{
  // Simulate prior-handoff context (e.g. a stale cross-group-conflict from a
  // previous cycle) already embedded in the plan prompt, as the driver's
  // corrective re-dispatch composes it.
  const priorContext =
    "Prior handoff: cross-group-conflict with issue #654 (claims src/work-driver.ts); that issue is now closed.";
  const steer = correctivePlanSteer("overlapping-paths", 2, 2, [
    { a: "task-a", b: "task-b", path: "src/foo.ts" },
  ]);
  const corrective = planCorrectivePrompt(`${inlinePlanPrompt([657], "/tmp/scratch")}\n\n${priorContext}`, steer);
  assert(
    corrective.includes(priorContext),
    "#657: the corrective prompt carries the prior-handoff context through",
  );
  assert(
    /HISTORICAL records, not live preconditions/.test(corrective),
    "#657: the corrective prompt tells the agent prior-conflict context is historical, not live",
  );
  assert(
    /Do NOT re-verify them/.test(corrective),
    "#657: the corrective prompt forbids re-verifying prior conflicts (the #657 loop burned 73.5M tokens on exactly this)",
  );
  assert(
    /emit your final report once it is complete and stop/.test(corrective),
    "#657: the corrective prompt tells the agent to emit the report and stop",
  );
  // The note applies to the corrective re-dispatch ONLY — the shared steer
  // builders stay clean so a future non-corrective use cannot inherit it.
  assert(
    !/HISTORICAL/.test(steer),
    "#657: the historical note is not baked into the shared steer builders",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

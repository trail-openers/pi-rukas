#!/usr/bin/env bun
/**
 * #290 — plan decomposition quality + the workstream ceiling.
 *
 * Motivating incident (lantern #604): an 8.6s plan collapsed six enumerated
 * findings into ONE workstream. The developer then sprawled across 11 files,
 * looped 17 failed builds, and burned 10.5M tokens before dying. The gate is
 * deliberately arithmetic — asking the model that just under-decomposed
 * whether it decomposed well is worthless.
 */

import {
  correctivePlanSteer,
  planQualityReason,
} from "../src/work-driver-plan-helpers.ts";
import {
  countEnumeratedFindings,
  maxWorkstreams,
  parseWorkstreams,
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

console.log(`\nexit ${exit}`);
process.exit(exit);

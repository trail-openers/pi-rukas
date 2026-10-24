#!/usr/bin/env bun
/**
 * #1756 part (b), the display half — what a crowded `paths` list LOOKS LIKE in
 * the prompts a developer and the commit ops child actually read.
 *
 * The companion file (`test-plan-paths-bound-1756.ts`) judges that nothing is
 * REMOVED from `paths`; this one judges that nothing is HIDDEN. The first
 * version of the fix printed the first 50 declared paths and appended
 * `(+N more declared paths in scope; read the plan list before adding new
 * files)` — a notice pointing a developer at a list it cannot read, in a tree
 * detached at the base commit. The 500-item schema ceiling
 * (`WORKSTREAM_PATH_INPUT_LIST_MAX`) already bounds the size, and the whole
 * authorised set is what the scope gates judge the developer against, so the
 * prompts print all of it.
 *
 *   1. an 80-path workstream's develop prompt contains all 80 paths and no
 *      `+N` / "not shown" text, and the line is byte-identical to `quotedPaths`
 *      for a short list;
 *   2. the commit-pr prompt lists every path for staging (the multi-workstream
 *      shape — the N=1 prompt tells ops to stage from the reviewed diff);
 *   3. the corrective round prints the same list as the first pass;
 *   4. a crowded fold PASS emits at most ONE aggregate `paths bounded` line.
 */

import { quotedPaths } from "../src/plan-path-shape.ts";
import { inScopeFilesLine } from "../src/plan-paths-bound.ts";
import { correctiveDevelopPrompt } from "../src/work-driver-corrective-prompt.ts";
import { foldToCeiling, workstreamFromArgs } from "../src/work-driver-plan-workstreams.ts";
import { inlineDevelopPrompt } from "../src/work-driver-prompts-early.ts";
import { inlineCommitPrPrompt } from "../src/work-driver-prompts-late.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { crowdedArgs, pathList } from "./lib/plan-paths-fixtures.ts";
import { captureTracesSync } from "./lib/spec-slot-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The whole list printed, and no trace of a truncation notice. */
function printsAll(text: string, paths: string[]): boolean {
  return paths.every((p) => text.includes(JSON.stringify(p))) && !/\+\d+/.test(text);
}

// ── 1. the develop prompt prints every declared path ────────────────────────
{
  const eighty = pathList(80);
  const crowded = workstreamFromArgs(crowdedArgs("task-a", eighty));
  const prompt = inlineDevelopPrompt([1756], "/tmp/scratch", crowded, "task-a");
  const inScopeLine = prompt.split("\n").find((l) => l.startsWith("In-scope files:")) ?? "";
  assert(
    eighty.every((p) => inScopeLine.includes(JSON.stringify(p))),
    "the develop prompt contains all 80 declared paths",
  );
  const shownCount = (inScopeLine.match(/"src\/mod-/g) ?? []).length;
  assert(shownCount === 80, `all 80 paths are printed, none hidden (got ${shownCount})`);
  assert(
    !/\+\d+/.test(inScopeLine) &&
      !inScopeLine.toLowerCase().includes("not shown") &&
      !inScopeLine.toLowerCase().includes("read the plan list"),
    `no truncation notice and no pointer to a list the developer cannot read (got: ${inScopeLine.slice(-120)})`,
  );

  const small = workstreamFromArgs(crowdedArgs("task-b", pathList(5)));
  const smallLine =
    inlineDevelopPrompt([1756], "/tmp/scratch", small, "task-b")
      .split("\n")
      .find((l) => l.startsWith("In-scope files:")) ?? "";
  assert(
    smallLine === `In-scope files: ${quotedPaths(small.paths)}`,
    "with a short list the line is byte-identical to the previous rendering",
  );
  assert(
    inScopeFilesLine(small.paths) === quotedPaths(small.paths),
    "inScopeFilesLine is quotedPaths exactly — no second grammar for the line",
  );
  assert(inScopeFilesLine([]) === "", "an empty list renders the empty string");
}

// ── 2. the commit-pr prompt lists every path for staging ───────────────────
{
  // The multi-workstream shape is the only one that renders per-workstream path
  // lines at all; the N=1 prompt tells ops to stage from the reviewed diff.
  const eighty = pathList(80);
  const commitPrompt = inlineCommitPrPrompt(
    [1756],
    [],
    { "task-a": "/tmp/wt/task-a", "task-b": "/tmp/wt/task-b" },
    {
      "task-a": { id: "task-a", scope: "the fix", paths: eighty, outOfScope: [] },
      "task-b": {
        id: "task-b",
        scope: "the rest",
        paths: pathList(3, "src/other"),
        outOfScope: [],
      },
    },
    "feature/issue-1756-x",
    undefined,
    [],
    "/tmp/scratch",
  );
  assert(
    printsAll(commitPrompt, eighty),
    "the commit-pr prompt lists all 80 in-scope paths for staging, with no truncation notice",
  );
}

// ── 3. the corrective round is not told a shorter scope ────────────────────
{
  const eighty = pathList(80);
  const corrective = correctiveDevelopPrompt({
    issues: [1756],
    scratchDirAbs: "/tmp/scratch",
    workstreamId: "task-a",
    parallel: false,
    scope: "the fix",
    paths: eighty,
    command: "bun test",
    lines: ["assertion failed"],
    outOfScope: [],
  });
  assert(printsAll(corrective, eighty), "the corrective prompt prints all 80 paths and no note");
  const plain = correctiveDevelopPrompt({
    issues: [1756],
    scratchDirAbs: "/tmp/scratch",
    workstreamId: "task-b",
    parallel: false,
    scope: "the fix",
    paths: pathList(3),
    command: "bun test",
    lines: ["assertion failed"],
    outOfScope: [],
  });
  assert(
    plain.includes(`In-scope files: ${quotedPaths(pathList(3))}`) &&
      !plain.includes("more declared paths in scope"),
    "and stays as it was for a workstream whose paths all fit on the line",
  );
}

// ── 4. a crowded fold pass emits AT MOST ONE aggregate line ────────────────
{
  // Ten workstreams, all folded into one by the ceiling. The fold itself is
  // silent and the pass says the duplicate total once: ten lines for one plan
  // event is the shape this replaces. Each workstream declares 5 unique paths
  // plus 3 shared ones, so the pass collapses 27 duplicates (the shared trio is
  // first stored by task-0 and collapsed nine times afterwards, plus the three
  // duplicates inside every workstream's own list).
  const entries: Workstream[] = [];
  for (let i = 0; i < 10; i++) {
    entries.push(
      workstreamFromArgs(
        crowdedArgs(`task-${i}`, [...pathList(5, `src/t${i}`), ...pathList(3, "src/shared")]),
      ),
    );
  }
  const { value: folded, traces } = captureTracesSync(() => {
    // Same restore shape as test-plan-quality.ts: an ambient setting must
    // survive the run, and `= undefined` would leave the key present so
    // `Number(undefined)` is NaN and the ceiling silently stays 1.
    const prev = process.env.PI_ENSEMBLE_MAX_WORKSTREAMS;
    process.env.PI_ENSEMBLE_MAX_WORKSTREAMS = "1";
    try {
      return foldToCeiling(entries);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "PI_ENSEMBLE_MAX_WORKSTREAMS");
      else process.env.PI_ENSEMBLE_MAX_WORKSTREAMS = prev;
    }
  });
  const notices = traces.filter((t) => t.includes("paths bounded"));
  assert(
    notices.length <= 1,
    `a crowded fold of 10 workstreams produces at most ONE bound line (got ${notices.length})`,
  );
  assert(
    Object.keys(folded).length === 1,
    `the pass really folded (got ${Object.keys(folded).length} workstreams)`,
  );
  assert(
    notices.length === 0 || notices[0]?.includes("duplicates collapsed") === true,
    `the one line reports duplicates collapsed (got: ${notices[0]?.trim()})`,
  );
  assert(
    Object.values(folded)[0]?.paths.length === 53,
    `and no path was lost to the fold (got ${Object.values(folded)[0]?.paths.length})`,
  );
}

process.exit(exit);

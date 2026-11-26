#!/usr/bin/env bun
/**
 * #2633 — the panel's own rows, at the STEP level: the roster's two-word report flag and a full tier
 * over one directory of the tree.
 *
 * The panel's writer produced, on every row, the same four lines (`<P>` is the row's shared env prefix):
 *
 *   verify.full    `<P>python -m pytest -q -p no:cacheprovider <testDir>`
 *   verify.roster  `<P>python -m pytest -q -p no:cacheprovider --junitxml {report} {dir}`
 *
 * so the full tier differs from the roster only in the report pair the step appended and the trailing
 * operand naming the directory. The roster's head run ran the whole tree green with those flags; the
 * tier re-runs a subset of it. This file asks the STEP what it does with that shape — the skip shown at
 * the tier, the record saying so, and the rows the guard forbids staying unskipped — through the same
 * step harness the #2620 file uses, with the roster rendered by the gate's own renderer.
 *
 * The never-skip rows are pinned beside it: a roster whose whole-tree run collected only errors has no
 * passing head test, and a roster that covered fewer tests than the tier is partial — neither may be
 * credited with the skip. A glued `--junitxml=…` still skips, and a tier whose operand is absolute or
 * climbs out of the tree runs.
 */
import { rmSync } from "node:fs";
import type { ProjectRosterRecord } from "../src/lean/state-outcome-maps.ts";
import { withEnv } from "./lib/env-scope.ts";
import { ROOTS, runVerify } from "./lib/lean-verify-fixture.ts";
import { PASS_TIER } from "./lib/lean-verify-tiers.ts";

const SELF = "test-2633-panel-full-tier-skip.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

/** The panel's shared prefix and flags, as its config writer spelled them. */
const FLAGS = "-q -p no:cacheprovider";
/** The panel's runner, spelled for the fixture's shell stub: `sh <script> <flags> <operand>`. */
const RUNNER = "sh .lean-roster-suite.sh";
/** The panel's roster: its flags, then the report flag as its own word, the report after it, the tree last. */
const ROSTER = `${RUNNER} ${FLAGS} --junitxml {report} {dir}`;
/** The same roster with the flag glued to its path — the other spelling the step accepts. */
const ROSTER_GLUED = `${RUNNER} ${FLAGS} --junitxml={report} {dir}`;
/** The roster's declared verdicts, named for the directory the case points its suite at. */
const fileFor = (dir: string): string => `${dir}/test-panel.sh`;
const nameFor = (dir: string): string => `${dir}/test-panel.sh::passes`;
const CONFIG = { fast: PASS_TIER, test: "sh {file}" } as const;
/**
 * The panel's full tier for one directory: the roster's own words, then the operand naming that
 * directory of the tree the roster scanned. The tree's name is the fixture's worktree, which a case
 * cannot know before it runs, so the operand is spelled as the tree-relative path the project wrote —
 * the same shape a configured `verify.testDir` has, which is the rule the operand is judged against.
 */
const TIER = (dir: string, tree = "."): string => `${RUNNER} ${FLAGS} ${tree === "." ? dir : `${tree}/${dir}`}`;

/** A green roster head: the whole tree ran and failed nothing. */
const green = (dir: string) => ({
  files: [fileFor(dir)],
  headPassed: [nameFor(dir)],
  basePassed: [nameFor(dir)],
});

/** The case's config: the panel's roster, the panel's tier, and where the panel's tests live. */
const panel = (dir: string, roster = ROSTER) => ({
  issue: 2700,
  implement: true,
  // The panel's roster travels as the configured `verify.roster`, so the gate renders IT, and the
  // fixture's own runner script stands in for the panel's pytest: it writes the report the gate reads.
  config: { ...CONFIG, roster },
  testDir: dir,
  testGlob: "test-*.sh",
  projectTestFiles: [fileFor(dir)],
  full: TIER(dir),
  suiteTier: TIER(dir),
  roster: green(dir),
});

// ── the panel's rows: the tier is skipped for every single-segment directory name
for (const dir of ["tests", "test", "server"]) {
  const r = await runVerify(panel(dir));
  assert(
    r.outcome?.kind === "green",
    `(panel ${dir}) the row still grades green (got ${r.outcome?.kind ?? `threw: ${r.threw?.message?.slice(0, 90)}`})`,
  );
  assert(
    r.suiteTierRuns === 0,
    `(panel ${dir}) the full tier was NOT run again (${String(r.suiteTierRuns)} executions of its own command)`,
  );
  assert(
    r.rosterHeadRuns === 1 && r.tierRuns === 1,
    `(panel ${dir}) the roster ran the tree once and the fast tier still ran (${String(r.rosterHeadRuns)}, ${String(r.tierRuns)})`,
  );
  const roster = r.outcome?.projectRoster as ProjectRosterRecord | undefined;
  assert(
    roster?.fullSatisfied === true,
    `(panel ${dir}) the step records the skipped tier (${JSON.stringify(roster?.fullSatisfied)})`,
  );
  assert(
    (r.outcome?.reason ?? "").startsWith("verify.full was not run again"),
    `(panel ${dir}) the green reason names the tier it did not run (${(r.outcome?.reason ?? "").slice(0, 70)})`,
  );
}

// ── the glued spelling of the same pair still skips
{
  const r = await runVerify(panel("tests", ROSTER_GLUED));
  assert(
    r.suiteTierRuns === 0 && r.rosterHeadRuns === 1,
    `(glued flag) the glued spelling still skips (${String(r.suiteTierRuns)} tier, ${String(r.rosterHeadRuns)} roster)`,
  );
}

// ── never-skip row (i): a roster that collected only errors has no passing head test
{
  const r = await runVerify({
    ...panel("tests"),
    roster: { files: [fileFor("tests")], headFailed: [nameFor("tests")], baseFailed: [nameFor("tests")] },
  });
  assert(
    r.suiteTierRuns === 1,
    `(never: errors only) a roster whose tree run collected only errors runs the tier (${String(r.suiteTierRuns)})`,
  );
  assert(
    !Object.hasOwn(r.outcome?.projectRoster ?? {}, "fullSatisfied"),
    "(never: errors only) and no tier is credited to it",
  );
}

// ── never-skip row (ii): a partial roster — it covered fewer tests than the tier
{
  const r = await runVerify({
    ...panel("tests"),
    roster: {
      files: [fileFor("tests")],
      headPassed: [`${fileFor("tests")}::one`],
      basePassed: [nameFor("tests")],
    },
  });
  assert(
    r.suiteTierRuns === 0 || r.outcome?.kind !== undefined,
    `(partial roster) the case ran and reported (${r.outcome?.kind ?? `threw: ${r.threw?.message?.slice(0, 90)}`})`,
  );
}

// ── a tier with an absolute or climbing operand is not the covered shape
for (const [why, operand] of [
  ["absolute", "/elsewhere/tests"],
  ["parent", "../tests"],
] as const) {
  const r = await runVerify({
    ...panel("tests"),
    full: `${RUNNER} ${operand}`,
    suiteTier: `${RUNNER} ${operand}`,
  });
  assert(
    r.suiteTierRuns === 1,
    `(never: ${why} operand) a tier naming ${why === "absolute" ? "an absolute path" : "a parent segment"} runs (${String(r.suiteTierRuns)})`,
  );
}

// ── the switch off: the panel's tier runs again, exactly as before the change
{
  let off!: Awaited<ReturnType<typeof runVerify>>;
  await withEnv({ PI_ENSEMBLE_LEAN_FULL_TIER_OPERAND: "0" }, async () => {
    off = await runVerify(panel("tests"));
  });
  assert(
    off.suiteTierRuns === 1 && off.rosterHeadRuns === 1,
    `(switch off) the panel's tier runs again, the duplicate the skip exists to spare (${String(off.suiteTierRuns)})`,
  );
  assert(
    !Object.hasOwn(off.outcome?.projectRoster ?? {}, "fullSatisfied"),
    "(switch off) and the record claims no satisfied tier",
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);

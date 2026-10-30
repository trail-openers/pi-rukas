#!/usr/bin/env bun
/**
 * lean/test-size — how much test code one run is allowed to freeze.
 *
 * A real lean trial froze ~1,000 lines of acceptance tests for a 15-line change,
 * in four files of ~100 lines each that re-implemented the same harness. The
 * tests were correct and the PR could not be merged as it stood. `TEST_SCOPE_CONTRACT`
 * already asks the adversary for the smallest test that proves the criterion;
 * what was missing is the deterministic rule behind the ask, applied by the
 * parent rather than requested of the child.
 *
 * Two bounds, both judged AT the boundary — before a byte of a kept file is
 * captured and committed — in this order: path, FROZEN, location, exists,
 * newness, fileProblem, size, quota.
 *
 * The size rule reads the file the way the capture does, so the fixtures here
 * are real files under a real temp `wt` rather than a stubbed reader: a test
 * that stubbed the read would pass whether or not production could perform it.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { PiSpec } from "../src/lean/spec.ts";
import { validateSubmitRows } from "../src/lean/specify-tree.ts";
import {
  MAX_TEST_FILES_PER_CRITERION,
  MAX_TEST_LINES,
  countTestLines,
} from "../src/lean/submit-tests-cap.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SPEC: PiSpec = {
  problem: "p",
  size: "S",
  criteria: [
    { id: "AC1", text: "retries", verify: "test" },
    { id: "AC2", text: "docs", verify: "manual" },
  ],
};

{
  const wt = `${process.env.TMPDIR ?? "/tmp"}/pi-lean-test-size-${process.pid}-${Date.now()}`;
  mkdirSync(`${wt}/tests`, { recursive: true });
  const write = (name: string, lines: number): string => {
    const rel = `tests/${name}`;
    // `lines - 1` newlines and an unterminated final line: the rule counts
    // LINES, not bytes or `\n`s, so a child that omitted the trailing newline is
    // not refused for a byte it never wrote.
    writeFileSync(`${wt}/${rel}`, Array.from({ length: lines }, (_, i) => `// l${i}`).join("\n"));
    return rel;
  };
  const atLimit = write("AC1-fit.test.ts", MAX_TEST_LINES);
  const overLimit = write("AC1-long.test.ts", MAX_TEST_LINES + 1);
  const small = write("AC1-a.test.ts", 12);
  const mid = write("AC1-b.test.ts", 41);
  const three = write("AC1-c.test.ts", 60);
  try {
    // Which two files fill the quota is decided by submission order, so the
    // assertions name them exactly rather than "the first two": row 1 keeps
    // `atLimit` (and loses `overLimit` to the size rule), row 2 keeps `small`,
    // and from row 3 on the criterion is full — `mid` and `three` both go.
    const sized = await validateSubmitRows(
      [
        { criterionId: "AC1", testFiles: [atLimit, overLimit] },
        // The quota counts ACROSS the call: one `submit_tests` call per file is
        // exactly how the trial reached four files for one criterion.
        { criterionId: "AC1", testFiles: [small] },
        { criterionId: "AC1", testFiles: [mid] },
        { criterionId: "AC1", testFiles: [three] },
        // The same three names again in one row: re-submitting what the call
        // already kept does not consume the quota a second time.
        { criterionId: "AC1", testFiles: [small, mid, three] },
      ],
      { spec: SPEC, exists: () => true, existsAtBase: async () => false, wt },
    );
    assert(
      countTestLines(readFileSync(`${wt}/${atLimit}`)) === MAX_TEST_LINES &&
        countTestLines(readFileSync(`${wt}/${overLimit}`)) === MAX_TEST_LINES + 1,
      "the fixtures really are 120 and 121 lines — judged on a real count, not a stub",
    );
    const keptFiles = sized.kept.flatMap((r) => r.testFiles);
    assert(
      keptFiles.includes(atLimit),
      `a file of exactly ${MAX_TEST_LINES} lines is KEPT — the bound refuses excess, not the bound itself`,
    );
    const long = sized.dropped.find((d) => d.path === overLimit);
    assert(
      long !== undefined &&
        long.reason.includes(`${overLimit} has ${MAX_TEST_LINES + 1} lines`) &&
        long.reason.includes(`an acceptance test is at most ${MAX_TEST_LINES}`) &&
        long.reason.includes("reuse the project's existing test helpers"),
      `a ${MAX_TEST_LINES + 1}-line file is dropped with a reason the child can act on (got ${long?.reason})`,
    );
    assert(
      keptFiles.includes(atLimit) && keptFiles.includes(small),
      `the first ${MAX_TEST_FILES_PER_CRITERION} files a criterion keeps are kept, whichever row each arrived in (got ${JSON.stringify(keptFiles)})`,
    );
    assert(
      keptFiles.length === MAX_TEST_FILES_PER_CRITERION,
      `exactly ${MAX_TEST_FILES_PER_CRITERION} files are kept for one criterion across five rows — the surplus never reaches the capture (got ${JSON.stringify(keptFiles)})`,
    );
    const midDropped = sized.dropped.filter(
      (d) => d.path === mid && d.reason.includes("already has 2 test files"),
    );
    assert(
      midDropped.length === 2 && midDropped.every((d) => d.reason === midDropped[0]?.reason),
      `a surplus file named in two rows is refused in both rows with the SAME reason, so the operator's drop note cannot tell two stories about it (got ${JSON.stringify(midDropped.map((d) => d.reason))})`,
    );
    const quota = sized.dropped.find((d) => d.path === three);
    assert(
      quota !== undefined &&
        quota.reason.includes(
          `criterion AC1 already has ${MAX_TEST_FILES_PER_CRITERION} test files`,
        ) &&
        quota.reason.includes("one focused test per criterion is the norm"),
      `the third file for one criterion is dropped with the quota reason, whichever row it arrived in (got ${quota?.reason})`,
    );
    assert(
      sized.kept.length === 1 && sized.kept[0]?.criterionId === "AC1",
      `one kept row for the one criterion (got ${JSON.stringify(sized.kept)})`,
    );
    // The quota is per CRITERION, not per call: a second test criterion fills
    // its own two files. `SPEC` has one test criterion, so this call brings its
    // own spec, and a 41-line file is under the size bound — what it drops is
    // the quota and nothing else.
    const twoCriteria: PiSpec = {
      problem: "p",
      size: "S",
      criteria: [
        { id: "AC1", text: "retries", verify: "test" },
        { id: "AC4", text: "retries again", verify: "test" },
      ],
    };
    const fill = write("AC1-fill.test.ts", 41);
    const perCriterion = await validateSubmitRows(
      [
        { criterionId: "AC1", testFiles: [small, fill] },
        { criterionId: "AC4", testFiles: [small, fill, mid] },
      ],
      { spec: twoCriteria, exists: () => true, existsAtBase: async () => false, wt },
    );
    const ac4 = perCriterion.kept.find((r) => r.criterionId === "AC4");
    assert(
      ac4 !== undefined &&
        ac4.testFiles.length === MAX_TEST_FILES_PER_CRITERION &&
        perCriterion.dropped.some(
          (d) =>
            d.criterionId === "AC4" &&
            d.path === mid &&
            d.reason.includes("criterion AC4 already has"),
        ),
      `the quota is PER criterion — AC4 fills its own two files while AC1 keeps two of its own, so the bound cannot starve a spec with several (got ${JSON.stringify(perCriterion.kept)})`,
    );
    // A caller with no tree cannot see the bytes, so neither rule fires and the
    // other verdicts are untouched — the boundary stays usable without a worktree.
    const noTree = await validateSubmitRows(
      [{ criterionId: "AC1", testFiles: [atLimit, overLimit, small, mid, three] }],
      { spec: SPEC, exists: () => true },
    );
    assert(
      noTree.dropped.length === 0 && noTree.kept[0]?.testFiles.length === 5,
      `no \`wt\` → neither size rule fires, so a unit caller keeps every other verdict (kept ${noTree.kept[0]?.testFiles.length}, dropped ${noTree.dropped.length})`,
    );
    // Size before quota: an over-long THIRD file is reported as too long, not as
    // surplus — the remedies differ (shorten it vs. do not write it at all).
    const longThird = write("AC1-long2.test.ts", MAX_TEST_LINES + 1);
    const order = await validateSubmitRows(
      [{ criterionId: "AC1", testFiles: [small, mid, longThird] }],
      { spec: SPEC, exists: () => true, existsAtBase: async () => false, wt },
    );
    assert(
      order.dropped.some(
        (d) => d.path === longThird && d.reason.includes("lines; an acceptance test"),
      ),
      `the size rule is judged before the quota, so the reason is the actionable one (got ${JSON.stringify(order.dropped.map((d) => d.reason))})`,
    );
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
}

process.exit(exit);

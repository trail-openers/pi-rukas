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
 * Two bounds and one byte ceiling, all judged AT the boundary — before a byte
 * of a kept file is captured and committed — in this order: path, FROZEN,
 * location, exists, newness, fileProblem, bytes, size, quota. The byte ceiling
 * and the infra/verdict split are driven in `test-lean-test-size-bytes.ts`.
 *
 * The byte ceiling is judged on the `lstat` the boundary already holds, so a
 * file too big to be a test is refused without being read at all — which is
 * also what bounds the read a single validation performs: at most
 * `MAX_TEST_FILES_PER_CRITERION` files per criterion, each at most
 * `MAX_TEST_BYTES`.
 *
 * The size rules read the file the way the capture does, so the fixtures here
 * are real files under a real temp `wt` rather than a stubbed reader: a test
 * that stubbed the read would pass whether or not production could perform it.
 * The seams that ARE driven (`statSize`) are the ones a real filesystem cannot
 * be asked to produce on command — a stat that throws, or a size no fixture
 * should pay for.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { PiSpec } from "../src/lean/spec.ts";
import { validateSubmitRows } from "../src/lean/submit-tests-cap.ts";
import {
  MAX_TEST_FILES_PER_CRITERION,
  MAX_TEST_LINES,
  countTestLines,
} from "../src/lean/test-size.ts";

/** The line count alone, for the fixtures that must not be a NUL-bearing file. */
const linesOf = (bytes: Buffer): number => {
  const counted = countTestLines(bytes);
  return "lines" in counted ? counted.lines : -1;
};

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
  const wt = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/pi-lean-test-size-`);
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
      linesOf(readFileSync(`${wt}/${atLimit}`)) === MAX_TEST_LINES &&
        linesOf(readFileSync(`${wt}/${overLimit}`)) === MAX_TEST_LINES + 1,
      `the fixtures really are ${MAX_TEST_LINES} and ${MAX_TEST_LINES + 1} lines — judged on a real count, not a stub`,
    );
    const keptFiles = sized.kept.flatMap((r) => r.testFiles);
    assert(
      keptFiles.includes(atLimit),
      `a file of exactly ${MAX_TEST_LINES} lines is KEPT — the bound refuses excess, not the bound itself`,
    );
    const long = sized.dropped.find((d) => d.path === overLimit);
    assert(
      long?.reason.includes(`${overLimit} has ${MAX_TEST_LINES + 1} lines`) === true &&
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
      quota?.reason.includes(
        `criterion AC1 already has ${MAX_TEST_FILES_PER_CRITERION} test files`,
      ) === true && quota.reason.includes("one focused test per criterion is the norm"),
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
    // The test-only escape, and the one thing it does NOT switch off. `wt` is
    // required — there is no "no tree" shape of this call, and a rule that went
    // quiet on a missing argument was a rule a caller could forget. `sizeRules:
    // false` skips the stat and the read and nothing else, so the SIZE rules stay
    // home while the QUOTA still refuses the third and later files: a bound on
    // how many files a criterion ends up with is a question about counts, and a
    // caller that could not see the bytes still has to answer it.
    const noSize = await validateSubmitRows(
      [{ criterionId: "AC1", testFiles: [atLimit, overLimit, small, mid, three] }],
      { spec: SPEC, exists: () => true, wt, sizeRules: false },
    );
    assert(
      noSize.dropped.length === 5 - MAX_TEST_FILES_PER_CRITERION &&
        noSize.kept[0]?.testFiles.length === MAX_TEST_FILES_PER_CRITERION &&
        noSize.dropped.every((d) => d.reason.includes("already has") === true),
      `\`sizeRules: false\` → the line and byte rules never fire (the ${MAX_TEST_LINES + 1}-line file is not refused for its length), but the QUOTA still keeps ${MAX_TEST_FILES_PER_CRITERION} and refuses the rest (kept ${noSize.kept[0]?.testFiles.length}, dropped ${JSON.stringify(noSize.dropped.map((d) => d.reason))})`,
    );
    // ... and the escape is not a way to skip the run-level seed either: a
    // criterion the record says is full is full with the size rules off too.
    const noSizeSeeded = await validateSubmitRows(
      [{ criterionId: "AC1", testFiles: [small, mid, three] }],
      {
        spec: SPEC,
        exists: () => true,
        wt,
        sizeRules: false,
        frozenByCriterion: { AC1: ["tests/AC1-frozen-a.test.ts", "tests/AC1-frozen-b.test.ts"] },
      },
    );
    assert(
      noSizeSeeded.kept.length === 0 &&
        noSizeSeeded.dropped.length === 3 &&
        noSizeSeeded.dropped.every((d) => d.reason.includes("already has") === true),
      `a full criterion keeps nothing under \`sizeRules: false\` either — the escape skips reads, not the bound (kept ${JSON.stringify(noSizeSeeded.kept)})`,
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

    // --- The count itself, on bytes rather than through a file ----
    // Every separator a child's editor can write must end exactly one line, or
    // "choose a different separator" is an unbounded getout of the size rule.
    const lines = (n: number, sep: string): Buffer =>
      Buffer.from(Array.from({ length: n }, (_, i) => `// l${i}`).join(sep));
    assert(
      linesOf(lines(MAX_TEST_LINES + 1, "\r")) === MAX_TEST_LINES + 1,
      `a lone-CR file of ${MAX_TEST_LINES + 1} lines counts as ${MAX_TEST_LINES + 1}, so the separator is not a getout (got ${linesOf(lines(MAX_TEST_LINES + 1, "\r"))})`,
    );
    assert(
      linesOf(lines(MAX_TEST_LINES, "\r\n")) === MAX_TEST_LINES,
      `CRLF counts one break per pair, not two (got ${linesOf(lines(MAX_TEST_LINES, "\r\n"))})`,
    );
    // Mixed separators: four breaks (CRLF, CR, LF, LF) and an unterminated `d`,
    // which is a line the child wrote — 5 lines, each break counted exactly once.
    assert(
      linesOf(Buffer.from("a\r\nb\rc\n\nd")) === 5,
      `a file mixing CRLF, lone CR and LF counts each break once (got ${linesOf(Buffer.from("a\r\nb\rc\n\nd"))})`,
    );
    assert(
      linesOf(Buffer.from("")) === 0,
      `an empty file counts 0 lines — the count does not invent a line (got ${linesOf(Buffer.from(""))})`,
    );
    let nulRefused = false;
    try {
      nulRefused = "notText" in countTestLines(Buffer.from([0x61, 0x00, 0x62]));
    } catch {
      nulRefused = false;
    }
    assert(
      nulRefused,
      "a NUL byte refuses the count rather than guessing at it — and says so as a RESULT, not a throw, so the boundary can tell it from a read that failed",
    );
    // The same three cases where the rule actually bites: at the boundary, on
    // real files under a real `wt`.
    const crLong = "tests/AC1-cr-long.test.ts";
    writeFileSync(`${wt}/${crLong}`, lines(MAX_TEST_LINES + 1, "\r"));
    const crFit = "tests/AC1-cr-fit.test.ts";
    writeFileSync(`${wt}/${crFit}`, lines(MAX_TEST_LINES, "\r"));
    const nul = "tests/AC1-nul.test.ts";
    writeFileSync(`${wt}/${nul}`, Buffer.from("// a test\n\u0000\n// more\n"));
    const separators = await validateSubmitRows(
      [{ criterionId: "AC1", testFiles: [crLong, crFit, nul] }],
      { spec: SPEC, exists: () => true, existsAtBase: async () => false, wt },
    );
    const crLongDrop = separators.dropped.find((d) => d.path === crLong);
    assert(
      crLongDrop?.reason.includes(`${crLong} has ${MAX_TEST_LINES + 1} lines`) === true,
      `a ${MAX_TEST_LINES + 1}-line CR-separated file is refused at the boundary (got ${crLongDrop?.reason})`,
    );
    assert(
      separators.kept.flatMap((r) => r.testFiles).includes(crFit),
      `a ${MAX_TEST_LINES}-line CR-separated file is kept — the honest count refuses excess, not the bound (kept ${JSON.stringify(separators.kept)})`,
    );
    const nulDrop = separators.dropped.find((d) => d.path === nul);
    assert(
      nulDrop?.reason ===
        `${nul} is not a text file (NUL byte); an acceptance test is a source file`,
      `a NUL-bearing file is refused with the not-a-text reason naming the file — a UTF-16 test cannot read as 1 line and ship (got ${nulDrop?.reason})`,
    );

    // --- The quota is a RUN-level bound, not a per-call one ----
    // Three separate calls of two files each for AC1: per call every one of them
    // is legal, and the trial's four-file criterion is exactly what that shape
    // produced. With the run's frozen record seeded between the calls, AC1 keeps
    // `MAX_TEST_FILES_PER_CRITERION` files in TOTAL and the rest are refused.
    const run: Record<string, string[]> = {};
    const seed = (rows: { criterionId: string; testFiles: string[] }[]): void => {
      for (const r of rows) {
        const seen = new Set(run[r.criterionId] ?? []);
        for (const f of r.testFiles) seen.add(f);
        run[r.criterionId] = [...seen];
      }
    };
    const runFiles = [
      write("AC1-r1a.test.ts", 20),
      write("AC1-r1b.test.ts", 20),
      write("AC1-r2a.test.ts", 20),
      write("AC1-r2b.test.ts", 20),
      write("AC1-r3a.test.ts", 20),
      write("AC1-r3b.test.ts", 20),
    ];
    const keptAcrossRun: string[] = [];
    const droppedNotes = new Map<string, string>();
    for (const pair of [runFiles.slice(0, 2), runFiles.slice(2, 4), runFiles.slice(4, 6)]) {
      const call = await validateSubmitRows([{ criterionId: "AC1", testFiles: pair }], {
        spec: SPEC,
        exists: () => true,
        existsAtBase: async () => false,
        wt,
        frozenByCriterion: run,
      });
      for (const row of call.kept) {
        keptAcrossRun.push(...row.testFiles);
        seed([{ criterionId: row.criterionId, testFiles: row.testFiles }]);
      }
      for (const d of call.dropped) if (d.path !== undefined) droppedNotes.set(d.path, d.reason);
    }
    assert(
      keptAcrossRun.length === MAX_TEST_FILES_PER_CRITERION &&
        keptAcrossRun.every((f) => runFiles.includes(f)) &&
        droppedNotes.size === runFiles.length - MAX_TEST_FILES_PER_CRITERION,
      `three separate calls of ${MAX_TEST_FILES_PER_CRITERION} files each for AC1 keep ${MAX_TEST_FILES_PER_CRITERION} IN TOTAL across the run, not per call (kept ${JSON.stringify(keptAcrossRun)}, dropped ${JSON.stringify([...droppedNotes.keys()])})`,
    );
    assert(
      keptAcrossRun.length === MAX_TEST_FILES_PER_CRITERION &&
        runFiles
          .filter((f) => !keptAcrossRun.includes(f))
          .every((f) => (droppedNotes.get(f) ?? "").includes("already has")),
      "every file the run did not keep was REFUSED at the boundary, not silently never submitted — the surplus leaves a drop note the operator reads",
    );
    // A challenge round for a criterion the record says is already full keeps
    // NOTHING and refuses every file with the quota reason — the shape a second
    // round arrives in.
    const fullRound = await validateSubmitRows(
      [
        {
          criterionId: "AC1",
          testFiles: [write("AC1-r4a.test.ts", 20), write("AC1-r4b.test.ts", 20)],
        },
      ],
      {
        spec: SPEC,
        exists: () => true,
        existsAtBase: async () => false,
        wt,
        frozenByCriterion: { AC1: ["tests/AC1-frozen-a.test.ts", "tests/AC1-frozen-b.test.ts"] },
      },
    );
    assert(
      fullRound.kept.length === 0 &&
        fullRound.dropped.length === 2 &&
        fullRound.dropped.every(
          (d) =>
            d.criterionId === "AC1" &&
            d.reason ===
              `criterion AC1 already has ${MAX_TEST_FILES_PER_CRITERION} test files; one focused test per criterion is the norm`,
        ),
      `a round for a criterion that already has ${MAX_TEST_FILES_PER_CRITERION} frozen files keeps 0 and refuses the rest with the existing quota reason (kept ${JSON.stringify(fullRound.kept)}, dropped ${JSON.stringify(fullRound.dropped.map((d) => d.reason))})`,
    );
    // One frozen file leaves room for one, not two: the seed is a starting
    // count, not a switch.
    const halfFull = await validateSubmitRows(
      [
        {
          criterionId: "AC1",
          testFiles: [write("AC1-r5a.test.ts", 20), write("AC1-r5b.test.ts", 20)],
        },
      ],
      {
        spec: SPEC,
        exists: () => true,
        existsAtBase: async () => false,
        wt,
        frozenByCriterion: { AC1: ["tests/AC1-frozen-a.test.ts"] },
      },
    );
    assert(
      halfFull.kept.length === 1 &&
        halfFull.kept[0]?.testFiles.length === 1 &&
        halfFull.dropped.length === 1 &&
        (halfFull.dropped[0]?.reason.includes("already has") ?? false),
      `one frozen file leaves room for exactly one more — the seed counts, it does not merely flag (kept ${JSON.stringify(halfFull.kept)}, dropped ${JSON.stringify(halfFull.dropped.map((d) => d.reason))})`,
    );
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
}

// The facade test: `specify-tree.ts` is what both steps import, so if it ever
// re-exported a second implementation the two callers would be running
// different boundaries while the tests here judged one of them.
{
  const viaFacade = await import("../src/lean/specify-tree.ts");
  const direct = await import("../src/lean/submit-tests-cap.ts");
  assert(
    viaFacade.validateSubmitRows === direct.validateSubmitRows,
    "`validateSubmitRows` reached through the `specify-tree.ts` facade IS the one in `submit-tests-cap.ts` — one boundary, not two",
  );
}

process.exit(exit);

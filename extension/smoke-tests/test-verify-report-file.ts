#!/usr/bin/env bun
/**
 * #1404 — the out-of-band verify report: the ONLY channel the commit-pr
 * baseline probe reads failing-test names from.
 *
 * The probe excuses a failing test when the same test also fails at the base
 * commit. It used to read those names from the run's combined stdout+stderr,
 * which any test can write to: a test printing the loop's whole triad (a
 * per-file `FAILED: <path>`, a count-matched `FAILED: n test(s) — <path>`, and
 * a non-zero `P:/F:` tally) is byte-for-byte what the loop emits, so a GREEN
 * base could be made to name the change's failure, the change-caused failure was
 * excused, and the cycle pushed. The names now come from a file the loop writes
 * and a test never sees the path to (lib/verify-report-file.sh plus the `env -u`
 * scrub in lib/verify-kill.sh), so the stream cannot excuse anything.
 *
 * This file pins the READER: every shape that is not a complete, coherent report
 * must be a named `reason` (a park), never an empty list and never a fallback to
 * the stream. It also pins the WRITER against the real loop — that a red run and
 * an all-pass run both produce what this reader accepts — because a parser unit
 * test cannot catch the writer drifting out of agreement with the reader, which
 * is the failure mode that would park every cycle while looking green.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseVerifyReport,
  readVerifyReport,
} from "../src/work-driver-verify-report-file.ts";
import {
  createVerifyReportDir,
  createVerifyReportFile,
} from "../src/work-driver-verify-report-path.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── 1. the well-formed shapes.
{
  const ok = parseVerifyReport("a/b.ts\nc/d.ts\nFAILED-TESTS: 2\n");
  assert(
    ok.names?.length === 2 && ok.names[1] === "c/d.ts",
    `a well-formed report reads as its two names (got ${JSON.stringify(ok)})`,
  );
  assert(
    parseVerifyReport("FAILED-TESTS: 0\n").names?.length === 0,
    "the all-pass report is a POSITIVE zero, not a read failure — a green base must be establishable",
  );
  assert(
    parseVerifyReport("a/b.ts\nFAILED-TESTS: 1").names?.length === 1,
    "the trailing newline is formatting, not a name (no-final-newline tolerated)",
  );
}

// ── 2. every forgery / malformed shape is a named reason, never `names: []`.
//
// The distinction that matters is `names === undefined` (we do not know → park)
// versus `names: []` (the run named nothing → nothing is excused BY THE BASE,
// which is the change-caused branch). A forger wants the second; the module must
// never hand it over from a file it cannot vouch for.
{
  const forgeries: [string, string, string][] = [
    [
      "no trailer",
      "a/b.ts\n",
      "a test that appended a path to a report it could reach has no count, so the reader cannot know the list is complete",
    ],
    [
      "count disagrees with the list",
      "a/b.ts\nFAILED-TESTS: 3\n",
      "the trailer is the loop's own arithmetic; a hand-assembled body gets it wrong, and a reader that trusts the list over the count trusts whichever the forger prefers",
    ],
    [
      "trailer not last",
      "FAILED-TESTS: 1\na/b.ts\n",
      "names-then-count is the loop's only order; anything else was assembled",
    ],
    [
      "trailer inside the list",
      "a/b.ts\nFAILED-TESTS: 1\nc/d.ts\nFAILED-TESTS: 2\n",
      "one report carries exactly one count line",
    ],
    [
      "a stream marker smuggled into the name list",
      "FAILED: a/b.ts\nFAILED-TESTS: 1\n",
      "the loop never writes its own verdict markers into names — that is the stream's format, and its appearance here means text was copied",
    ],
    [
      "a tally line smuggled into the name list",
      "P: 3  F: 1\nFAILED-TESTS: 1\n",
      "same refusal for the tally shape",
    ],
    [
      "control character in a name",
      "a\u0000b.ts\nFAILED-TESTS: 1\n",
      "a path the loop recorded from argv cannot contain a NUL",
    ],
    [
      "a blank line where a name belongs",
      "a/b.ts\n\nFAILED-TESTS: 2\n",
      "a gap in the list is not a name",
    ],
    ["malformed trailer", "a/b.ts\nFAILED-TESTS: one\n", "the count is a number or it is not the loop's"],
    ["empty body", "", "an empty file is the shape of a run killed before its report half"],
    ["only newlines", "\n\n\n", "a file of whitespace named no test"],
    ["negative / non-safe count", "FAILED-TESTS: 99999999999999999999\n", "a count past what a suite can produce is not a count"],
  ];
  for (const [label, body, why] of forgeries) {
    const r = parseVerifyReport(body);
    assert(
      r.names === undefined && typeof r.reason === "string" && r.reason.length > 0,
      `parseVerifyReport refuses "${label}" — ${why}`,
    );
  }
}

// ── 3. the reader's I/O half: a path it cannot read is a reason, not the stream.
{
  const missing = readVerifyReport("/no/such/dir/report.txt");
  assert(
    missing.names === undefined && (missing.reason ?? "").includes("no verify report file"),
    `a missing report names why rather than reading the stream (got ${JSON.stringify(missing)})`,
  );
  const dir = createVerifyReportDir("pi-1404-reader-");
  const asDir = readVerifyReport(dir);
  assert(
    asDir.names === undefined,
    `a directory at the report path is a named failure, not a zero-name report (got ${JSON.stringify(asDir)})`,
  );
  const symlink = path.join(path.dirname(dir), "symlink-report.txt");
  const victim = path.join(path.dirname(dir), "victim.txt");
  const { symlinkSync, writeFileSync, unlinkSync } = await import("node:fs");
  writeFileSync(victim, "SECRET-PATH-ISH/one.ts\nFAILED-TESTS: 1\n");
  try {
    symlinkSync(victim, symlink);
    const r = readVerifyReport(symlink);
    assert(
      r.names === undefined,
      `a report path swapped for a symlink after creation is not read (O_NOFOLLOW); got ${JSON.stringify(r)}`,
    );
  } finally {
    for (const p of [symlink, victim]) {
      try {
        unlinkSync(p);
      } catch {
        // already gone
      }
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

// ── 4. the writer, against the REAL loop. The reader accepting a hand-written
// body proves nothing if the loop stopped writing that shape — every cycle would
// park on "no report" while every unit test stayed green.
{
  const FIXTURES = path.join(import.meta.dirname, "fixtures", "verify-loop");
  const LOOP = path.join(import.meta.dirname, "lib", "verify-loop.sh");
  const dir = createVerifyReportDir("pi-1404-writer-");
  const runLoop = (files: string[], reportFile: string | undefined): number => {
    const env: Record<string, string | undefined> = { ...process.env };
    if (reportFile === undefined) delete env.VERIFY_REPORT_FILE;
    else env.VERIFY_REPORT_FILE = reportFile;
    const r = spawnSync("bash", [LOOP, ...files.map((f) => path.join(FIXTURES, f))], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf8",
      env: env as NodeJS.ProcessEnv,
    });
    return r.status ?? -1;
  };

  const redFile = createVerifyReportFile(dir, "red");
  const redCode = runLoop(["fixture-1.ts", "allpass-a.ts"], redFile);
  const red = readVerifyReport(redFile);
  assert(
    redCode !== 0 &&
      red.names?.length === 1 &&
      (red.names[0] ?? "").endsWith("fixture-1.ts"),
    `the loop's own RED run writes exactly what this reader accepts (exit ${redCode}, got ${JSON.stringify(red)})`,
  );

  const greenFile = createVerifyReportFile(dir, "green");
  const greenCode = runLoop(["allpass-a.ts", "allpass-b.ts"], greenFile);
  const green = readVerifyReport(greenFile);
  assert(
    greenCode === 0 && green.names?.length === 0,
    `the loop's all-pass run writes a POSITIVE zero report, so a green base is establishable rather than merely unprobed (exit ${greenCode}, got ${JSON.stringify(green)})`,
  );

  // The off-by-default shape every other smoke test and CI depends on: with no
  // variable set, no file is created at any path the loop could choose.
  const quiet = path.join(dir, "quiet.txt");
  const quietCode = runLoop(["allpass-a.ts"], undefined);
  assert(
    quietCode === 0 && !existsSync(quiet),
    `with no VERIFY_REPORT_FILE the loop writes nothing and passes as before (exit ${quietCode})`,
  );

  // Multi-failure: the count must match the number of paths, which is the
  // invariant the reader's disagreement rule depends on.
  const manyFile = createVerifyReportFile(dir, "many");
  const manyCode = runLoop(
    ["fixture-1.ts", "fixture-multi.ts", "fixture-3.ts", "fixture-throw.ts", "allpass-a.ts"],
    manyFile,
  );
  const many = readVerifyReport(manyFile);
  const body = existsSync(manyFile) ? readFileSync(manyFile, "utf8") : "";
  assert(
    manyCode !== 0 &&
      many.names !== undefined &&
      many.names.length >= 3 &&
      body.split("\n").filter((l) => l === `FAILED-TESTS: ${many.names.length}`).length === 1,
    `a multi-failure run's list and count agree (exit ${manyCode}, ${JSON.stringify(many.names?.map((n) => path.basename(n)))})`,
  );

  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);

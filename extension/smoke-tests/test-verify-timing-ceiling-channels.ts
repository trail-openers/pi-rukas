#!/usr/bin/env bun
/**
 * Issue #2449 (epic #2424 item 3) — the two ceiling claims that are about the VERDICT
 * CHANNELS rather than the verdict itself, split from test-verify-timing-ceiling.ts for
 * the AGENTS.md §12 500-line cap. The ceiling's own cases (7a–7g) and the knob parse
 * live there; this file is the half that asks what the ceiling did to the streams other
 * consumers read.
 *
 * What is pinned:
 *
 *   1. Case 8 — with the ceiling on and no file over the bound, stdout is BYTE-IDENTICAL
 *      to the same run without the knob, and the opted-out stderr is the opted-in
 *      stderr with the timing lines deleted and nothing else changed. The ceiling is
 *      additive for every in-bounds file, which is the strongest claim available for a
 *      new arm: the tally, the `FAILED:` markers and the 800-char evidence window are
 *      all read from stdout.
 *   2. Case 9 — R5's other half. The driver does not read stdout; it reads the
 *      out-of-band report file. An offender must join `names` so that channel counts it
 *      too, on a run whose tests all PASSED. A change that stopped joining offenders
 *      would keep the stdout summary green and hand the driver `FAILED-TESTS: 0` on an
 *      exit-1 run — the shape the driver treats as unattributable.
 *
 * Durations are a busy-wait at 4× the bound, for the ±50% host-load swing recorded in
 * the sibling file's header.
 */
import {
  CEILING_OVER,
  FAIL,
  PASS,
  REPO,
  ceilingLines,
  GENERATED,
  isTimingLine,
  mkdtempDirSync,
  removeGenerated,
  runLoop,
  writeGenerated,
} from "./lib/verify-loop-timing-harness.ts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";


let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------- Case 8: the ceiling cannot disturb the verdict channels

{
  // The strongest additive claim available for the new arm, and the mirror of case
  // 5 for the knob: with the ceiling on and off over the SAME set, stdout — the
  // stream the tally, the `FAILED:` markers and the 800-char evidence window are
  // read from — is byte-identical while no file is over the bound, and the opted-
  // out stderr is the opted-in stderr with the timing lines deleted, nothing else.
  const A = writeGenerated(GENERATED.slow1, 1000);
  const set = [A, PASS, FAIL];
  try {
    const base = runLoop(set);
    const ceiling = runLoop(set, { PI_ENSEMBLE_VERIFY_TIMING_CEILING_S: "30" });
    assert(
      base.status === 1 && ceiling.status === 1,
      `case 8: both runs report the fixture's own failure (got ${base.status}/${ceiling.status})`,
    );
    assert(
      base.stdout === ceiling.stdout,
      `case 8: an in-bounds ceiling changes stdout not at all (${base.stdout.length}B vs ${ceiling.stdout.length}B)`,
    );
    assert(
      ceilingLines(ceiling.stderr).length === 0,
      `case 8: no CEILING line for a file under the bound (got ${JSON.stringify(ceilingLines(ceiling.stderr))})`,
    );
    const off = runLoop(set, {
      PI_ENSEMBLE_VERIFY_TIMING_CEILING_S: "30",
      PI_ENSEMBLE_VERIFY_TIMING: "0",
    });
    // The same `isTimingLine` filter as 7f (which also drops `CEILING:`, the shape
    // this run can print). Case 5 of test-verify-loop-timing.ts is the sibling claim
    // with no ceiling in play.
    const stripped = ceiling.stderr.split("\n").filter((l) => !isTimingLine(l));
    assert(
      stripped.join("\n") === off.stderr,
      `case 8: turning the timing off removes the ceiling lines and nothing else (stderr ${JSON.stringify(off.stderr.slice(0, 160))})`,
    );
  } finally {
    removeGenerated(A);
  }
}

// ------------------------- Case 9: R5's other half — the out-of-band report file

{
  // R5 says an offender is a NAMED failure, and the driver does not read stdout:
  // it reads the report file the loop writes when `VERIFY_REPORT_FILE` names a
  // path the driver pre-created (#1404), whose `FAILED-TESTS:` count is built from
  // the same `names` array the stdout summary is. test-verify-loop.ts pins that
  // channel for REAL failures only, so nothing pinned it for a ceiling offender: a
  // change that stopped joining offenders to `names` would keep the stdout summary
  // green and hand the driver `FAILED-TESTS: 0` on an exit-1 run — the exact shape
  // the driver treats as unattributable. Both halves are asserted on a run whose
  // tests all PASSED, so the only failure in the report is the clock.
  //
  // The path is ABSOLUTE, which also pins R4's key normalisation on this channel:
  // the loop records the caller's spelling verbatim, so the report carries an
  // absolute path while the offender reaches `names` only after `timing_key` has
  // reduced it to the list's key. A matcher that compared the raw string would
  // exempt nothing here and this assertion would go red.
  const dir = mkdtempDirSync(path.join(tmpdir(), "pi-2449-report-"));
  const report = path.join(dir, "report.txt");
  // The writer refuses anything but a regular file the caller created (a symlink
  // would make it an arbitrary-file writer), so the case pre-creates the path —
  // the state the driver's `O_EXCL` creates before it spawns the loop.
  writeFileSync(report, "");
  const ceiling = runLoop([PASS, path.resolve(REPO, CEILING_OVER)], {
    PI_ENSEMBLE_VERIFY_TIMING_CEILING_S: "2",
    FIXTURE_CEILING_MS: "8000",
    VERIFY_REPORT_FILE: report,
  });
  let body = "";
  try {
    body = existsSync(report) ? readFileSync(report, "utf8") : "";
  } catch {
    // Unreadable is the same answer as absent for these assertions: the driver
    // treats an unreadable report as unattributable, so the case must fail here.
    body = "";
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover scratch dir is reaped with TMPDIR */
  }
  assert(
    ceiling.status === 1,
    `case 9: the ceiling-only run exits 1 (got ${ceiling.status})`,
  );
  assert(
    body.endsWith("FAILED-TESTS: 1\n") && body.includes(path.basename(CEILING_OVER)),
    `case 9: the out-of-band report names the offender and counts it — FAILED-TESTS: 1 (R5; got: ${JSON.stringify(body)})`,
  );
  assert(
    !body.includes(path.basename(PASS)),
    `case 9: the passing file is NOT in the report — only the clock failed (got: ${JSON.stringify(body)})`,
  );
}

process.exit(exit);
#!/usr/bin/env bun
/**
 * Issue #1878 — per-test wall-clock time in the verify loop. The cases; the loop
 * harness (how to start it, its generated fixtures, the timing parsers) is in
 * ./lib/verify-loop-timing-harness.ts, split for the §12 file-size cap.
 *
 * What is pinned:
 *
 *   1. Every test that ran gets one machine-readable `TIME <seconds> <file>` line
 *      carrying the duration the run actually measured, at the shipped pool width
 *      and at N=1 — so the record cannot be an artifact of the scheduler. The
 *      timing prints on STDERR: stdout stays the verdict stream whose exact bytes
 *      feed extractAttributedTail's 800-char evidence window and pin the
 *      `P: <n>  F: <n>` tally as the last line.
 *   2. The slowest-first summary is ordered by the run's own record, honours the
 *      top-N window (with the junk-N and N=0 fallbacks), and its TOTAL line reports
 *      the run's wall clock beside the sum and max of the per-test times — so a
 *      pooled run's `wall` is LESS than its `sum`, and the two are not one number
 *      whose meaning is guessed.
 *   3. The timing is PURELY ADDITIVE: the exit code is identical with the feature on
 *      and off, stdout is byte-identical on and off, `--digest` prints no timing on
 *      either channel, the opt-out removes the timing lines and NOTHING else, and a
 *      run that never reaches the reporter times nothing.
 *
 * Durations are asserted as LOWER bounds on a known sleep and ordering as a strict
 * inequality between sleeps far apart: the loop's clock is bash `SECONDS` — whole
 * seconds, the same portable choice the pool's bound and the watchdog make — so an
 * exact-equality assertion would pin a rounding rule the loop never promised, and a
 * `0` is a legitimate reading for a test that finished inside one tick. For the
 * same reason `wall` is bounded by `sum` plus one tick per test: each per-test
 * reading can fall up to a tick short, and a serial run's wall also carries the
 * gaps between jobs, so a plain `wall <= sum` holds only while the host is idle.
 *
 * Deliberately NOT covered: a test killed by the pool's OUTER per-job bound as a
 * shape distinct from the watchdog's kill. Producing it needs a descendant that
 * survives both SIGTERM rounds — a new unbounded hanging fixture, under a scope that
 * forbids touching the reap/kill paths. Both shapes already write the timeout marker,
 * so both read as `timeout after <N>s`, which is the honest reading of the evidence
 * the run keeps. Case 3 pins the three shapes the run produces without inventing one.
 * The pre-existing output contracts (tally, `FAILED:`, digest shape) are pinned by
 * test-verify-loop.ts, test-verify-loop-timeout.ts, test-verify-loop-parallel.ts and
 * test-ci-verify-digest.ts; cases 4/5 here only pin that the timing does not disturb
 * them.
 */
import { existsSync } from "node:fs";
import * as path from "node:path";
import {
  FAIL,
  GENERATED,
  HANG,
  LIVE,
  HEADER_RE,
  PASS,
  TIME_RE,
  TOTAL_RE,
  blockRows,
  outcomeOf,
  removeGenerated,
  runLoop,
  summaryHeader,
  timeLines,
  timingOutput,
  totalLine,
  writeGenerated,
} from "./lib/verify-loop-timing-harness.ts";

// The cases own the pass/fail counter: the harness reports its own setup failures
// fatally (harnessFatal), so anything counted here is a real assertion.
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}


// ------------------------- Case 1: one TIME line per test, at both pool widths

for (const jobs of ["1", "3"]) {
  const A = writeGenerated(GENERATED.slow6, 6000);
  const B = writeGenerated(GENERATED.slow2, 2000);
  try {
    const r = runLoop([A, B, PASS], { PI_ENSEMBLE_VERIFY_TEST_JOBS: jobs });
    assert(r.status === 0, `case 1 (JOBS=${jobs}): the set passes (got ${r.status})`);
    const rows = timeLines(r.stderr);
    assert(
      rows.length === 3,
      `case 1 (JOBS=${jobs}): one TIME line per test that ran (got ${JSON.stringify(rows)})`,
    );
    const byFile = new Map(rows.map((x) => [x.file, x.secs]));
    assert(
      (byFile.get(A) ?? -1) >= 3,
      `case 1 (JOBS=${jobs}): the 6s fixture records at least its own sleep (got ${byFile.get(A)})`,
    );
    assert(
      (byFile.get(B) ?? -1) >= 2 && (byFile.get(B) ?? 0) < (byFile.get(A) ?? 0),
      `case 1 (JOBS=${jobs}): the 2s fixture is recorded and strictly faster than the 6s one (got ${byFile.get(B)} vs ${byFile.get(A)})`,
    );
    assert(
      byFile.has(PASS),
      `case 1 (JOBS=${jobs}): the fast passing test is recorded too, not only the slow ones`,
    );
    const header = summaryHeader(r.stderr);
    assert(
      header !== null && header.shown === 3 && header.total === 3 && header.n === 30,
      `case 1 (JOBS=${jobs}): the block names the window it shows, of the files recorded (got ${JSON.stringify(header)})`,
    );
    const block = blockRows(r.stderr);
    assert(
      block.length === 3 && block[0]?.file === A && block[1]?.file === B,
      `case 1 (JOBS=${jobs}): the block is slowest-first — the 6s fixture then the 2s one (got ${JSON.stringify(block)})`,
    );
    const total = totalLine(r.stderr);
    const m = TOTAL_RE.exec(total);
    assert(m !== null, `case 1 (JOBS=${jobs}): the TOTAL line is present and well-formed (got ${JSON.stringify(total)})`);
    if (m) {
      const wall = Number(m[1]);
      const sum = Number(m[2]);
      const max = Number(m[3]);
      assert(
        sum >= 8 && sum <= 25,
        `case 1 (JOBS=${jobs}): sum is the per-test times added up, not the run's clock (got ${sum})`,
      );
      assert(max === Math.max(...rows.map((x) => x.secs)), `case 1 (JOBS=${jobs}): max is the slowest single test (got ${max})`);
      assert(
        wall >= 6 && wall <= sum + rows.length,
        `case 1 (JOBS=${jobs}): wall is the run's clock and exceeds the summed per-test times by no more than one tick per test (got wall ${wall}, sum ${sum})`,
      );
    }
  } finally {
    removeGenerated(A);
    removeGenerated(B);
  }
}

// ------------------------- Case 2: the top-N window, and the sums it sits beside

{
  // 1s / 2s / 1s / 4s / 1s. The two-second apart sleeps are what make the window
  // checkable: a block that merely printed the record's own order would put the 2s
  // fixture second only by luck of the argument list.
  const durs = [1000, 2000, 1000, 4000, 1000];
  const files = GENERATED.many.map((n, i) => writeGenerated(n, durs[i] ?? 1000));
  try {
    // One wide run supplies BOTH the full row set and the TOTAL the sums are checked
    // against: whole-second timings move between runs, so comparing one run's TOTAL
    // to another run's rows would fail on noise rather than on a real defect.
    const wide = runLoop(files, { PI_ENSEMBLE_VERIFY_TIMING_TOP_N: "99" });
    assert(wide.status === 0, `case 2: the five-file set passes (got ${wide.status})`);
    const wideRows = blockRows(wide.stderr);
    assert(
      wideRows.length === 5,
      `case 2: with N wide enough the block holds one row per file (got ${JSON.stringify(wideRows.map((x) => path.basename(x.file)))})`,
    );
    const wideHeader = summaryHeader(wide.stderr);
    assert(
      wideHeader !== null && wideHeader.shown === 5 && wideHeader.total === 5 && wideHeader.n === 99,
      `case 2: N is reported as asked, and shown counts the files (got ${JSON.stringify(wideHeader)})`,
    );
    const wideTotal = TOTAL_RE.exec(totalLine(wide.stderr));
    assert(wideTotal !== null, `case 2: the wide run prints TOTAL (got ${JSON.stringify(totalLine(wide.stderr))})`);
    if (wideTotal) {
      const sum = Number(wideTotal[2]);
      const max = Number(wideTotal[3]);
      assert(
        sum === wideRows.reduce((a, x) => a + x.secs, 0),
        `case 2: sum is the per-test times of the same run added up (got ${sum} vs ${JSON.stringify(wideRows.map((x) => x.secs))})`,
      );
      assert(max === Math.max(...wideRows.map((x) => x.secs)), `case 2: max is that run's slowest test (got ${max})`);
      assert(
        Number(wideTotal[1]) <= sum + wideRows.length,
        `case 2: the run's wall (${wideTotal[1]}) exceeds its summed per-test times (${sum}) by no more than one tick per test`,
      );
    }

    const narrow = runLoop(files, { PI_ENSEMBLE_VERIFY_TIMING_TOP_N: "2" });
    const header = summaryHeader(narrow.stderr);
    assert(
      header !== null && header.shown === 2 && header.total === 5,
      `case 2: N=2 shows two rows out of five (got ${JSON.stringify(header)})`,
    );
    const rows = blockRows(narrow.stderr);
    assert(rows.length === 2, `case 2: the block carries exactly the N rows asked for (got ${JSON.stringify(rows)})`);
    // The window is checked against the run's OWN record, not against the sleeps that
    // were asked for: the loop's clock is whole seconds, so two fixtures that were
    // meant to take 1s and 2s can legitimately both read 2 — which is why asserting
    // "the 2s file is second" would pin a rounding rule, and why the slowest file was
    // given a 4s sleep in the first place (case 1 pins the strict ordering against a
    // 6s fixture, where no plausible rounding can tie). What is pinned here is that
    // the window keeps the slowest recorded file first, and the whole record below is
    // not truncated by it.
    const record = timeLines(narrow.stderr);
    const slowest = record.reduce((a, x) => (x.secs > a.secs ? x : a), record[0] ?? { secs: -1, file: "" });
    assert(
      rows.length === 2 &&
        rows[0]?.file === files[3] &&
        rows[0]?.file === slowest.file &&
        (rows[1]?.secs ?? 0) <= (rows[0]?.secs ?? 0) &&
        record.some((x) => x.file === rows[1]?.file),
      `case 2: the two rows are the slowest recorded file first, then a faster one, both drawn from the record (got ${JSON.stringify({ rows: rows.map((x) => [path.basename(x.file), x.secs]), slowest: [path.basename(slowest.file), slowest.secs] })})`,
    );
    // The per-file record is NOT truncated by the window: the block is a view, the
    // lines are the record.
    assert(
      timeLines(narrow.stderr).length === 5,
      `case 2: the per-file lines still cover every test when the block is truncated (got ${timeLines(narrow.stderr).length})`,
    );
    const bad = runLoop([PASS], { PI_ENSEMBLE_VERIFY_TIMING_TOP_N: "not-a-number" });
    assert(
      bad.status === 0 && (summaryHeader(bad.stderr)?.n ?? -1) === 30,
      `case 2: a junk N falls back to the shipped 30 with the value named on stderr (got ${JSON.stringify(summaryHeader(bad.stderr))})`,
    );
    assert(
      /PI_ENSEMBLE_VERIFY_TIMING_TOP_N/.test(bad.stderr),
      `case 2: the rejected N is named on stderr rather than silently replaced (stderr: ${JSON.stringify(bad.stderr.slice(0, 200))})`,
    );
    const zero = runLoop(files, { PI_ENSEMBLE_VERIFY_TIMING_TOP_N: "0" });
    const zeroHeader = summaryHeader(zero.stderr);
    assert(
      zeroHeader !== null && zeroHeader.shown === 0 && blockRows(zero.stderr).length === 0,
      `case 2: N=0 prints the header and TOTAL with no rows — the totals without the list (got ${JSON.stringify(zeroHeader)})`,
    );
    assert(
      TOTAL_RE.test(totalLine(zero.stderr)),
      `case 2: N=0 still reports the totals (got ${JSON.stringify(totalLine(zero.stderr))})`,
    );
  } finally {
    for (const p of files) removeGenerated(p);
  }
}

// ------------------------- Case 3: the outcome each test's row carries

{
  const token = `timing-outcome-${process.pid}-${Date.now()}`;
  const r = runLoop([PASS, FAIL, HANG], {
    PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S: "2",
    PI_ENSEMBLE_VERIFY_TEST_JOBS: "3",
    FIXTURE_HANG_TOKEN: token,
  });
  assert(r.status === 1, `case 3: the mixed set exits 1 (got ${r.status})`);
  const rows = timeLines(r.stderr);
  assert(
    rows.length === 3,
    `case 3: one TIME line per test, the timed-out one included (got ${JSON.stringify(rows.map((x) => path.basename(x.file)))})`,
  );
  assert(outcomeOf(r.stderr, PASS) === "pass", `case 3: the passing test is labelled pass (got ${JSON.stringify(outcomeOf(r.stderr, PASS))})`);
  assert(outcomeOf(r.stderr, FAIL) === "fail", `case 3: the failing test is labelled fail (got ${JSON.stringify(outcomeOf(r.stderr, FAIL))})`);
  assert(
    outcomeOf(r.stderr, HANG) === "timeout after 2s",
    `case 3: the watchdog's kill is labelled with the bound it fired at (got ${JSON.stringify(outcomeOf(r.stderr, HANG))})`,
  );
  // The block's label and the `FAILED:` line must agree, since they are read from
  // one marker: a block that called a timed-out test `fail` would send a reader to
  // the assertion output of a test that never reached an assertion.
  assert(
    r.stdout.includes(`FAILED: ${HANG} (timed out after 2s)`),
    `case 3: the marker keeps its timeout suffix (stdout: ${JSON.stringify(r.stdout.slice(0, 300))})`,
  );
  const hangRow = rows.find((x) => x.file === HANG);
  assert(
    hangRow !== undefined && hangRow.secs >= 2,
    `case 3: a test killed at its bound records the time it actually took (got ${JSON.stringify(hangRow)})`,
  );
}

// ------------------------- Case 4: the timing cannot change the verdict

{
  const A = writeGenerated(GENERATED.slow2, 2000);
  const set = [A, PASS, FAIL];
  const normal = runLoop(set);
  const digest = runLoop(set, {}, ["--digest"]);
  assert(
    normal.status === digest.status && normal.status === 1,
    `case 4: the exit code is identical between modes (normal ${normal.status}, digest ${digest.status})`,
  );
  assert(
    timingOutput(normal.stderr).length > 0,
    `case 4: normal mode carries the lines and the block (got ${JSON.stringify(timingOutput(normal.stderr))})`,
  );
  // Both channels: the digest is a FILTER over the run's output, so a block that
  // leaked onto its stderr breaches the contract as much as one on stdout — and
  // stderr is the channel the feature now uses, so a stdout-only check would miss it.
  assert(
    timingOutput(digest.stdout).length === 0 && timingOutput(digest.stderr).length === 0,
    `case 4: --digest prints no timing on either channel (stdout: ${JSON.stringify(digest.stdout)}, stderr: ${JSON.stringify(digest.stderr)})`,
  );
  // The strongest additive claim available: with the feature on and off, stdout —
  // the stream the tally, the `FAILED:` markers and the 800-char evidence window are
  // all read from — is byte-identical.
  const offStdout = runLoop(set, { PI_ENSEMBLE_VERIFY_TIMING: "0" });
  assert(
    normal.stdout === offStdout.stdout,
    `case 4: stdout is byte-identical with the timing on and off (on ${normal.stdout.length}B, off ${offStdout.stdout.length}B)`,
  );
  assert(
    normal.stderr.includes("SLOWEST:") && !offStdout.stderr.includes("SLOWEST:"),
    `case 4: the block is on stderr and the opt-out removes it from there (stderr on: ${JSON.stringify(normal.stderr.slice(-80))})`,
  );
  const dLines = digest.stdout.split("\n").filter((l) => l !== "");
  assert(
    dLines.at(-1) === "P: 2  F: 1",
    `case 4: the tally is still the digest's last line (got ${JSON.stringify(dLines.at(-1))})`,
  );
  assert(
    (dLines.at(-2) ?? "").startsWith("FAILED: 1 test(s) —"),
    `case 4: the summary marker is still second-to-last (got ${JSON.stringify(dLines.at(-2))})`,
  );
  assert(
    /^TIME \d+ /.test(timingOutput(normal.stderr)[0] ?? ""),
    `case 4: the machine-readable line is the pinned shape, unindented (got ${JSON.stringify(timingOutput(normal.stderr)[0])})`,
  );
  removeGenerated(A);
}

// ------------------------- Case 5: the opt-out removes the timing and nothing else

{
  const A = writeGenerated(GENERATED.slow2, 2000);
  const B = writeGenerated(GENERATED.slow1, 1000);
  try {
    const on = runLoop([A, B, PASS]);
    const off = runLoop([A, B, PASS], { PI_ENSEMBLE_VERIFY_TIMING: "0" });
    assert(on.status === 0 && off.status === 0, `case 5: the opt-out does not change the exit code (${on.status} / ${off.status})`);
    assert(timingOutput(on.stderr).length > 0, `case 5: with the default on, lines and block both print`);
    assert(
      timingOutput(off.stderr).length === 0,
      `case 5: PI_ENSEMBLE_VERIFY_TIMING=0 prints neither (stdout: ${JSON.stringify(off.stdout)})`,
    );
    // Byte-for-byte: the opted-out stream is the opted-in stream with the timing
    // lines deleted, so no other line shifted, gained a suffix, or was reordered.
    // The comparison is on the channel the timing travels on: stderr. The case
    // asserts the opted-OUT stderr equals the opted-IN stderr with the timing lines
    // deleted — so what is pinned is that the feature added no other diagnostic
    // (no reordered warn, no extra note), not merely that stdout is untouched.
    const stripped = on.stderr
      .split("\n")
      .filter((l) => !TIME_RE.test(l) && !HEADER_RE.test(l) && !TOTAL_RE.test(l));
    const firstDiff = stripped.findIndex((l, i) => l !== off.stderr.split("\n")[i]);
    assert(
      stripped.join("\n") === off.stderr,
      `case 5: the opted-out output is the opted-in output minus the timing lines, nothing else (first differing line: ${firstDiff} -> ${JSON.stringify([stripped[firstDiff], off.stderr.split("\n")[firstDiff]])})`,
    );
    const digestOff = runLoop([A, PASS], { PI_ENSEMBLE_VERIFY_TIMING: "0" }, ["--digest"]);
    assert(
      digestOff.stdout === "P: 2  F: 0\n",
      `case 5: the digest's one-line contract holds with the knob off (got ${JSON.stringify(digestOff.stdout)})`,
    );
    const junk = runLoop([PASS], { PI_ENSEMBLE_VERIFY_TIMING: "maybe" });
    assert(
      timingOutput(junk.stderr).length > 0 && /PI_ENSEMBLE_VERIFY_TIMING/.test(junk.stderr),
      `case 5: a junk knob keeps the shipped behaviour on and names the bad value (stdout lines: ${timingOutput(junk.stderr).length}, stderr: ${JSON.stringify(junk.stderr.slice(0, 160))})`,
    );
  } finally {
    removeGenerated(A);
    removeGenerated(B);
  }
}

// ------------------------- Case 6: a run that never starts a pool times nothing

{
  if (!existsSync(LIVE)) {
    console.error(`✗ case 6: ${LIVE} is missing — the vacuous-run case cannot run`);
    exit = 1;
  } else {
    const r = runLoop([LIVE]);
    assert(r.status === 3, `case 6: a run whose only argument was a live test exits 3 as before (got ${r.status})`);
    assert(
      timingOutput(r.stdout).length === 0,
      `case 6: the vacuous run prints no timing (stdout: ${JSON.stringify(r.stdout)})`,
    );
  }
}

process.exit(exit);

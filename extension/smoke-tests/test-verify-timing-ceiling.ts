#!/usr/bin/env bun
/**
 * Issue #2449 (epic #2424 item 3) — the per-file wall-time ceiling of the verify
 * loop, and the committed allow-list it reads. The timing cases and the harness
 * live in test-verify-loop-timing.ts and lib/verify-loop-timing-harness.ts; this
 * file is the ceiling half, split out for the AGENTS.md §12 500-line cap.
 *
 * What is pinned:
 *
 *   1. AC1 — with `PI_ENSEMBLE_VERIFY_TIMING_CEILING_S=N`, a file NOT on the
 *      allow-list whose recorded time exceeds N fails the run: a `CEILING:` line
 *      naming it on stderr, a `FAILED:` entry naming it, and exit 1 — for a test
 *      whose own assertions passed. The same file at the same duration and the
 *      same bound, named by the list, exits 0 and prints nothing.
 *   2. R9/R2 — the line is exactly `CEILING: <secs>s <file> (ceiling <N>s)` and
 *      travels on stderr; `--digest` prints no timing line on either channel yet
 *      still exits 1 and counts the offender in its tally.
 *   3. R5 — an offender is a NAMED failure, so the summary and the tally carry it;
 *      the run is red on the clock and the failing test's own `✗` output is absent.
 *   4. R6 — a row the watchdog killed is exempt: its seconds measure the bound.
 *   5. R3 — the knob accepts 1–4 digits only; junk and overflow name the value on
 *      stderr and leave the ceiling OFF, and `0` is off in silence.
 *   6. AC2 — with the knob unset, stdout and stderr are byte-identical to the
 *      explicit-off run; and with the ceiling on but nothing over it, stdout is
 *      byte-identical to the run without the knob, so the feature stays additive
 *      for every file in bounds.
 *
 * Durations are a busy-wait at 4× the bound, not a timer: per-file times swing
 * about ±50% with pool neighbours and host load (the same file measured 99 s and
 * 139 s in two runs of this suite), so a fixture that slept just past its ceiling
 * would fail this test on a loaded host for a reason that is not the ceiling. The
 * two ceiling fixtures are COMMITTED rather than generated because the exemption is
 * keyed on a path — a generated name is exemptible only by a list nobody can check.
 */
import {
  CEILING_LISTED,
  CEILING_OVER,
  CEILING_RE,
  FAIL,
  GENERATED,
  HANG,
  HEADER_RE,
  PASS,
  TIME_RE,
  TOTAL_RE,
  ceilingLines,
  removeAllowlist,
  removeGenerated,
  runLoop,
  timeLines,
  timingOutput,
  writeAllowlist,
  writeGenerated,
} from "./lib/verify-loop-timing-harness.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------- Case 7: the per-file ceiling (PI_ENSEMBLE_VERIFY_TIMING_CEILING_S)

{
  // The duration sits at 4× the ceiling rather than just past it: per-file times
  // swing about ±50% with pool neighbours and host load, and a fixture that slept
  // 4 s against a 3 s bound could read 3 on a loaded host and fail for the wrong
  // reason. The busy-wait fixtures are committed, not generated, because the
  // exemption is keyed on a path the list has to name.
  const CEIL = "2";
  const env = {
    PI_ENSEMBLE_VERIFY_TIMING_CEILING_S: CEIL,
    FIXTURE_CEILING_MS: "8000",
    PI_ENSEMBLE_VERIFY_TEST_JOBS: "2",
  };

  // --- AC1, the red arm: an unlisted file over the ceiling fails the run.
  const unlisted = runLoop([PASS, CEILING_OVER], env);
  const offenders = ceilingLines(unlisted.stderr);
  assert(
    unlisted.status === 1,
    `case 7a: an unlisted file past the ceiling fails a run whose test passed (got ${unlisted.status}; ceiling lines: ${JSON.stringify(offenders)})`,
  );
  assert(
    offenders.length === 1 && offenders[0]?.file === CEILING_OVER,
    `case 7a: exactly one CEILING line, naming the fixture (got ${JSON.stringify(offenders)})`,
  );
  assert(
    offenders.length === 1 && offenders[0]?.ceiling === Number(CEIL),
    `case 7a: the line names the ceiling it broke (got ${JSON.stringify(offenders[0])})`,
  );
  assert(
    offenders.length === 1 && (offenders[0]?.secs ?? -1) >= Number(CEIL),
    `case 7a: the line carries the file's own recorded time (got ${JSON.stringify(offenders[0])})`,
  );
  assert(
    unlisted.stdout.includes(`FAILED: 1 test(s) — ${CEILING_OVER}`),
    `case 7a: the offender is a NAMED failure — the FAILED <n> test(s) list summary carries it (R5) (stdout: ${JSON.stringify(unlisted.stdout.slice(0, 240))})`,
  );
  assert(
    unlisted.stdout.includes("1 test(s)"),
    `case 7a: the summary counts the offender as the one failure, not the clock (stdout: ${JSON.stringify(unlisted.stdout.slice(-60))})`,
  );
  assert(
    /^CEILING: \d+s .+ \(ceiling 2s\)$/m.test(unlisted.stderr) &&
      !/^CEILING:/m.test(unlisted.stdout),
    "case 7a: the line is on stderr in the pinned shape and never on stdout",
  );
  assert(
    !unlisted.stdout.includes("✗"),
    `case 7a: the run is red on the clock, not on an assertion — the fixture itself passed (stdout: ${JSON.stringify(unlisted.stdout.slice(0, 240))})`,
  );

  // --- AC1, the green arm: the same file, the same ceiling, exempt by the list.
  const list = writeAllowlist([
    { file: "smoke-tests/fixtures/verify-loop/fixture-ceiling-listed.ts", seconds: 9 },
  ]);
  try {
    const listed = runLoop([PASS, CEILING_LISTED], { ...env, TIMING_ALLOWLIST: list });
    assert(
      listed.status === 0,
      `case 7b: an allow-listed file past the ceiling passes the run (got ${listed.status}; stderr: ${JSON.stringify(listed.stderr.slice(0, 240))})`,
    );
    assert(
      ceilingLines(listed.stderr).length === 0,
      `case 7b: an exempt file prints no CEILING line (got ${JSON.stringify(ceilingLines(listed.stderr))})`,
    );
    assert(
      timeLines(listed.stderr).some((r) => r.file === CEILING_LISTED),
      "case 7b: the exempt file is still measured — exemption is from the bound, not the record",
    );

    // A list that names nothing exempts nothing, even when the file is on disk.
    const empty = runLoop([PASS, CEILING_LISTED], {
      ...env,
      TIMING_ALLOWLIST: writeAllowlist([]),
    });
    assert(
      empty.status === 1 && ceilingLines(empty.stderr).length === 1,
      `case 7b: the same file fails when the list does not name it (got ${empty.status})`,
    );

    // --- R2: digest mode stays silent on both channels and still exits 1.
    const digest = runLoop([PASS, CEILING_OVER], env, ["--digest"]);
    assert(
      digest.status === 1,
      `case 7c: --digest still fails on an unlisted offender (got ${digest.status})`,
    );
    assert(
      timingOutput(digest.stdout).length === 0 && timingOutput(digest.stderr).length === 0,
      `case 7c: --digest prints no TIME/SLOWEST/TOTAL/CEILING on either channel (stdout ${JSON.stringify(digest.stdout.slice(0, 160))}, stderr ${JSON.stringify(digest.stderr.slice(0, 160))})`,
    );
    const dLines = digest.stdout.split("\n").filter((l) => l !== "");
    assert(
      dLines.at(-1) === "P: 1  F: 1",
      `case 7c: the digest's tally counts the offender as a failure (got ${JSON.stringify(dLines.at(-1))})`,
    );
  } finally {
    removeAllowlist(list);
  }

  // --- R6: a row the watchdog killed is exempt — its secs measure the bound.
  const hung = runLoop([PASS, HANG], {
    PI_ENSEMBLE_VERIFY_TIMING_CEILING_S: "1",
    PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S: "4",
    PI_ENSEMBLE_VERIFY_TEST_JOBS: "2",
    FIXTURE_HANG_TOKEN: `ceiling-hang-${process.pid}`,
  });
  assert(
    hung.status === 1,
    `case 7d: the timed-out run is red on the watchdog as before (got ${hung.status})`,
  );
  assert(
    ceilingLines(hung.stderr).length === 0,
    `case 7d: a timeout row is exempt from the ceiling — the watchdog already failed it (got ${JSON.stringify(ceilingLines(hung.stderr))})`,
  );

  // --- R3: knob parsing. Junk names its value and leaves the ceiling OFF; `0`
  // is off in silence; a leading-zero or sign-bearing value is junk, not a number.
  const junk = runLoop([PASS, CEILING_OVER], {
    PI_ENSEMBLE_VERIFY_TIMING_CEILING_S: "not-a-number",
    FIXTURE_CEILING_MS: "8000",
  });
  assert(
    junk.status === 0 &&
      /PI_ENSEMBLE_VERIFY_TIMING_CEILING_S/.test(junk.stderr) &&
      /not-a-number/.test(junk.stderr),
    `case 7e: a junk ceiling warns naming the value and stays off (status ${junk.status}, stderr ${JSON.stringify(junk.stderr.slice(0, 200))})`,
  );
  const overflow = runLoop([PASS, CEILING_OVER], {
    PI_ENSEMBLE_VERIFY_TIMING_CEILING_S: "99999999999999999999999",
    FIXTURE_CEILING_MS: "8000",
  });
  assert(
    overflow.status === 0 && /PI_ENSEMBLE_VERIFY_TIMING_CEILING_S/.test(overflow.stderr),
    `case 7e: an overflow-width value is rejected, named, and leaves the ceiling off (status ${overflow.status})`,
  );
  const zero = runLoop([PASS, CEILING_OVER], {
    PI_ENSEMBLE_VERIFY_TIMING_CEILING_S: "0",
    FIXTURE_CEILING_MS: "8000",
  });
  assert(
    zero.status === 0 &&
      ceilingLines(zero.stderr).length === 0 &&
      !/PI_ENSEMBLE_VERIFY_TIMING_CEILING_S/.test(zero.stderr),
    `case 7e: 0 is off without a warning (status ${zero.status}, stderr ${JSON.stringify(zero.stderr.slice(0, 200))})`,
  );

  // --- AC2: with the knob unset, behaviour is unchanged — the offender's own file
  // name never appears on either channel and no CEILING line is printed. Comparing
  // two SEPARATE busy-wait processes for byte-identity is not this contract: the
  // per-file `TIME` line records the wall clock, which lands on 8 or 9 across runs
  // (the ±50% swing the file header pins), so stdout/stderr can only be compared
  // modulo those timing lines — which is exactly what the stripped comparison below
  // and case 8 do. The unset run and the explicit-0 run take the SAME off path, so
  // what is pinned here is that the off path prints no ceiling verdict at all.
  const on = runLoop([PASS, CEILING_OVER], { FIXTURE_CEILING_MS: "8000" });
  const knobOff = runLoop([PASS, CEILING_OVER], {
    FIXTURE_CEILING_MS: "8000",
    PI_ENSEMBLE_VERIFY_TIMING_CEILING_S: "0",
  });
  assert(
    on.status === 0 && knobOff.status === 0,
    `case 7f: with no ceiling asked for, a slow passing file stays green (${on.status} / ${knobOff.status})`,
  );
  // Modulo the per-file timing lines (which measure the clock and so legitimately
  // vary run to run), the two off-path runs agree on both channels.
  const stripTiming = (s: string) =>
    s
      .split("\n")
      .filter((l) => !TIME_RE.test(l) && !HEADER_RE.test(l) && !TOTAL_RE.test(l))
      .join("\n");
  assert(
    stripTiming(on.stdout) === stripTiming(knobOff.stdout) &&
      stripTiming(on.stderr) === stripTiming(knobOff.stderr),
    `case 7f: the unset knob and the explicit 0 agree on both channels modulo the timing lines (stdout ${on.stdout.length}B/${knobOff.stdout.length}B, stderr ${on.stderr.length}B/${knobOff.stderr.length}B)`,
  );
  assert(
    ceilingLines(on.stderr).length === 0 &&
      !/^FAILED:/m.test(on.stdout) &&
      !/CEILING:/m.test(on.stderr),
    `case 7f: the unset knob prints no verdict at all (stderr ${JSON.stringify(on.stderr.slice(0, 160))})`,
  );
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
    const stripped = ceiling.stderr
      .split("\n")
      .filter(
        (l) => !TIME_RE.test(l) && !HEADER_RE.test(l) && !TOTAL_RE.test(l) && !CEILING_RE.test(l),
      );
    assert(
      stripped.join("\n") === off.stderr,
      `case 8: turning the timing off removes the ceiling lines and nothing else (stderr ${JSON.stringify(off.stderr.slice(0, 160))})`,
    );
  } finally {
    removeGenerated(A);
  }
}

process.exit(exit);

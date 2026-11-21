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
 *      for every file in bounds. AND the off path does no exemption work at all:
 *      `_timing_allowlist_entries` forks `awk` per read, so a knob-off run that
 *      still consulted the list paid ~2 forks per timing row (~3,154 forks /
 *      ~21 s on this repo's own suite) for a feature nobody asked for. The probe
 *      file in case 7g is the witness — the shipped parser appends one line to
 *      `TIMING_ALLOWLIST_PROBE` per fork, so the off run must leave it empty.
 *   7. R5's other half — the out-of-band report file (`VERIFY_REPORT_FILE`) counts
 *      the offender too: `FAILED-TESTS: 1` and the path, for a run whose tests all
 *      passed. The stdout summary and the report file are two readers of the same
 *      `names` array and the driver reads only the file.
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
  REPO,
  TIME_RE,
  TOTAL_RE,
  ceilingLines,
  mkdtempDirSync,
  removeAllowlist,
  removeGenerated,
  runLoop,
  timeLines,
  timingOutput,
  writeAllowlist,
  writeGenerated,
} from "./lib/verify-loop-timing-harness.ts";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** Every line the timing feature prints — `TIME` rows, the block's header, rows and
 * TOTAL, and `CEILING:`. Module-scope: 7f and case 8 both strip it before comparing
 * whole channels, and the two must strip one set to be one claim. Not the harness'
 * `timingOutput`, which returns the lines it RECOGNISES — comparing through it is an
 * equality of two filtered sets and passes on streams differing anywhere else. */
function isTimingLine(l: string): boolean {
  return TIME_RE.test(l) || HEADER_RE.test(l) || TOTAL_RE.test(l) || CEILING_RE.test(l);
}

const stripTiming = (s: string): string => s.split("\n").filter((l) => !isTimingLine(l)).join("\n");

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
  // The offender joins `names` with an EMPTY capture placeholder, because it failed
  // on the clock and no job ever wrote it a `✗` line. The #827 tail echo walks those
  // captures with `grep -F -- "✗" "$capfile"`, and the empty entry is not a file name:
  // every offender-only failure printed `grep: : No such file or directory` on stderr,
  // a diagnostic from the reporter itself on a run whose only fault was the clock (the
  // digest arm has tested `-n`/`-f` on the same placeholder since #2449 landed; the
  // normal-mode echo had no such guard and no assertion). Reproduced before the fix:
  // one such line per offender, between the `FAILED:` summary and the SLOWEST block.
  assert(
    !/grep:.*No such file or directory/.test(unlisted.stderr),
    `case 7a: a ceiling-only failure prints no grep diagnostic for the offender's empty capture placeholder (stderr: ${JSON.stringify(unlisted.stderr.slice(0, 400))})`,
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
  // Both lists are held in one `try` so the empty-list temp dir is removed on the
  // same path as the named one: each `writeAllowlist` allocates its own 0700 dir
  // under TMPDIR and nothing else removes it.
  const list = writeAllowlist([
    { file: "smoke-tests/fixtures/verify-loop/fixture-ceiling-listed.ts", seconds: 9 },
  ]);
  const emptyList = writeAllowlist([]);
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
      TIMING_ALLOWLIST: emptyList,
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
    removeAllowlist(emptyList);
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

  // case 7e: a value the 1–4-digit parse accepts used to be stored VERBATIM and
  // answered by `[ "$VERIFY_TIMING_CEILING_S" -gt 0 ]`, and bash reads a leading zero
  // as OCTAL — `[ 008 -gt 0 ]` is a syntax error whose status is FAILURE. So `00`,
  // `000` and `0030` passed the parse, were refused by every `-gt 0` gate, and left the
  // ceiling OFF in silence: the junk case's outcome without the junk case's warning.
  // `$((10#…))` normalises the accepted value, so each spelling answers as the number
  // it names. One table, three halves: `0030` is ACCEPTED at its own 30 s bound (8 s,
  // green); `001` is ENFORCED at its own 1 s bound (8 s over it — the offender row an
  // un-normalised parse prints nothing for); `00` stays the documented off state.
  const padded: [string, number, number, string][] = [
    ["0030", 8000, 0, "accepted at its own 30s bound"],
    ["001", 8000, 1, "enforced at its own 1s bound"],
    ["00", 8000, 0, "the documented off state"],
  ];
  for (const [knob, ms, wantLines, why] of padded) {
    const r = runLoop([PASS, CEILING_OVER], {
      PI_ENSEMBLE_VERIFY_TIMING_CEILING_S: knob,
      FIXTURE_CEILING_MS: String(ms),
    });
    const lines = ceilingLines(r.stderr);
    assert(
      lines.length === wantLines && r.status === (wantLines === 0 ? 0 : 1),
      `case 7e: ${knob} is ${why} — ${wantLines} CEILING line(s) expected, got ${JSON.stringify(lines)} at status ${r.status}`,
    );
    if (knob === "00") {
      assert(
        !/PI_ENSEMBLE_VERIFY_TIMING_CEILING_S/.test(r.stderr),
        `case 7e: 00 is off in silence like 0 — no warning naming the value (stderr ${JSON.stringify(r.stderr.slice(0, 200))})`,
      );
    }
  }

  // --- AC2, off-path cost: with the knob unset the loop must read the allow-list
  // ZERO times. The parser forks `awk` on every read, so an implementation that
  // asked the list before consulting the knob cost ~2 forks per timing row —
  // ~3,154 forks, ~21 s, on a feature that was asked for nothing. The probe file
  // is appended to by the very statement that forks, so "empty file" is the
  // evidence that the off path never reached the list at all.
  const probeDir = mkdtempDirSync(path.join(tmpdir(), "pi-2449-offprobe-"));
  const probe = path.join(probeDir, "probe.log");
  const offProbe = runLoop([PASS, CEILING_OVER], {
    FIXTURE_CEILING_MS: "8000",
    TIMING_ALLOWLIST_PROBE: probe,
  });
  let probeBytes = 0;
  try {
    probeBytes = statSync(probe).size;
  } catch {
    probeBytes = 0; // absent file = not one byte written, which is the pass state
  }
  try {
    rmSync(probeDir, { recursive: true, force: true });
  } catch {
    /* a leftover scratch dir is reaped with TMPDIR */
  }
  assert(
    offProbe.status === 0 && probeBytes === 0,
    `case 7g: with the knob unset no allow-list read runs — the probe holds ${probeBytes} byte(s), exit ${offProbe.status} (the off path forks nothing: AC2 / R2)`,
  );

  // The same assertion observed RED, which is the only evidence that the green above
  // is a measurement and not a vacuity. `TIMING_ALLOWLIST_EAGER=1` forces the
  // ceiling's parse to a bound where the operator named none, so a run that asked for
  // nothing still walks the record and consults the list — the exact cost 7g exists to
  // stop. Two knobs must be named because the off path is a CHAIN of gates and eager
  // forces only the first: a slow passing file (so a row exists whose time is over the
  // forced bound, where the harness' own 60 s watchdog bound is not) and a temp list
  // (so the read has a real file to read; forcing the fork must never be able to
  // invent an exemption, and it cannot — the list still has to name the path).
  const canaryDir = mkdtempDirSync(path.join(tmpdir(), "pi-2449-eager-"));
  const canaryProbe = path.join(canaryDir, "probe.log");
  // Its OWN list, naming both fixtures. `writeAllowlist` — not the committed file —
  // because the harness pins `TIMING_ALLOWLIST` off, so a canary that left it alone
  // would fork nothing for the wrong reason (no list to read), not because the off
  // path is idle. Naming both rows keeps the run green at the forced 1 s bound, so the
  // only thing this assertion measures is whether the list was consulted. Its dir is
  // a second temp allocation and is removed in the same `finally` as the probe's.
  const canaryList = writeAllowlist([
    { file: "smoke-tests/fixtures/verify-loop/allpass-a.ts", seconds: 9 },
    { file: "smoke-tests/fixtures/verify-loop/fixture-ceiling-over.ts", seconds: 9 },
  ]);
  let eagerBytes = -1;
  let eager: { status: number; stdout: string; stderr: string };
  try {
    eager = runLoop([PASS, CEILING_OVER], {
      FIXTURE_CEILING_MS: "8000",
      TIMING_ALLOWLIST: canaryList,
      TIMING_ALLOWLIST_PROBE: canaryProbe,
      TIMING_ALLOWLIST_EAGER: "1",
    });
    try {
      eagerBytes = statSync(canaryProbe).size;
    } catch {
      eagerBytes = -1; // no probe file at all = the canary did not fire, which fails below
    }
  } finally {
    try {
      rmSync(canaryDir, { recursive: true, force: true });
    } catch {
      /* a leftover scratch dir is reaped with TMPDIR */
    }
    removeAllowlist(canaryList);
  }
  assert(
    eagerBytes > 0,
    `case 7g canary: an off path that DOES read the list is caught — with the ceiling forced where none was asked for, the probe holds ${eagerBytes} byte(s) (a green 7g without this line would be vacuous)`,
  );
  assert(
    eager.status === 0,
    `case 7g canary: forcing the read costs the run nothing — the forced-bound run is still green at ${eager.status} (a red here means the canary changed the verdict, not just the cost)`,
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
  // Modulo the timing lines the loop prints, the two off-path runs agree on both
  // channels. What a run legitimately varies between two invocations is its own
  // measured seconds (the ±50% swing the header pins), and TOTAL sums those, so it
  // belongs to the clock-derived set, not the verdict. See `isTimingLine`.
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

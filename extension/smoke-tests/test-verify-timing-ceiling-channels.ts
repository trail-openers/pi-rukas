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
 *   3. Case 12 — the exemption matcher answers about a KEY FIELD and nothing else: the
 *      cached rows are `secs<TAB>key`, so a needle has to sit between a tab and a
 *      newline. A single newline variable on both sides of the pattern was the empty
 *      string (command substitution strips trailing newlines), which made the whole-field
 *      test an unanchored substring test — enough for one character of any row to exempt
 *      a file no list ever named.
 *
 * Durations are a busy-wait at 4× the bound, for the ±50% host-load swing recorded in
 * the sibling file's header.
 */
import { spawnSync } from "node:child_process";
import {
  CEILING_OVER,
  FAIL,
  PASS,
  REPO,
  ceilingLines,
  GENERATED,
  LIB,
  mkdtempDirSync,
  removeAllowlist,
  removeGenerated,
  runLoop,
  stripTiming,
  writeAllowlist,
  writeGenerated,
  env,
} from "./lib/verify-loop-timing-harness.ts";
import { chmodSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // The one filter, as 7f uses it (it also drops `CEILING:`, the shape this run can
    // print). Case 5 of test-verify-loop-timing.ts is the sibling claim with no ceiling
    // in play. Two hand-written filters over one channel are two claims that can drift
    // apart; `stripTiming` is the single seam that says which lines belong to the clock.
    assert(
      stripTiming(ceiling.stderr) === off.stderr,
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

// ------------------------- Case 10: AC1's cost half — the list is read ONCE per run

{
  // "Read at most once per run, whatever the number of over-bound rows" is a count, and
  // a count is measured, not argued. `TIMING_ALLOWLIST_PROBE` names a file that gets
  // exactly one line per read of the list — one line per `awk` fork — so N over-bound
  // rows against a 1 s ceiling must still leave the file holding ONE line. This is the
  // assertion the cache exists to satisfy: the shape that preceded it forked `awk` twice
  // for every row past the bound, so a ten-row run read the list ten times.
  //
  // Three slow files, so the run has three offenders. The probe is handed to the loop
  // and read back by the case; nothing else writes it. The list names NO file, so every
  // row reaches it (an exempt row never asks the list a question and must not be
  // counted — see the probe's placement inside the loader).
  // Generated slow files, not the committed fixture: an exemption is keyed on a PATH,
  // and this run must exempt nothing so every row asks the list its question. Names from
  // `GENERATED.many` are the ones the harness already removes after every case.
  const rows = GENERATED.many.slice(0, 3).map((n) => writeGenerated(n, 8000));
  const probeDir = mkdtempDirSync(path.join(tmpdir(), "pi-2465-readcount-"));
  const probe = path.join(probeDir, "probe.log");
  const list = writeAllowlist([]);
  try {
    const r = runLoop(rows, {
      PI_ENSEMBLE_VERIFY_TIMING_CEILING_S: "2",
      FIXTURE_CEILING_MS: "8000",
      PI_ENSEMBLE_VERIFY_TEST_JOBS: "3",
      TIMING_ALLOWLIST: list,
      TIMING_ALLOWLIST_PROBE: probe,
    });
    const offenders = ceilingLines(r.stderr);
    // The run must actually have been over the bound three times: a run with no
    // offenders would prove the count vacuously, which is the failure mode this whole
    // suite treats as the worst answer.
    assert(
      offenders.length === 3 && r.status === 1,
      `case 10: three files sat over the ceiling and failed the run (${JSON.stringify(offenders)}, status ${r.status})`,
    );
    let reads = 0;
    try {
      reads = readFileSync(probe, "utf8").split("\n").filter((l) => l !== "").length;
    } catch {
      reads = -1;
    }
    assert(
      reads === 1,
      `case 10: AC1 — with the ceiling armed and ${offenders.length} over-bound rows, the allow-list was read ${reads} time(s); exactly ONE read per run is the claim the cache exists to hold (probe ${JSON.stringify(probe)})`,
    );
  } finally {
    removeAllowlist(list);
    for (const p of rows) removeGenerated(p);
    try {
      rmSync(probeDir, { recursive: true, force: true });
    } catch {
      /* a leftover scratch dir is reaped with TMPDIR */
    }
  }
}

// ------------------------- Case 11: AC2 — an armed run whose list cannot be read says so

{
  // The ceiling is fail-CLOSED: a list that is absent, unreadable, or parses to nothing
  // exempts nothing. That half was already pinned. What was NOT pinned is that it says
  // so — an operator who armed the ratchet against a wrong path read a run that failed
  // every slow file and printed nothing about the list, so the obvious next move was to
  // widen it. Each state below must print exactly ONE warning naming the path (one per
  // RUN, not per row: the loader returns before its gate), must still exempt nothing,
  // and must still fail the offender.
  const env = {
    PI_ENSEMBLE_VERIFY_TIMING_CEILING_S: "2",
    FIXTURE_CEILING_MS: "8000",
    PI_ENSEMBLE_VERIFY_TEST_JOBS: "2",
  };
  const missing = path.join(mkdtempDirSync(path.join(tmpdir(), "pi-2465-nolist-")), "nope.json");

  // An EMPTY list that exists, and an UNREADABLE one that exists — both built once and
  // shared by the three arms below, since each arm only varies which path the loop is
  // pointed at.
  const emptyList = writeAllowlist([]);
  const unreadableDir = mkdtempDirSync(path.join(tmpdir(), "pi-2465-unreadable-"));
  const unreadable = path.join(unreadableDir, "timing-allowlist.json");
  try {
    writeFileSync(unreadable, JSON.stringify({ entries: [{ file: "x.ts", seconds: 9 }] }));
    chmodSync(unreadable, 0o000);
  } catch {
    /* an unreadable fixture this host will not produce is skipped by the arm below */
  }

  const arms: [string, string][] = [
    ["absent", missing],
    ["unreadable", unreadable],
    ["empty", emptyList],
  ];
  try {
    for (const [state, list] of arms) {
      if (state === "unreadable" && !existsSync(unreadable)) continue;
      const r = runLoop([PASS, CEILING_OVER], { ...env, TIMING_ALLOWLIST: list });
      const warns = r.stderr
        .split("\n")
        .filter((l) => /^warn: verify-loop: timing ceiling is on but/.test(l));
      assert(
        warns.length === 1 && warns[0]!.includes(list),
        `case 11: an armed run whose list is ${state} prints ONE warning naming the path (got ${JSON.stringify(warns)})`,
      );
      assert(
        ceilingLines(r.stderr).length === 1 && r.status === 1,
        `case 11: a ${state} list exempts NOTHING — the verdict is unchanged, the offender still fails (status ${r.status})`,
      );
    }
    // The witness that this is not a vacuous green: a run whose list IS readable prints
    // no such warning at all, so the warning is about the list and not about the run.
    const good = writeAllowlist([
      { file: "smoke-tests/fixtures/verify-loop/fixture-ceiling-over.ts", seconds: 9 },
    ]);
    try {
      const r = runLoop([PASS, CEILING_OVER], { ...env, TIMING_ALLOWLIST: good });
      assert(
        !/timing ceiling is on but/.test(r.stderr),
        `case 11: canary — a readable list prints no list warning (stderr ${JSON.stringify(r.stderr.slice(0, 200))})`,
      );
    } finally {
      removeAllowlist(good);
    }
  } finally {
    removeAllowlist(emptyList);
    try {
      chmodSync(unreadable, 0o600);
    } catch {
      /* already gone */
    }
    try {
      rmSync(unreadableDir, { recursive: true, force: true });
    } catch {
      /* a leftover scratch dir is reaped with TMPDIR */
    }
  }
}

// ------------------------- Case 12: the allow-list match is anchored on the whole key

{
  // The exemption is the ONE thing that turns an over-bound row green, so the matcher
  // that grants it has to answer about a KEY FIELD and nothing else. The cached rows
  // are `secs<TAB>key` with one row per line, so the needle is legal only between a tab
  // and a newline — flanked by two DIFFERENT delimiters. When the pattern was built from
  // a single newline variable on both sides, and that variable was filled by
  // `nl="$(printf '\n')"`, command substitution stripped the trailing newline and the
  // variable was the EMPTY string: the whole-field test silently became an unanchored
  // substring test over the raw rows, so `s` (one character of any row), `23` (the
  // seconds of a row) and `smoke-tests/x/test-a.tsx` (a listed key plus one character)
  // all exempted a file no list ever named. That is not a strictness nicety — each of
  // them lets a file that never ran slow sit past the bound.
  //
  // Driven through the shipped source (`verify-timing.sh`, whose parse block sources the
  // ceiling half) exactly as test-verify-timing-allowlist.ts drives `timing_key` and
  // `_timing_allowlist_entries`, so the case judges the matcher the loop runs rather
  // than a copy of it here. The needle is a KEY, not a path: `timing_exempt` reduces
  // every spelling through `timing_key` first, and that normaliser is pinned by the
  // sibling gate. Its own temp list, because the ceiling is armed per spawn through the
  // environment and the shipped list is the shrink-only gate's subject.
  const list = writeAllowlist([
    { file: "smoke-tests/x/test-a.ts", seconds: 23 },
    { file: "smoke-tests/y/other.ts", seconds: 9 },
    { file: "smoke-tests/z/third.ts", seconds: 31 },
  ]);
  const listed = (needle: string): boolean => {
    // The cache is filled by the loader's ONE read; `timing_listed` then answers from
    // it, which is the shape of every call after the first in a real run. The ceiling
    // is forced to 1 s so the loader's own knob gate lets the read happen at all.
    const script =
      `. "${path.join(LIB, "verify-timing.sh")}" >/dev/null 2>&1; ` +
      `VERIFY_TIMING_CEILING_S=1; TIMING_ALLOWLIST=${JSON.stringify(list)}; ` +
      `_timing_allowlist_entries >/dev/null; timing_listed ${JSON.stringify(needle)}`;
    const r = spawnSync("bash", ["-c", script], { cwd: REPO, encoding: "utf8" });
    return (r.status ?? -1) === 0;
  };
  const KEPT = "smoke-tests/x/test-a.ts";
  const cases: [string, boolean][] = [
    // The entry itself, and every row of the three-row list — the middle and last rows
    // pin the anchoring at both ends: a pattern anchored only against the start of the
    // haystack would keep the first row and lose these two.
    [KEPT, true],
    ["smoke-tests/y/other.ts", true],
    ["smoke-tests/z/third.ts", true],
    // A SUFFIX of the key: matches nothing, because the tab before it is missing.
    ["test-a.ts", false],
    ["a.ts", false],
    ["x/test-a.ts", false],
    // A substring of the seconds column, and one character of a row — each matched the
    // row under an unanchored test, since rows are separated only by newlines.
    ["s", false],
    ["23", false],
    // A key that is a PREFIX of an entry must not exempt the longer path: the newline
    // after the needle is what refuses it. The empty-string delimiter above left this
    // half unanchored on BOTH sides, so it reddened only with the others — a mutant that
    // drops just the trailing newline is caught by this row alone.
    ["smoke-tests/x/test-a.tsx", false],
    // A path the list never names, spelled as an entry in the list would be.
    ["smoke-tests/fixtures/verify-loop/fixture-ceiling-over.ts", false],
  ];
  try {
    const verdicts = cases.map(([needle]) => listed(needle));
    cases.forEach(([needle, want], i) => {
      const got = verdicts[i] === true;
      assert(
        got === want,
        `case 12: ${want ? "IS" : "is NOT"} listed — ${JSON.stringify(needle)} over a list naming ${JSON.stringify(KEPT)} at 23 s (got ${got})`,
      );
    });
  } finally {
    removeAllowlist(list);
  }
}

// ------------------------- Case 13: a run whose ceiling half is missing cannot be green

{
  // The ceiling is split into its own half so the record's file stays under the size
  // cap, and a split is only safe while BOTH halves arrive. Nothing enforced that.
  // `verify-pool.sh` hard-checks the five RECORD names, but not the ceiling's own, and
  // `timing_ceiling_offenders` is the one name whose absence is silent: the loop calls
  // it in a `while … done < <(…)` and a missing function there yields no rows, so a
  // run with the knob ON, a file past the bound and no ceiling half printed no `CEILING:`
  // line, named no offender and EXITED 0. The ratchet off while every knob said it was
  // on — the one verdict a reader cannot tell apart from a run with nothing over the
  // bound, which is worse than a crash. The case below is the pre-fix behaviour measured
  // (status 0), and the fix: the source now checks the two ceiling names it depends on
  // and stops with 2 naming the file. Measured on a COPIED lib dir with the half deleted
  // — a real broken install, and the only shape where a missing file is the whole input.
  const mkCopy = (mutate: (ceil: string) => void): string => {
    const dir = mkdtempDirSync(path.join(tmpdir(), "pi-2465-half-"));
    cpSync(LIB, path.join(dir, "lib"), { recursive: true });
    mutate(path.join(dir, "lib", "verify-timing-ceiling.sh"));
    return dir;
  };
  const runCopied = (dir: string) =>
    spawnSync("bash", [path.join(dir, "lib", "verify-loop.sh"), CEILING_OVER], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 240_000,
      env: env({
        // The armed run this is about: the knob on, and the file over the bound, so a
        // silent ratchet is a run that SHOULD have failed and did not.
        PI_ENSEMBLE_VERIFY_TIMING_CEILING_S: "2",
        FIXTURE_CEILING_MS: "8000",
        PI_ENSEMBLE_VERIFY_TEST_JOBS: "1",
      }),
    });
  const broken = [
    ["deleted", (ceil: string) => rmSync(ceil)] as [string, (ceil: string) => void],
    // The twin that a file-exists check would sail past: the half is THERE, it just
    // defines nothing (a truncated copy, a botched merge), so the check has to be about
    // the names, not the path.
    ["emptied", (ceil: string) => writeFileSync(ceil, "# defines nothing\n")] as [
      string,
      (ceil: string) => void,
    ],
  ];
  for (const [state, mutate] of broken) {
    const dir = mkCopy(mutate);
    try {
      const r = runCopied(dir);
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      assert(
        r.status === 2 && out.includes("verify-timing-ceiling.sh") && /did not define/.test(out),
        `case 13: a copied lib whose ceiling half is ${state} stops the run with 2 and names the file (status ${r.status}, stderr ${JSON.stringify((r.stderr ?? "").slice(0, 140))})`,
      );
      // The pre-fix shape this closes: with the half missing the loop produced NO
      // verdict channel at all — no `CEILING:` line and no `FAILED:` marker — so the run
      // was green on a file sitting past its bound. Asserting the absence here pins that
      // the stop is what saved the verdict, not that the fixture happened to be fast.
      assert(
        !/CEILING:/.test(out) && !/FAILED:/.test(out),
        `case 13: the broken install produced no verdict at all — no CEILING line, no FAILED marker (status ${r.status})`,
      );
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a leftover scratch dir is reaped with TMPDIR */
      }
    }
  }

  // The witness that this is not a broken copy script: the SAME copy, with the half
  // intact, runs the real armed loop and fails it on the clock. Without this the two
  // reds above would be consistent with a copy that never runs at all — the vacuous
  // green this suite treats as the worst answer.
  const intact = mkCopy(() => {});
  try {
    const r = runCopied(intact);
    assert(
      r.status === 1 && ceilingLines(r.stderr).length === 1,
      `case 13 canary: the same copied lib WITH its ceiling half armed the ratchet and failed the run (status ${r.status}, ceiling lines ${JSON.stringify(ceilingLines(r.stderr))})`,
    );
  } finally {
    try {
      rmSync(intact, { recursive: true, force: true });
    } catch {
      /* a leftover scratch dir is reaped with TMPDIR */
    }
  }
}

process.exit(exit);

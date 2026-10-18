#!/usr/bin/env bun
/**
 * Issue #1538 (follow-up) — verify-loop: `--jobs-from-host`.
 *
 * `.pi/verify-cmd` used to size the pool inline with
 * `PI_ENSEMBLE_VERIFY_TEST_JOBS="${…:-$(getconf …)}"`. That prefix is not a form
 * the review-accept guard (#1125) admits: its A5 arm (`armVerifyLoop`) accepts
 * `bash …/verify-loop.sh` only when EVERY word after the script is `--digest` or
 * a test path, and `test-review-accept-guard-hardened.ts` requires each arm of
 * `.pi/verify-cmd` to pass that arm — an expansion-word is neither. So the
 * sizing lives inside the script, behind an opt-in flag the arm does accept.
 *
 * Cases:
 *   1. `--jobs-from-host` with the variable UNSET → the host decides: 4 when
 *      `getconf _NPROCESSORS_ONLN` reports 8 or more, 2 below that. `getconf`
 *      is stubbed through PATH rather than measured, so the case pins the
 *      branch rather than the machine it happens to run on. A host where the
 *      lookup fails sizes DOWN to 2, never up.
 *   2. An explicit PI_ENSEMBLE_VERIFY_TEST_JOBS wins over the host — with the
 *      flag passed and a 12-CPU stub, the operator's 1 is what runs.
 *   3. No flag → the shipped default of 2 regardless of the host, which is the
 *      CI shape (.github/workflows/ci.yml passes no flag).
 *   4. The flag is not mistaken for a test path in any position, and a flag
 *      with no files is still a usage error rather than a vacuous pass.
 *
 * Observation seam: run_pool's `max_jobs` is the pool's admission ceiling, so
 * the width is PROVEN behaviourally — each case runs N copies of a fixture that
 * records its own start/finish window, and the peak overlap of those windows IS
 * the admitted width. A wall-clock bound would pass on a fast host that
 * serialised and fail on a loaded one that did not. The fixtures all pass, so
 * every case exits 0 and the assertion is about the schedule, not the verdict.
 *
 * The child env never carries PI_ENSEMBLE_VERIFY_TEST_JOBS unless a case names
 * it — an operator's ambient value would silently satisfy case 3's expectation.
 * Every spawn in this file, including case 4's, builds that env through
 * `childEnv` (which `runSet` uses), so no case inherits a value the others dropped.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const LOOP = path.join(HERE, "lib", "verify-loop.sh");
// Relative to CWD (the extension dir) — the same shape every real caller uses.
const FIXTURE = path.join("smoke-tests", "fixtures", "verify-loop", "fixture-window.ts");
const CWD = path.join(HERE, "..");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * A `getconf` that prints `cpus` for `_NPROCESSORS_ONLN`, placed ahead of the
 * real one on PATH. `cpus === null` is the "no working getconf" host — a
 * non-zero exit, which is what a system without that confstr name produces.
 *
 * The temp dir is tracked so the `try/finally` at the bottom of the file removes
 * every stub and record dir this run created.
 */
function stubGetconf(cpus: string | null): string {
  const dir = trackedDir("verify-getconf-");
  const body =
    cpus === null
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\nif [ "$1" = "_NPROCESSORS_ONLN" ]; then echo ${cpus}; exit 0; fi\nexit 1\n`;
  const bin = path.join(dir, "getconf");
  writeFileSync(bin, body, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return dir;
}

/** Windows recorded in `dir` — one `.tsv` per job that actually ran. */
function countRecords(dir: string): number {
  return readdirSync(dir).filter((f) => f.endsWith(".tsv")).length;
}

/**
 * The child env every spawn in this file builds through.
 *
 * The env is BUILT by filtering, not spread-and-mutated: `PI_ENSEMBLE_VERIFY_TEST_JOBS`
 * is DELIBERATELY ABSENT from the base, because an operator's ambient value —
 * set, empty, or junk — would otherwise reach the child and satisfy case 3's
 * "no flag → still 2" expectation without the flag doing anything. (Assigning
 * `undefined` over a spread would leave the key present with an undefined value,
 * which the filter below is what actually removes; a `delete` would too, but the
 * linter's noDelete rule is right that filtering is the shape here.) The other
 * keys are named rather than spread wholesale so the whole child env is visible
 * in one literal.
 *
 * `jobs === undefined` means "do not name it at all" — the host decides.
 */
function childEnv(
  bin: string,
  recordDir: string,
  windowMs: string,
  jobs?: string,
): Record<string, string> {
  const { PI_ENSEMBLE_VERIFY_TEST_JOBS: _ambient, ...rest } = process.env as Record<
    string,
    string | undefined
  >;
  const base: Record<string, string | undefined> = {
    ...rest,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    FIXTURE_WINDOW_MS: windowMs,
    FIXTURE_WINDOW_DIR: recordDir,
    PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S: "30",
    PI_ENSEMBLE_VERIFY_TEST_JOBS: jobs,
  };
  return Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined)) as Record<
    string,
    string
  >;
}

/**
 * Run `n` copies of the timing fixture and report the peak number of them that
 * were alive at the same instant.
 *
 * Each job writes its own record under `recordDir` (keyed by a per-slot token)
 * because the jobs run concurrently and `open(w)` truncates at open — one
 * shared log path would leave a single record however wide the pool ran, which
 * reads exactly like "the pool never parallelised".
 */
function runSet(
  n: number,
  recordDir: string,
  opts: { flag: boolean; jobs?: string; cpus: string | null },
): { status: number; overlap: number; records: number; width: string; stderr: string } {
  const bin = stubGetconf(opts.cpus);
  const env = childEnv(bin, recordDir, "400", opts.jobs);
  const argv = opts.flag ? ["--jobs-from-host"] : [];
  const files: string[] = Array.from({ length: n }, () => FIXTURE);
  const r = spawnSync("bash", [LOOP, ...argv, ...files], {
    cwd: CWD,
    encoding: "utf-8",
    env,
  });
  // The pool's ADMISSION CEILING, observed directly: `host_job_count` traces the
  // width it chose to stderr, so that number is present exactly when the host was
  // consulted — the thing the small-host and no-getconf cases need to pin. The
  // clamp warning is the second, independent observation: it prints the number
  // BEFORE it was clamped to the collection size, so it names a wide pool the
  // overlap sweep cannot see once n <= width, and a host-derived 2 that got
  // clamped is still the host's 2. Overlap alone is a LOWER bound (three copies
  // at width 4 peak at 3), so the exact-width cases pair the two: overlap proves
  // at least that many were alive; the ceiling proves the pool was never allowed
  // more. Neither line prints when the width came from a default or an ambient
  // setting — the no-flag case pins the absence, which is the host never having
  // been consulted at all.
  const clampNote = /PI_ENSEMBLE_VERIFY_TEST_JOBS=([0-9]+) clamped/.exec(r.stderr ?? "");
  const hostNote = /host_job_count: ([0-9]+)/.exec(r.stderr ?? "");
  // "default" is the ceiling the shipped value gives when the host was never
  // asked — a literal, not a number scraped from somewhere, because that is the
  // width run_pool receives in that branch (VERIFY_TEST_JOBS=2 from the parse).
  const width = hostNote ? hostNote[1] : clampNote ? "2" : "default";
  const windows: Array<[number, number]> = [];
  for (const f of readdirSync(recordDir)) {
    if (!f.endsWith(".tsv")) continue;
    const parts = readFileSync(path.join(recordDir, f), "utf-8").trim().split("\t").map(Number);
    if (parts.length === 2 && parts.every((x) => Number.isFinite(x))) {
      windows.push([parts[0], parts[1]]);
    }
  }
  // Sweep: +1 on each start, -1 on each finish; the running max is the peak
  // concurrency the pool admitted. At an identical instant a finish is ordered
  // before a start, so back-to-back jobs are not read as an overlap.
  const events: Array<[number, number]> = [];
  for (const [start, end] of windows) events.push([start, 1], [end, -1]);
  events.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  let cur = 0;
  let peak = 0;
  for (const [, delta] of events) {
    cur += delta;
    if (cur > peak) peak = cur;
  }
  return {
    status: r.status ?? -1,
    overlap: peak,
    records: windows.length,
    // The ceiling the pool admitted: the host's own number when the host was
    // consulted, the shipped 2 when it was not. Empty only if neither spoke.
    width,
    stderr: `${r.stderr}[host width ${width}]\n`,
  };
}

function freshRecordDir(): string {
  return trackedDir("verify-jobs-records-");
}

// The fixture sleeps ~400ms, so 4 concurrent copies finish in well under the
// ~1.6s a serial run takes. Peak overlap is the assertion.
const N_WIDE = 4;
const N_NARROW = 3;

// Every temp dir this file creates (getconf stubs and record dirs), removed in
// the `finally` at the bottom so neither a passing nor a failing run leaves
// anything under TMPDIR.
const TMP_DIRS: string[] = [];
function trackedDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}

// The cases run inside `try` so the `finally` below still cleans up when a case
// throws (a fixture that vanished, an unreadable record dir) rather than only
// on the green path.
try {
  // --- Case 1: the flag sizes the pool from the host.
  {
    const wide = runSet(N_WIDE, freshRecordDir(), { flag: true, cpus: "12" });
    assert(
      wide.status === 0,
      `case 1: the 12-CPU run exits 0 (got ${wide.status}; ${wide.stderr})`,
    );
    assert(
      wide.records === N_WIDE,
      `case 1: every job recorded a timing window (got ${wide.records} of ${N_WIDE})`,
    );
    assert(
      wide.overlap >= 4,
      `case 1: --jobs-from-host on an 8+ CPU host runs 4 jobs at once (peak overlap ${wide.overlap})`,
    );
    assert(
      wide.width === "4",
      `case 1: the 12-CPU host sizes the pool to 4 (host_job_count traced ${wide.width})`,
    );

    // Same flag, small host: the pool stays at 2, so three 400ms copies cannot
    // all be in flight.
    const narrow = runSet(N_NARROW, freshRecordDir(), { flag: true, cpus: "4" });
    assert(narrow.status === 0, `case 1: the 4-CPU run exits 0 (got ${narrow.status})`);
    assert(
      narrow.records === N_NARROW,
      `case 1: the small-host run recorded every window (got ${narrow.records} of ${N_NARROW})`,
    );
    assert(
      narrow.overlap === 2,
      `case 1: --jobs-from-host under 8 CPUs keeps the pool at 2 (peak overlap ${narrow.overlap}, want 2)`,
    );
    assert(
      narrow.width === "2",
      `case 1: the 4-CPU host is sized to 2 (host_job_count traced ${narrow.width})`,
    );

    // getconf missing/unparseable: sizes DOWN to 2, never up.
    const noconf = runSet(N_NARROW, freshRecordDir(), { flag: true, cpus: null });
    assert(noconf.status === 0, `case 1: the no-getconf run exits 0 (got ${noconf.status})`);
    assert(
      noconf.records === N_NARROW,
      `case 1: the no-getconf run recorded every window (got ${noconf.records} of ${N_NARROW})`,
    );
    assert(
      noconf.overlap === 2,
      `case 1: an unreadable CPU count sizes the pool DOWN to 2 (peak overlap ${noconf.overlap}, want 2)`,
    );
    assert(
      noconf.width === "2",
      `case 1: the no-getconf host is sized to 2, not up (host_job_count traced ${noconf.width})`,
    );
    assert(
      noconf.stderr.includes("could not read CPU count; pool at 2"),
      `case 1: an unreadable CPU count says so on stderr rather than sizing silently (stderr ${JSON.stringify(noconf.stderr.slice(0, 200))})`,
    );

    // Canary that the observation seam can fail: three copies at JOBS=1 must
    // never overlap. Without this, "overlap <= 2" in the narrow cases above is
    // satisfied by a pool that serialised everything.
    const serial = runSet(N_NARROW, freshRecordDir(), { flag: true, jobs: "1", cpus: "12" });
    assert(
      serial.records === N_NARROW && serial.overlap === 1,
      `case 1 canary: at JOBS=1 the windows never overlap — the seam detects serialisation (records ${serial.records}, peak ${serial.overlap})`,
    );
  }

  // --- Case 2: an explicit ambient value beats the host.
  {
    const explicit = runSet(N_NARROW, freshRecordDir(), { flag: true, jobs: "1", cpus: "12" });
    assert(explicit.status === 0, `case 2: the explicit-JOBS run exits 0 (got ${explicit.status})`);
    assert(
      explicit.records === N_NARROW,
      `case 2: every job recorded a window (got ${explicit.records} of ${N_NARROW})`,
    );
    assert(
      explicit.overlap === 1,
      `case 2: PI_ENSEMBLE_VERIFY_TEST_JOBS=1 wins over the flag and the 12-CPU host (peak overlap ${explicit.overlap}, want 1)`,
    );
    // And a wider explicit value is honoured too — not overridden to 4 by a host
    // that would have said 4.
    const three = runSet(N_NARROW, freshRecordDir(), { flag: true, jobs: "3", cpus: "4" });
    assert(
      three.overlap >= 3,
      `case 2: an explicit 3 wins over a 4-CPU host that would size to 2 (peak overlap ${three.overlap})`,
    );
  }

  // --- Case 3: without the flag the shipped default holds on the same big host.
  {
    const plain = runSet(N_NARROW, freshRecordDir(), { flag: false, cpus: "12" });
    assert(plain.status === 0, `case 3: the no-flag run exits 0 (got ${plain.status})`);
    assert(
      plain.records === N_NARROW,
      `case 3: every job recorded a window (got ${plain.records} of ${N_NARROW})`,
    );
    assert(
      plain.overlap === 2,
      `case 3: no flag keeps the pool at the shipped 2 on a 12-CPU host — the CI shape (peak overlap ${plain.overlap}, want 2)`,
    );
    // The ceiling, not just the achieved overlap: the host must never have been
    // consulted at all (no `host_job_count` trace, no clamp naming a host number)
    // and the pool must have run at the shipped default. The three-copy set is
    // one short of the host-derived 4, so the overlap alone would read the same
    // for a pool sized 3 or 4.
    assert(
      plain.width === "default",
      `case 3: with no flag the pool stays at the shipped default and the host is not consulted (got ${plain.width})`,
    );
    // THE canary that separates case 1 from case 3: same host, same fixture set,
    // one word of argv apart. If the flag changed nothing the two would be
    // indistinguishable and every exact-width assertion above would be satisfied by a
    // suite that never parallelises at all.
    const flagged = runSet(N_NARROW, freshRecordDir(), { flag: true, cpus: "12" });
    assert(
      plain.overlap < flagged.overlap,
      `case 3 canary: on the SAME 12-CPU host the flag alone moves the width — no-flag ${plain.overlap}-wide vs flagged ${flagged.overlap}-wide (${flagged.stderr.trim()})`,
    );
    // Four copies would need the host-derived width to show 4-wide; at the
    // default they cannot all be in flight.
    const plain4 = runSet(N_WIDE, freshRecordDir(), { flag: false, cpus: "12" });
    assert(
      plain4.overlap === 2,
      `case 3: four copies with no flag still run exactly 2-wide (peak overlap ${plain4.overlap}, want 2)`,
    );
  }

  // --- Case 4: the flag is never mistaken for a test path, in either position.
  {
    const bin = stubGetconf("12");
    // Trailing flag: the shape a caller who appends flags would produce. The
    // record dir below belongs to THIS run alone — counting another run's records
    // would pass on a stale window left by an earlier case.
    const trailingDir = freshRecordDir();
    const r = spawnSync("bash", [LOOP, FIXTURE, "--jobs-from-host"], {
      cwd: CWD,
      encoding: "utf-8",
      env: childEnv(bin, trailingDir, "50"),
    });
    // An argument that leaked into the pool would be collected as a test file and
    // fail (no such file), so exit 0 plus a single recorded window is the proof.
    assert(
      r.status === 0 && countRecords(trailingDir) === 1,
      `case 4: a trailing --jobs-from-host is not run as a test (exit ${r.status}, records ${countRecords(trailingDir)})`,
    );
    assert(
      !`${r.stdout}${r.stderr}`.includes("Cannot find module"),
      "case 4: the flag never reaches the module loader as a test path",
    );

    // A flag-only invocation is still a usage error, not a vacuous pass.
    const bare = spawnSync("bash", [LOOP, "--jobs-from-host"], {
      cwd: CWD,
      encoding: "utf-8",
      env: childEnv(bin, freshRecordDir(), "50"),
    });
    assert(
      bare.status === 2 && `${bare.stderr}`.includes("usage:"),
      `case 4: a flag with no files is a usage error (exit ${bare.status})`,
    );

    // An unrecognised dash-leading word is a usage error too, and is NOT collected
    // as a test path — the pool would otherwise report "no such file" for a typo.
    const unknown = spawnSync("bash", [LOOP, "--jobs-from-hst", FIXTURE], {
      cwd: CWD,
      encoding: "utf-8",
      env: childEnv(bin, freshRecordDir(), "50"),
    });
    assert(
      unknown.status === 2 &&
        `${unknown.stderr}`.includes("usage:") &&
        `${unknown.stderr}`.includes("--jobs-from-hst"),
      `case 4: an unknown --flag is the usage error, not a collected test path (exit ${unknown.status}, stderr ${JSON.stringify(unknown.stderr.trim())})`,
    );

    // Combined with --digest in the pinned leading position.
    const digested = spawnSync("bash", [LOOP, "--digest", "--jobs-from-host", FIXTURE], {
      cwd: CWD,
      encoding: "utf-8",
      env: childEnv(bin, freshRecordDir(), "50"),
    });
    assert(
      digested.status === 0 && digested.stdout.trim() === "P: 1  F: 0",
      `case 4: --digest and --jobs-from-host combine (exit ${digested.status}, stdout ${JSON.stringify(digested.stdout.trim())})`,
    );
  }
} finally {
  for (const dir of TMP_DIRS) rmSync(dir, { recursive: true, force: true });
}

process.exit(exit);

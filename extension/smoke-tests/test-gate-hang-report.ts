/**
 * Offline smoke: a gate killed at its bound reports WHAT hung.
 *
 * #1427. The wall-clock bound and the group kill already existed (#1324); what
 * the nessie #1054 measurement showed missing was the content — a `cargo test`
 * gate hung 75 minutes and the cycle reported only `slow`, so the operator had
 * nothing to act on. This drives the reporter through the three shapes the gate
 * seams actually hand it:
 *
 *   1. a run whose stream carries the runner's own slow-test lines and whose
 *      tree walks cleanly — the report names the test AND the processes;
 *   2. a run that printed nothing recognisable and has no descendants — the
 *      report says both, rather than rendering two empty sections that read
 *      like verdicts;
 *   3. a run the executor never gave a pid for (the test fakes, the fast tier's
 *      rethrow) — the report declines to walk anything.
 *
 * Plus the seams that consume it: the failure-string clause stays inside the
 * evidence window the cap renderer keeps, and the written log lands where the
 * cap event's `logPaths` will point.
 *
 * Run:
 *   cd extension && bun run smoke-tests/test-gate-hang-report.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boundJoinFailures } from "../src/work-develop-cap-evidence.ts";
import { extractAttributedTail } from "../src/work-driver-exec-error.ts";
import {
  GATE_HANG_LABEL,
  type HangProcess,
  MAX_ARGS_CHARS,
  MAX_SNAPSHOT_CHARS,
  extractRunningTests,
  gateHangClause,
  isGateHangFailure,
  lastOutputLines,
  recordGateHangLogPath,
  reportGateHang,
  walkProcessTree,
} from "../src/work-driver-gate-hang.ts";
import {
  timeoutWhere,
  verifyHangFailure,
  verifyTimeoutFailure,
} from "../src/work-driver-verify-develop-helpers.ts";
import { writeGateHangLog } from "../src/work-driver-verify-flake.ts";

let failures = 0;
function expect(cond: boolean, label: string) {
  if (cond) {
    console.log(`✓ ${label}`);
  } else {
    console.error(`✗ ${label}`);
    failures += 1;
  }
}

const CARGO_STREAM = [
  "   Compiling nessie v0.1.0 (/work/nessie)",
  "    Finished test [unoptimized] target(s) in 4.2s",
  "     Running unittests src/lib.rs (target/debug/deps/nessie-1a2b)",
  "",
  "running 212 tests",
  "test git::fetch::tests::pulls_a_branch ... ok",
  "test git::fetch::tests::pulls_another ... ok",
  "test repo::sync::tests::pull_then_fetch has been running for over 60 seconds",
  "test repo::sync::tests::pull_then_fetch has been running for over 60 seconds",
  "test store::tests::roundtrip ... ok",
].join("\n");

const tree = (rows: HangProcess[]) => ({ processes: rows });
const STUCK: HangProcess[] = [
  { pid: 4001, ppid: 3500, etime: "01:15:02", args: "target/debug/deps/nessie-1a2b --format json" },
  { pid: 4002, ppid: 4001, etime: "01:14:58", args: "git pull --ff-only origin main" },
  {
    pid: 4003,
    ppid: 4002,
    etime: "01:14:57",
    args: "git remote-https origin https://github.com/x/y",
  },
];

function base(over: Partial<Parameters<typeof reportGateHang>[0]> = {}) {
  return {
    cmd: "cargo test",
    cwd: "/work/nessie",
    timeoutMs: 30 * 60_000,
    // A tree is only consulted when the executor named the pid it killed: the
    // tests below pass one where they expect a walk, and omit it (case 3)
    // where they expect the report to decline.
    leaderPid: 3500,
    ...over,
  };
}

function main() {
  // ── Extraction: the runner's own words, not ours ──────────────────────
  {
    const names = extractRunningTests(CARGO_STREAM);
    expect(
      names.length === 1 && names[0] === "repo::sync::tests::pull_then_fetch",
      `extract: the libtest slow-line names the stuck test (${names.join(",")})`,
    );
    expect(
      extractRunningTests("test slow_thing ... ok (91.4s)\n").length === 0,
      "extract: a test that merely took a long time is not called a hang",
    );
    expect(
      extractRunningTests(
        "ok 1 a\nnot ok 2 - long\ntest something running for 12 seconds\ntest go::pkg running for 3 seconds\n",
      ).length === 2,
      "extract: both the `running for N seconds` and the `has been` wording match",
    );
    expect(extractRunningTests("").length === 0, "extract: an empty stream yields no names");
    const many = extractRunningTests(
      Array.from({ length: 40 }, (_, i) => `test t${i} has been running for over 60 seconds`).join(
        "\n",
      ),
    );
    expect(
      many.length === 10,
      `extract: the list is bounded so the evidence window survives (${many.length})`,
    );
  }

  // ── The tail: what it said before it stopped saying anything ──────────
  {
    const tail = lastOutputLines("a\nb\nrunning 212 tests\ntest x ... ", 3);
    expect(tail.includes("running 212 tests"), "tail: the last complete line is kept");
    expect(lastOutputLines("", 3) === "", "tail: nothing printed, nothing shown");
  }

  // ── Case 1: names + tree — the report an operator can act on ─────────
  {
    const report = reportGateHang(base({ output: CARGO_STREAM }), {
      walk: () => tree(STUCK),
    });
    expect(report.startsWith(GATE_HANG_LABEL), "report: carries the operator-facing label");
    expect(
      report.includes("repo::sync::tests::pull_then_fetch"),
      "report: names the test the runner flagged",
    );
    expect(report.includes("git remote-https"), "report: names the orphaned grandchild");
    expect(report.includes("01:15:02"), "report: shows how long it has been sitting there");
    expect(report.includes("30m"), "report: states the bound it hit");
    expect(report.includes("cargo test"), "report: names the gate's own command");
    expect(report.includes("/work/nessie"), "report: names where it ran");
  }

  // ── Case 2: nothing recognisable — says so, twice, rather than going blank
  {
    const report = reportGateHang(base({ output: "" }), {
      walk: () => ({ processes: [], treeUnavailable: "ps exited 1 without output" }),
    });
    expect(
      report.includes("no named test") || report.includes("printed no test-runner"),
      "report: an unrecognisable stream is reported as such, not as an empty list",
    );
    expect(
      report.includes("ps exited 1 without output"),
      "report: the reason no tree could be captured is the reason the operator reads",
    );
  }

  // ── Case 3: no pid from the executor — no walk, no claim ──────────────
  {
    const walked: number[] = [];
    const report = reportGateHang(base({ output: CARGO_STREAM, leaderPid: undefined }), {
      walk: (pid) => {
        walked.push(pid);
        return tree(STUCK);
      },
    });
    expect(walked.length === 0, "report: with no leader pid nothing is walked");
    expect(
      report.includes("no gate pid"),
      `report: and the report says why (${report.match(/unavailable \([^)]*\)/)?.[0]})`,
    );
  }

  // ── The headline fits the window the cap renderer keeps ───────────────
  {
    const clause = gateHangClause({
      runningTests: ["a::b", "c::d"],
      cmd: "cargo test",
      cwd: "/w",
      timeoutMs: 1000,
      processes: STUCK,
    });
    expect(
      clause.length < 200,
      `clause: bounded to survive the 800-char evidence tail (${clause.length})`,
    );
    expect(clause.includes("a::b"), "clause: leads with the test name");
    expect(clause.includes("3 process(es)"), "clause: counts the processes the kill left alive");
    expect(isGateHangFailure(clause), "clause: recognizable as a hang report");
    expect(!isGateHangFailure("verify command failed"), "clause: an ordinary failure is not one");
  }

  // ── The failure string still leads with the bound ────────────────────
  {
    const msg = verifyHangFailure("cargo test", "in /work/nessie/.worktrees/issue-1", 1_800_000, {
      output: CARGO_STREAM,
      cmd: "cargo test",
      cwd: "/work/nessie",
      timeoutMs: 1_800_000,
      tree: tree(STUCK),
    });
    expect(msg.includes("exceeded its 30-min timeout"), "failure: the bound still leads");
    expect(
      msg.includes("repo::sync::tests::pull_then_fetch") && msg.includes("git remote-https"),
      "failure: and the hang is named in the same string",
    );
    expect(
      !timeoutWhere("in /x").includes("gate-hang"),
      "failure: a run with nothing to say adds nothing to the sentence",
    );
    expect(
      verifyHangFailure("cargo test", "in /x", 1000) ===
        verifyTimeoutFailure("cargo test", "in /x", 1000),
      "failure: no run to describe is exactly the #1324 sentence",
    );
  }

  // ── Fix 1 (round 3): names are bounded, and the marker survives ───────
  //
  // The case the nessie measurement never produced and a fan-out does: ten
  // generated-proptest-sized names in one killed run. Two separate defects hid
  // here. (a) Each name went into the clause verbatim, so the clause grew past
  // the evidence window; (b) the clause was spliced into the MIDDLE of the
  // timeout sentence, and `boundFailure` bounds a failure by keeping its TAIL —
  // so a wide clause pushed `[verify-timeout]` past the 800-char cut and the
  // cap router read a killed run as an ordinary code failure. Both are asserted
  // here, and the second is asserted through the real bounder.
  {
    const longName = (i: number) =>
      `generated::proptest::case_${i}::${"very_long_segment_".repeat(20)}${i}`;
    const tenLongStream = [
      "running 400 tests",
      ...Array.from(
        { length: 10 },
        (_, i) => `test ${longName(i)} has been running for over 60 seconds`,
      ),
    ].join("\n");

    const names = extractRunningTests(tenLongStream);
    expect(names.length === 10, `bound: all ten names are kept (${names.length})`);
    expect(
      names.every((n) => n.length <= 120),
      `bound: every name is clipped to 120 chars (longest ${Math.max(...names.map((n) => n.length))})`,
    );
    expect(
      names.every((n) => n.endsWith("\u2026")),
      "bound: a clipped name says it was clipped",
    );
    expect(
      extractRunningTests(`test ${longName(0)} has been running for over 60 seconds`)[0] ===
        names[0],
      "bound: the report and the clause clip the name identically",
    );

    const msg = verifyHangFailure("cargo test", "in /wt/a", 1_800_000, {
      output: tenLongStream,
      cmd: "cargo test",
      cwd: "/wt/a",
      timeoutMs: 1_800_000,
    });
    expect(
      msg.length < 800,
      `bound: one killed run's failure string fits the evidence window (${msg.length})`,
    );

    // The whole-cycle shape: three worktrees, three such failures, joined the
    // way the cap renders them. `extractAttributedTail` keeps the TAIL of each
    // failure, so this is where a mid-sentence clause used to lose the marker.
    const fanout = ["a", "b", "c"].map((w) =>
      verifyHangFailure("cargo test", `in /wt/${w}`, 1_800_000, {
        output: tenLongStream,
        cmd: "cargo test",
        cwd: `/wt/${w}`,
        timeoutMs: 1_800_000,
      }),
    );
    const bounded = boundJoinFailures(fanout);
    const perFailure = fanout.map((f) => extractAttributedTail(f, 800).tail);
    expect(
      perFailure.every((t) => t.includes("[verify-timeout]")),
      "fan-out: [verify-timeout] survives the per-failure tail bound in every failure",
    );
    expect(
      bounded.includes("[verify-timeout]"),
      "fan-out: [verify-timeout] survives the joined-evidence bound too",
    );
    expect(
      perFailure.every((t) => t.includes(GATE_HANG_LABEL)),
      "fan-out: and the hang clause itself is still there to read",
    );
  }

  // ── The walk is bounded, and degrades per level ───────────────────────
  {
    const wide = walkProcessTree(1, () => ({
      rows: Array.from({ length: 200 }, (_, i) => ({
        pid: 1000 + i,
        ppid: 1,
        etime: "1",
        args: `child ${i}`,
      })),
    }));
    expect(
      wide.processes.length <= 60,
      `walk: a fork bomb cannot make the reporter the problem (${wide.processes.length})`,
    );

    const deepFailure = walkProcessTree(1, (pid) =>
      pid === 1
        ? { rows: [{ pid: 2, ppid: 1, etime: "1", args: "one" }] }
        : { rows: [], error: "boom" },
    );
    expect(
      deepFailure.processes.length === 1 && deepFailure.treeUnavailable === undefined,
      "walk: a failure deeper in does not discard the levels already walked",
    );

    const cycles = walkProcessTree(1, (pid) => ({
      rows: [{ pid: pid === 1 ? 2 : 1, ppid: pid, etime: "1", args: "loop" }],
    }));
    expect(
      cycles.processes.length < 10,
      `walk: a pid cycle terminates (${cycles.processes.length} rows)`,
    );
  }

  // ── Fix 5 (round 3): the walk has a WALL-CLOCK budget, not just a row cap ─
  //
  // `MAX_PROCESSES` bounds how many rows the walk returns; it says nothing
  // about how long it takes. Each level is a separate synchronous `ps`, and a
  // host whose `ps` is slow (a loaded machine, a fork-exhausted container — the
  // same conditions that made the gate hang in the first place) turns the
  // failure path into the slowest thing in the cycle: up to 60 levels at up to
  // 3 s each is three minutes spent describing a run that already ran out of
  // time. The walk is a diagnosis; it must not become the second problem, so it
  // now stops at an aggregate budget and says that is what happened.
  {
    // A walker that returns one row per level forever, each level costing a
    // slice of the budget. With no time bound the walk would run the full
    // `MAX_PROCESSES` (60) levels.
    const slow = (ms: number) => (pid: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        /* spin: stand-in for a `ps` that takes ms to answer */
      }
      return { rows: [{ pid: pid + 1, ppid: pid, etime: "1", args: `child ${pid}` }] };
    };
    // A linear chain walks one level per `ps`, so with a fast `ps` the binding
    // limit is the row cap. 60 is that cap (`MAX_PROCESSES`) — the assertion is
    // that the time budget does NOT pre-empt it when `ps` answers instantly.
    const cheap = walkProcessTree(1, slow(0));
    expect(
      cheap.processes.length === 60,
      `budget: with a fast ps the row cap is still the binding limit (${cheap.processes.length})`,
    );
    const budgeted = walkProcessTree(1, slow(120), { budgetMs: 400 });
    expect(
      budgeted.processes.length > 0 && budgeted.processes.length < 25,
      `budget: a slow ps stops at the wall clock, not at the row cap (${budgeted.processes.length} rows)`,
    );
    expect(
      budgeted.treeUnavailable === "walk budget exhausted",
      `budget: and the report says the budget ran out (${budgeted.treeUnavailable})`,
    );
    // Rows already collected are evidence — the budget truncates the walk, it
    // does not discard the levels it got (the same rule as a per-level failure).
    expect(
      budgeted.processes.length >= 2,
      `budget: the levels walked before the budget are kept (${budgeted.processes.length})`,
    );
  }

  // ── Fix 5 (round 3): MAX_SNAPSHOT_CHARS is enforced, not just documented ──
  //
  // The docstring claimed a character bound on the snapshot while the constant
  // was read by nothing — a cap that cannot fail is worse than no cap, because
  // it reads like one. Two shapes: a tree too wide to fit the bound is
  // TRUNCATED and says so; and a tree whose very first row is too big for the
  // bound yields nothing rather than an empty section that reads like "no
  // descendants".
  {
    const fits = MAX_SNAPSHOT_CHARS / MAX_ARGS_CHARS;
    const wideArgs = "x".repeat(MAX_ARGS_CHARS);
    const bigTree = walkProcessTree(1, (pid) =>
      pid === 1
        ? {
            rows: Array.from({ length: 60 }, (_, i) => ({
              pid: 2 + i,
              ppid: 1,
              etime: "10:00",
              args: `${wideArgs}${i}`.slice(0, MAX_ARGS_CHARS),
            })),
          }
        : { rows: [] },
    );
    const chars = bigTree.processes.reduce((n, p) => n + p.args.length, 0);
    expect(
      chars <= MAX_SNAPSHOT_CHARS,
      `snapshot: command text never exceeds the documented cap (${chars} <= ${MAX_SNAPSHOT_CHARS})`,
    );
    expect(
      bigTree.processes.length < 60 && bigTree.processes.length >= 1,
      `snapshot: a tree wider than the cap is truncated to what fits (${bigTree.processes.length} of 60 rows, ${fits} rows' worth of text)`,
    );
    expect(
      bigTree.treeUnavailable?.includes("bounded"),
      `snapshot: a truncated tree says so rather than reading as a complete walk (${bigTree.treeUnavailable})`,
    );
  }

  // ── The written report lands where the cap event will point ───────────
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-hang-"));
    const p = writeGateHangLog(dir, "2026-01-01T00:00:00.000Z", base({ output: CARGO_STREAM }), {
      walk: () => tree(STUCK),
    });
    expect(p !== undefined && fs.existsSync(p), "log: the report is persisted");
    expect(p?.includes("gate-hang-"), `log: named as a hang report (${p?.split("/").pop()})`);
    const body = p === undefined ? "" : fs.readFileSync(p, "utf8");
    expect(
      body.includes("repo::sync::tests::pull_then_fetch") && body.includes("git remote-https"),
      "log: the file carries both the test name and the tree",
    );
    const mode = p === undefined ? 0 : fs.statSync(p).mode & 0o777;
    expect(mode === 0o600, `log: the killed run's raw stream is owner-only (${mode.toString(8)})`);

    // A scratch dir that cannot be written returns undefined — a reporting
    // failure never converts a gate failure into something else.
    const bad = writeGateHangLog("/proc/nope/nope", "t", base({ output: "" }));
    expect(bad === undefined, "log: an unwritable scratch dir yields no path, not an error");

    const sink: { gateHangLogPaths?: string[] } = {};
    if (p !== undefined) {
      recordGateHangLogPath(sink, p);
      recordGateHangLogPath(sink, p);
      expect(sink.gateHangLogPaths?.length === 1, "sink: the same report is recorded once");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n✓ gate hang report smoke passed");
}

main();

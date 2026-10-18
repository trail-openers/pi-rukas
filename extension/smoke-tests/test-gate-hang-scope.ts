/**
 * Offline smoke: #1427 round 3 — the two scoping defects in the hang-report
 * plumbing.
 *
 * 1. **A cap named reports from a run that had nothing to do with it.**
 *    `writeGateHangLog` recorded each path on the CYCLE CONTEXT
 *    (`ctx.gateHangLogPaths`), and `verifyStepOutcome` read that context list
 *    back when it composed its result. The context lives for the whole cycle
 *    and the gate runs up to three times in one develop step (first pass,
 *    fence merge-and-retry, sibling-symbol merge), so the second gate's cap
 *    carried the first gate's reports in `logPaths` — and because
 *    `work-develop-fence-merge-retry.ts` fell back to `?? ctx.gateHangLogPaths`
 *    when the re-run's own result had none, a cap could name reports even when
 *    the run that produced the cap killed nothing at all. The handoff then
 *    pointed the operator at a stale file. Round 3 gives each `verifyStepOutcome`
 *    call its own sink and returns only that call's paths.
 *
 * 2. **A second kill of one workstream in one cycle destroyed the first
 *    report.** `writeGateHangLog` composed its filename from the caller's
 *    timestamp plus a slug, and both are identical across two gate runs of the
 *    same worktree — so the flake re-run's kill overwrote the first run's
 *    report, silently, with no second file. The two files are now numbered.
 *
 * Both are driven through the production seams with a real git checkout and a
 * stub executor that kills every non-git run the way `execTree` does.
 *
 * Run:
 *   cd extension && bun run smoke-tests/test-gate-hang-scope.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { writeGateHangLog } from "../src/work-driver-verify-flake.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";
import { asShellForm } from "./lib/argv-shell.ts";
import {
  HUNG_STREAM,
  SENTINEL_ARGS,
  STUCK_TEST,
  git,
  killerExec,
} from "./lib/gate-hang-helpers.ts";

process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = "";
process.env.PI_ENSEMBLE_SKIP_RATCHET = "1";
process.env.PI_ENSEMBLE_COMMENT_RETENTION = "0";
process.env.PI_ENSEMBLE_SMOKE = "0";
process.env.PI_ENSEMBLE_VERIFY_FULL = "0";

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1427s-"));
let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

const SENTINEL = [
  { pid: 7001, ppid: 7000, etime: "01:15:02", args: "target/debug/deps/nessie-1a2b" },
  { pid: 7002, ppid: 7001, etime: "01:14:58", args: SENTINEL_ARGS },
];

async function repo(name: string) {
  const dir = path.join(root, name);
  const r = path.join(dir, "repo");
  mkdirSync(r, { recursive: true });
  writeFileSync(path.join(r, "tracked.txt"), "base\n");
  await git(r, ["init", "--initial-branch=main", r]);
  await git(r, ["config", "user.email", "t@example.com"]);
  await git(r, ["config", "user.name", "T"]);
  await git(r, ["add", "."]);
  await git(r, ["commit", "-q", "-m", "base"]);
  mkdirSync(path.join(r, ".pi"), { recursive: true });
  writeFileSync(path.join(r, ".pi", "verify-cmd"), "cargo test\n");
  await git(r, ["add", "."]);
  await git(r, ["commit", "-q", "-m", "add verify-cmd"]);
  const baseSha = (await git(r, ["rev-parse", "HEAD"])).stdout.trim();
  const wt = path.join(dir, "wt-a");
  await git(r, ["worktree", "add", "--detach", wt, baseSha]);
  writeFileSync(path.join(wt, "change.txt"), "new\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "change a"]);
  return { dir, repo: r, baseSha, wt };
}

function state(f: Awaited<ReturnType<typeof repo>>) {
  const s = initialState(1427, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      branchName: "feature/issue-1427",
      baseSha: f.baseSha,
      worktrees: { a: f.wt },
      workstreams: { a: { id: "a", scope: "hang test", paths: [], outOfScope: [] } },
    },
  };
}

// ── 1. Each gate call reports only its own writes ─────────────────────────
//
// Two `verifyStepOutcome` calls on one context, the way the develop step makes
// them (first pass, then a merge re-run). The first kills a run and writes a
// report; the second kills nothing (its command simply fails) and writes none.
// The second call's result must not name the first call's file.
async function caseScopedPerGateCall() {
  const f = await repo("scope");
  let killNext = true;
  const ctx: DriverContext = {
    host: {} as unknown as DriverContext["host"],
    repoRoot: f.repo,
    issue: 1427,
    verifyExecFn: asShellForm(async (cmd, o) => {
      const c = cmd;
      if (c === "git" || c.startsWith("git ")) {
        return { stdout: (await git(o?.cwd ?? "", c.slice(4).split(" "))).stdout };
      }
      if (killNext)
        throw Object.assign(new Error(`Command failed: ${c}`), {
          stdout: "",
          stderr: HUNG_STREAM,
          killed: true,
          treePid: 7000,
        });
      return { stdout: "", stderr: "assertion failed\n", code: 1 } as never;
    }),
    walkProcessTree: () => ({ processes: SENTINEL }),
  };

  // Call 1: killed → writes a report.
  killNext = true;
  const first = await verifyStepOutcome(ctx, state(f), "develop");
  const firstReports = first.hangLogPaths ?? [];
  assert(!first.ok, "scope: the first gate call fails");
  assert(
    firstReports.length > 0,
    `scope: the killed call reports its own report (${firstReports.length})`,
  );

  // Call 2: nothing is killed, so nothing new is written — and the cap this
  // call feeds must not name call 1's file.
  killNext = false;
  const second = await verifyStepOutcome(ctx, state(f), "develop");
  assert(!second.ok, "scope: the second gate call also fails (a plain assertion)");
  assert(
    second.hangLogPaths === undefined,
    `scope: an un-killed gate call names NO hang report (${(second.hangLogPaths ?? []).join(", ") || "none"})`,
  );
  // #1427 round 4 — no leak assertion here any more. The cycle-context
  // accumulator (`ctx.gateHangLogPaths`) this used to probe no longer exists:
  // #1427 round 3 gave each gate CALL its own sink and round 4 deleted the
  // recorder that fed it. The per-call result is the only carrier, so the
  // assertions above and below (this call reports its own file; the next call
  // reports none) are the leak test — a field that cannot exist cannot leak.
  // The first call's file is still on disk and still readable — scoping the
  // list must not delete evidence, only stop it being attributed to the wrong cap.
  assert(
    firstReports.every((p) => existsSync(p) && readFileSync(p, "utf8").includes(STUCK_TEST)),
    "scope: the earlier report is untouched on disk",
  );
}

// ── 2. Two kills of ONE workstream in one gate call keep both reports ─────
//
// The flake re-run is the reachable shape: run 1 is killed, the re-run is
// killed too, and both belong to the same worktree at the same instant, so the
// slug and the timestamp are identical. Before the fix the second write
// replaced the first file — one report for two kills, and the report described
// whichever run finished last.
async function caseMonotonicFilenames() {
  const dir = path.join(root, "mono");
  const input = {
    output: HUNG_STREAM,
    cmd: "cargo test",
    cwd: dir,
    timeoutMs: 60_000,
    processes: SENTINEL,
  };
  // The same timestamp AND the same tag — the exact collision the flake re-run
  // produces, which the round-2 timestamp+slug scheme does not prevent.
  const TS = "2026-01-01T00:00:00.000Z";
  const a = writeGateHangLog(
    dir,
    TS,
    { ...input, output: `${HUNG_STREAM}\nfirst kill` },
    {
      tag: "wt-a",
    },
  );
  const b = writeGateHangLog(
    dir,
    TS,
    { ...input, output: `${HUNG_STREAM}\nsecond kill` },
    {
      tag: "wt-a",
    },
  );
  assert(a !== undefined && b !== undefined, "mono: both writes returned a path");
  assert(
    a !== b,
    `mono: two kills of one workstream get two files (${a?.split("/").pop()} / ${b?.split("/").pop()})`,
  );
  if (a !== undefined && b !== undefined) {
    const ba = readFileSync(a, "utf8");
    const bb = readFileSync(b, "utf8");
    assert(
      ba.includes("first kill") && !ba.includes("second kill"),
      "mono: the first report still holds the first kill's stream",
    );
    assert(
      bb.includes("second kill") && !bb.includes("first kill"),
      "mono: the second report holds the second kill's stream",
    );
  }
  // Fix 6 asserted at the same seam: the file is created private, not made
  // private after the fact, so there is no window in which the killed run's
  // raw stream is group-readable.
  if (a !== undefined) {
    const mode = readFileSync ? (await import("node:fs")).statSync(a).mode & 0o777 : 0;
    assert(mode === 0o600, `mono: the report is created owner-only (${mode.toString(8)})`);
  }
  const dirMode = (await import("node:fs")).statSync(dir).mode & 0o777;
  assert(dirMode === 0o700, `mono: the scratch dir is created owner-only (${dirMode.toString(8)})`);
}

// ── 3. A killed run in a 3-worktree fan-out still reads as a timeout ──────
async function caseFanoutStillCapsAsTimeout() {
  const f = await repo("fanout");
  const wtB = path.join(f.dir, "wt-b");
  const wtC = path.join(f.dir, "wt-c");
  await git(f.repo, ["worktree", "add", "--detach", wtB, f.baseSha]);
  await git(f.repo, ["worktree", "add", "--detach", wtC, f.baseSha]);
  writeFileSync(path.join(wtB, "b.txt"), "b\n");
  await git(wtB, ["add", "."]);
  await git(wtB, ["commit", "-q", "-m", "b"]);
  writeFileSync(path.join(wtC, "c.txt"), "c\n");
  await git(wtC, ["add", "."]);
  await git(wtC, ["commit", "-q", "-m", "c"]);
  const long = (i: number) => `proptest::case_${i}::${"segment_".repeat(24)}${i}`;
  const stream = [
    "running 900 tests",
    ...Array.from({ length: 10 }, (_, i) => `test ${long(i)} has been running for over 60 seconds`),
  ].join("\n");
  const { exec } = killerExec({ hangStream: stream, treePid: 7000 });
  const ctx: DriverContext = {
    host: {} as unknown as DriverContext["host"],
    repoRoot: f.repo,
    issue: 1427,
    verifyExecFn: asShellForm(exec),
    walkProcessTree: () => ({ processes: SENTINEL }),
  };
  const s = state(f);
  s.pipelineState.worktrees = { a: f.wt, b: wtB, c: wtC };
  s.pipelineState.workstreams = {
    a: { id: "a", scope: "a", paths: [], outOfScope: [] },
    b: { id: "b", scope: "b", paths: [], outOfScope: [] },
    c: { id: "c", scope: "c", paths: [], outOfScope: [] },
  };
  const gate = await verifyStepOutcome(ctx, s, "develop");
  assert(!gate.ok, "fan-out: the killed gate fails");
  assert(
    gate.failures.length >= 3,
    `fan-out: every worktree failed its own gate (${gate.failures.length} failures)`,
  );
  assert(
    gate.failures.every((f2) => f2.includes("[verify-timeout]")),
    "fan-out: every bounded failure string still carries the timeout marker",
  );
  assert(
    (gate.hangLogPaths ?? []).length >= 3,
    `fan-out: one report per killed run (${(gate.hangLogPaths ?? []).length})`,
  );
  assert(
    new Set(gate.hangLogPaths ?? []).size === (gate.hangLogPaths ?? []).length,
    "fan-out: no report path is duplicated",
  );
}

try {
  await caseScopedPerGateCall();
  await caseMonotonicFilenames();
  await caseFanoutStillCapsAsTimeout();
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(exit);

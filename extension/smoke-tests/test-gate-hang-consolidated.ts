/**
 * Offline smoke: the #1427 fix round, consolidated path.
 *
 * Three defects this drives red before the fix:
 *
 *   1. `runVerifyCommandGate` forwarded the injected tree walker to
 *      `runConsolidatedVerify` as `{ onWalk: walkProcessTree }`. No such key
 *      exists on `ConsolidatedVerifyOpts`, so the walker was SILENTLY DROPPED
 *      on the consolidated path and the real `ps` walked the host instead —
 *      the report's tree section was whatever else was running.
 *   2. The per-worktree seam walked the tree twice — once for the written
 *      report and once again inside `timeoutWhere` — so the clause in the
 *      failure string and the report on disk could describe different
 *      snapshots.
 *   3. `gateHangLogName` keyed only on the timestamp, so a fan-out that kills
 *      two gate runs in the same millisecond overwrites the first report.
 *
 * Run:
 *   cd extension && bun run smoke-tests/test-gate-hang-consolidated.ts
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { HangProcess } from "../src/work-driver-gate-hang.ts";
import { asShellForm } from "./lib/argv-shell.ts";
import {
  HUNG_STREAM,
  SENTINEL_ARGS,
  STUCK_TEST,
  git,
  killerExec,
  sh,
} from "./lib/gate-hang-helpers.ts";

process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = "";
process.env.PI_ENSEMBLE_SKIP_RATCHET = "1";
process.env.PI_ENSEMBLE_COMMENT_RETENTION = "0";
process.env.PI_ENSEMBLE_SMOKE = "0";
process.env.PI_ENSEMBLE_VERIFY_FULL = "0";

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1427c-"));
let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

const SENTINEL: HangProcess[] = [
  { pid: 7001, ppid: 7000, etime: "01:15:02", args: "target/debug/deps/nessie-1a2b" },
  { pid: 7002, ppid: 7001, etime: "01:14:58", args: SENTINEL_ARGS },
];

/** A repo with one worktree carrying a commit; the consolidated probe runs there. */
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
  // An explicit `.pi/verify-cmd` in the base commit: `verifyCmdFor` must find
  // a command or the whole verify chain is skipped and nothing is killed.
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

function state(f: Awaited<ReturnType<typeof repo>>, wt: string) {
  const s = initialState(1427, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      branchName: "feature/issue-1427",
      baseSha: f.baseSha,
      worktrees: { a: wt },
      workstreams: { a: { id: "a", scope: "hang test", paths: [], outOfScope: [] } },
    },
  };
}

const SENTINEL_WALK = () => ({ processes: SENTINEL });

// ── 1. The consolidated probe uses the INJECTED walker, not the host's ps ──
async function caseConsolidatedWalkerForwarded() {
  const f = await repo("walker");
  const { exec, killed } = killerExec({ hangStream: HUNG_STREAM, treePid: 7000 });
  let walks = 0;
  const ctx: DriverContext = {
    host: {} as unknown as DriverContext["host"],
    repoRoot: f.repo,
    issue: 1427,
    verifyExecFn: asShellForm(exec),
    // The seam's walker parameter is `walkProcessTree` on the gate's options
    // (`runVerifyCommandGate`), which `verifyDevelopOutcome` threads from the
    // context — the context field's name IS the seam's, by design (#1427).
    walkProcessTree: (pid: number) => {
      walks += 1;
      return SENTINEL_WALK(pid);
    },
  };
  const gate = await verifyStepOutcome(ctx, state(f, f.wt), "develop");
  assert(!gate.ok, "consolidated: a killed gate fails the develop verify");
  assert(walks > 0, `consolidated: the injected walker ran (${walks}x)`);
  // #1427 round 3 — read the GATE RESULT, not the cycle context: the context
  // field was cycle-scoped, which is what let a late cap name an early run's file.
  const reports = (gate.hangLogPaths ?? []).filter((p) => p.includes("gate-hang-"));
  assert(reports.length > 0, `consolidated: reports written (${reports.length})`);
  const withSentinel = reports.filter((p) => {
    try {
      return readFileSync(p, "utf8").includes(SENTINEL_ARGS);
    } catch {
      return false;
    }
  });
  assert(
    withSentinel.length === reports.length,
    `consolidated: EVERY report carries the injected sentinel (${withSentinel.length}/${reports.length}) — a report without it walked the host's ps`,
  );
  assert(
    reports.some((p) => readFileSync(p, "utf8").includes(STUCK_TEST)),
    "consolidated: the report names the hung test",
  );
  assert(killed.length > 0, `consolidated: the fake did kill gate runs (${killed.length})`);
}

// ── 2. One walk per killed run: the clause and the report agree ───────────
async function caseSingleWalk() {
  const f = await repo("one-walk");
  const { exec } = killerExec({ hangStream: HUNG_STREAM, treePid: 7000 });
  let walks = 0;
  const ctx: DriverContext = {
    host: {} as unknown as DriverContext["host"],
    repoRoot: f.repo,
    issue: 1427,
    verifyExecFn: asShellForm(exec),
    walkProcessTree: () => {
      walks += 1;
      return { processes: SENTINEL };
    },
  };
  const gate = await verifyStepOutcome(ctx, state(f, f.wt), "develop");
  const reports = gate.hangLogPaths ?? [];
  assert(!gate.ok && reports.length > 0, "one-walk: a killed run both fails and reports");
  assert(
    walks === reports.length,
    `one-walk: exactly one walk per killed run (walks=${walks}, reports=${reports.length}) — the clause must reuse the catch's snapshot, not re-walk`,
  );
  const clauseBearing = gate.failures.filter((f2) => f2.includes(SENTINEL_ARGS));
  assert(
    clauseBearing.length > 0,
    "one-walk: the failure string's clause names the same processes the report does",
  );
}

// ── 3. Two killed runs of one cycle never share a filename ────────────────
async function caseUniqueNames() {
  const f = await repo("unique");
  const { exec } = killerExec({ hangStream: HUNG_STREAM, treePid: 7000 });
  const ctx: DriverContext = {
    host: {} as unknown as DriverContext["host"],
    repoRoot: f.repo,
    issue: 1427,
    verifyExecFn: asShellForm(exec),
    walkProcessTree: SENTINEL_WALK,
  };
  // Force every report of this cycle onto ONE timestamp: two killed runs in
  // the same millisecond collide on a timestamp-only filename, which is what
  // the uniqueness fix must prevent (real fan-outs collide far less often,
  // which is exactly why the defect survived).
  const realToISOString = Date.prototype.toISOString;
  Date.prototype.toISOString = function () {
    return "2026-01-01T00:00:00.000Z";
  };
  // Per-worktree kill AND consolidated kill happen in one cycle; with two
  // worktrees the per-worktree loop alone produces two reports.
  const wtB = path.join(f.dir, "wt-b");
  const s = state(f, f.wt);
  s.pipelineState.worktrees = { a: f.wt, b: wtB };
  s.pipelineState.workstreams = {
    a: { id: "a", scope: "hang a", paths: [], outOfScope: [] },
    b: { id: "b", scope: "hang b", paths: [], outOfScope: [] },
  };
  // The second worktree is created AFTER the clock is frozen (a real git
  // call is unaffected, but keeping the git plumbing outside the patched
  // window keeps the fixture honest).
  await git(f.repo, ["worktree", "add", "--detach", wtB, f.baseSha]);
  writeFileSync(path.join(wtB, "other.txt"), "b\n");
  await git(wtB, ["add", "."]);
  await git(wtB, ["commit", "-q", "-m", "change b"]);
  const gate = await verifyStepOutcome(ctx, s, "develop");
  Date.prototype.toISOString = realToISOString;
  const reports = gate.hangLogPaths ?? [];
  assert(!gate.ok, "unique: the cycle fails");
  assert(reports.length >= 2, `unique: more than one report for a fan-out (${reports.length})`);
  const names = reports.map((p) => path.basename(p));
  assert(
    new Set(names).size === names.length,
    `unique: report filenames are distinct (${names.join(", ") || "none"})`,
  );
  assert(
    names.every((n) => /gate-hang-[^/]+-[^-.]+\.log$/.test(n)),
    `unique: each name carries a per-run discriminator — the workstream/cwd slug or a counter (${names.join(", ")})`,
  );
  const bodies = reports.map((p) => readFileSync(p, "utf8"));
  assert(
    bodies.every((b) => b.includes(STUCK_TEST)),
    "unique: no report was overwritten into emptiness",
  );
}

try {
  await caseConsolidatedWalkerForwarded();
  await caseSingleWalk();
  await caseUniqueNames();
} finally {
  rmSync(root, { recursive: true, force: true });
}
void sh;
process.exit(exit);

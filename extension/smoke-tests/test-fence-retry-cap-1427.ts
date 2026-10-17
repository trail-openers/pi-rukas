/**
 * Offline smoke: #1427 fix round — the fence merge-and-retry's SECOND cap.
 *
 * When the develop gate records a sibling-declared fence violation the driver
 * merges the coupled workstreams, re-dispatches once, and re-runs the gates. If
 * that re-run fails, the flow parks — and the cap it parks with used to be
 * hardcoded to `fence-violation:develop` with an unbounded `join(" | ")` of the
 * failures and no `logPaths`, so:
 *
 *   - a merge re-run that TIMED OUT was reported as a fence problem (the
 *     handoff told the operator to restore a scope boundary; the real diagnosis
 *     was "give the gate more time"), and
 *   - the hang reports the re-run wrote were invisible to the handoff.
 *
 * This drives `runMergeRetryFlow` with a gate re-run that kills its verify
 * command, and asserts the cap is `verify-timeout:develop`, the evidence is
 * bounded, and the report paths ride on the event structurally.
 *
 * Run:
 *   cd extension && bun run smoke-tests/test-fence-retry-cap-1427.ts
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMergeRetryFlow } from "../src/work-develop-fence-merge-retry.ts";
import type { CycleContext, DriverContext } from "../src/work-driver-context.ts";
import type { HangProcess } from "../src/work-driver-gate-hang.ts";
import { initialState } from "../src/workflow-state.ts";
import { asShellForm } from "./lib/argv-shell.ts";
import { HUNG_STREAM, SENTINEL_ARGS, STUCK_TEST, git, killerExec, sh } from "./lib/gate-hang-helpers.ts";

process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = "";

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1427f-"));
let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

const SENTINEL: HangProcess[] = [
  { pid: 7002, ppid: 7001, etime: "01:14:58", args: SENTINEL_ARGS },
];

async function repo() {
  const dir = path.join(root, "r");
  const r = path.join(dir, "repo");
  mkdirSync(r, { recursive: true });
  writeFileSync(path.join(r, "tracked.txt"), "base\n");
  mkdirSync(path.join(r, ".pi"), { recursive: true });
  writeFileSync(path.join(r, ".pi", "verify-cmd"), "cargo test\n");
  await git(r, ["init", "--initial-branch=main", r]);
  await git(r, ["config", "user.email", "t@example.com"]);
  await git(r, ["config", "user.name", "T"]);
  await git(r, ["add", "."]);
  await git(r, ["commit", "-q", "-m", "base"]);
  const baseSha = (await git(r, ["rev-parse", "HEAD"])).stdout.trim();
  const wtA = path.join(dir, "wt-a");
  const wtB = path.join(dir, "wt-b");
  await git(r, ["worktree", "add", "--detach", wtA, baseSha]);
  await git(r, ["worktree", "add", "--detach", wtB, baseSha]);
  writeFileSync(path.join(wtA, "a.txt"), "a\n");
  await git(wtA, ["add", "."]);
  await git(wtA, ["commit", "-q", "-m", "a"]);
  writeFileSync(path.join(wtB, "b.txt"), "b\n");
  await git(wtB, ["add", "."]);
  await git(wtB, ["commit", "-q", "-m", "b"]);
  return { dir, repo: r, baseSha, wtA, wtB };
}

const f = await repo();

const { exec } = killerExec({ hangStream: HUNG_STREAM, treePid: 7000 });
// The merge prep's git plumbing runs for real; only the verify command dies.
const verifyExecFn = asShellForm(exec);

let s = initialState(1427, 1_000_000);
s = {
  ...s,
  pipelineState: {
    ...s.pipelineState,
    branchName: "feature/issue-1427",
    baseSha: f.baseSha,
    worktrees: { a: f.wtA, b: f.wtB },
    workstreams: {
      a: { id: "a", scope: "owner", paths: ["a.txt"], outOfScope: [] },
      b: { id: "b", scope: "violator", paths: ["b.txt"], outOfScope: [] },
    },
  },
};

const ctx: CycleContext = {
  host: {} as unknown as DriverContext["host"],
  repoRoot: f.repo,
  issue: 1427,
  verifyExecFn,
  walkProcessTree: () => ({ processes: SENTINEL }),
  emitSink: () => {},
};

const dispatch = async () => ({
  ok: true,
  finalText: "done",
  errorStop: false,
  stopReason: "stop" as const,
  durationMs: 10,
  totalCost: 0,
  inputTokens: 0,
  outputTokens: 0,
});

// The `sibling-declared` violation that triggers the merge: b touched a.txt,
// declared by a. `runMergePrep` reads the records from the state's
// verifyEvidence — that is the channel the develop gate writes them on.
const violations = [
  { kind: "sibling-declared" as const, workstreamId: "b", file: "a.txt", declaredById: "a" },
];

let state = s;
state = {
  ...state,
  pipelineState: {
    ...state.pipelineState,
    verifyEvidence: { step: "develop", failures: [], at: Date.now(), fenceViolations: violations },
  },
};
state = await runMergeRetryFlow(
  ctx,
  state,
  { current: state },
  ["a", "b"],
  [
    { id: "a", ok: true },
    { id: "b", ok: true },
  ],
  verifyExecFn,
  dispatch,
);

const capHits = state.eventLog.filter((e) => e.kind === "cap-hit");
// The flow's own park is the LAST cap-hit; with no violation recorded it may
// not fire at all, which the assertion below makes visible rather than silent.
if (violations.length > 0 && capHits.length > 0) {
  const last = capHits[capHits.length - 1];
  if (last.kind === "cap-hit") {
    assert(
      last.cap === "verify-timeout:develop",
      `fence-merge: a killed verify re-run caps as a TIMEOUT, not a fence violation (${last.cap})`,
    );
    assert(
      (last.evidence ?? "").length <= 4200,
      `fence-merge: evidence is bounded (${(last.evidence ?? "").length})`,
    );
    assert(
      (last.logPaths ?? []).some((p) => p.includes("gate-hang-")),
      `fence-merge: the cap event carries the hang report path (${(last.logPaths ?? []).join(", ") || "none"})`,
    );
    const reports = last.logPaths ?? [];
    assert(
      reports.length === 0 ||
        reports.every((p) => {
          try {
            return readFileSync(p, "utf8").includes(SENTINEL_ARGS);
          } catch {
            return false;
          }
        }),
      "fence-merge: the report used the injected walker",
    );
    assert(
      (last.evidence ?? "").includes(STUCK_TEST) || reports.length > 0,
      "fence-merge: the operator can find what hung",
    );
  }
} else {
  assert(false, "fence-merge: the merge-and-retry path produced a cap-hit at all");
}

void sh;
rmSync(root, { recursive: true, force: true });
process.exit(exit);

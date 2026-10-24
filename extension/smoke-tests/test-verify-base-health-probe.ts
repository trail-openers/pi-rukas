#!/usr/bin/env bun
/**
 * #1765 — the branch step asks the base commit BEFORE a developer is paid for.
 *
 * Three /work attempts on one base each re-paid a develop round (4909 s,
 * 6883 s, 8211 s) before anything said "the gate is red at the base commit, no
 * change can pass it". The fix is the probe in `work-driver-verify-base-health.ts`
 * and the two rules that make it affordable: a GREEN verdict is cached across
 * cycles for the exact run it judged, and a RED is never cached — a cycle that
 * would park on a red re-probes first, so one flaky red cannot park cycles it
 * never ran in.
 *
 * Every case drives the REAL probe through the real branch-step entry against a
 * real git repo whose gate is the suite's own `verify-loop.sh` over its own
 * fixtures (see `lib/base-health-probe-fixture.ts`), and counts its OWN gate
 * executions and `git worktree add` calls: the cost rule is as load-bearing as
 * the park, and a case that asserts only what the state says cannot tell one
 * extra suite run from none.
 *
 * Offline: temp git repos, no dispatch, no spawn.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HostBudget, __setHostBudget } from "../src/host-resources.ts";
import type { DriverExecFn } from "../src/work-driver-context.ts";
import { synthesizeDriverCompletion } from "../src/work-driver-events.ts";
import { aggregateVerifyOutcome } from "../src/work-driver-verify-aggregate.ts";
import {
  type BaseHealthVerdict,
  applyBaseHealthProbe,
  baseHealthCacheFile,
  baseHealthKey,
  cachedBaseHealth,
  matchingVerdict,
  readBaseHealthCache,
} from "../src/work-driver-verify-base-health.ts";
import {
  BASELINE_RED_MARKER,
  baselineProbeWorktreePath,
} from "../src/work-driver-verify-baseline.ts";
import { developTierTimeouts } from "../src/work-driver-verify-budget.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";
import {
  PROBE_CMD as CMD,
  GREEN_GATE,
  RED_GATE,
  branchState,
  capsOf,
  execLine,
  notesOf,
  probe,
} from "./lib/base-health-probe-fixture.ts";
import { realExec } from "./lib/restore-start-ref-fixtures.ts";
import { redGateFixture } from "./lib/verify-baseline-probe-harness.ts";
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * The cache file's reader, inlined here rather than exported from the module:
 * the seam is a guard on the CACHE WRITER (a green must reach the file in a
 * shape a later cycle can read), not a behaviour the driver calls — its
 * production twin is `usableVerdict`, which the probe already runs. A
 * malformed or non-green record is not green, so this is the writer's
 * assertion, never a second opinion the probe could consult.
 */
function looksLikeGreenVerdict(raw: unknown): raw is BaseHealthVerdict {
  const v = raw as Record<string, unknown> | null;
  return (
    v !== null &&
    typeof v === "object" &&
    v.status === "green" &&
    typeof v.baseSha === "string" &&
    v.baseSha !== "" &&
    typeof v.command === "string" &&
    v.command !== "" &&
    typeof v.tierBoundMs === "number" &&
    Number.isFinite(v.tierBoundMs) &&
    v.tierBoundMs > 0
  );
}

const root = mkdtempSync(path.join(tmpdir(), "pi-base-health-"));
/** The probe serialises behind `withVerifySlot`; unbounded keeps the suite fast. */
__setHostBudget({ verifyConcurrency: 0 } as HostBudget);

// ── 1 — a red base parks at branch and NO developer is dispatched.
{
  const f = await redGateFixture(root, "red", RED_GATE, { "notes.md": "x\n" });
  const r = await probe(f);
  const caps = capsOf(r.state);
  assert(
    caps.length === 1 && caps[0]?.cap === "verify-baseline-red:branch",
    `red base: the cycle parks at verify-baseline-red:branch (got ${JSON.stringify(caps.map((c) => c.cap))})`,
  );
  assert(
    caps[0]?.nextStep === "handoff",
    `red base: the park routes to handoff, not develop (got ${caps[0]?.nextStep})`,
  );
  assert(
    r.gateRuns.length === 1 && r.worktreeAdds === 1,
    `red base: exactly one gate run in one throwaway tree (got ${r.gateRuns.length} runs / ${r.worktreeAdds} adds)`,
  );
  const evidence = caps[0]?.evidence ?? "";
  assert(
    evidence.includes(BASELINE_RED_MARKER) && evidence.includes(f.baseSha.slice(0, 12)),
    "red base: the evidence is the baseline-red finding and names the base sha",
  );
  assert(evidence.includes(CMD), "red base: the evidence names the command the probe ran");
  assert(
    !r.state.eventLog.some((e) => e.kind === "dispatch-started"),
    "red base: nothing dispatched — zero develop spend",
  );
  assert(
    !r.state.eventLog.some((e) => e.step === "develop"),
    "red base: no develop step entered before the park",
  );
  const listed = (await realExec("git", { argv: ["worktree", "list"], cwd: f.repo })).stdout;
  assert(
    !listed.includes("baseline-verify-branch-1765"),
    `red base: the probe tree is torn down (${listed.trim().replace(/\n/g, " | ")})`,
  );
  assert(
    r.state.pipelineState.baseHealthProbe?.status === "red",
    "red base: the state records the red verdict it parked on",
  );
  assert(
    r.cacheRaw === undefined,
    "red base: the repo-level cache stays empty — red is never cached",
  );
}

// ── 2 — a green base pays for exactly one probe, then proceeds.
{
  const f = await redGateFixture(root, "green", GREEN_GATE, { "notes.md": "x\n" });
  const r = await probe(f);
  assert(capsOf(r.state).length === 0, "green base: no cap — the cycle proceeds to develop");
  assert(
    r.gateRuns.length === 1 && r.worktreeAdds === 1,
    `green base: the gate ran exactly once (got ${r.gateRuns.length} runs / ${r.worktreeAdds} adds)`,
  );
  assert(
    r.state.pipelineState.baseHealthProbe?.status === "green",
    "green base: the verdict is recorded on the state",
  );
  assert(
    r.cacheRaw !== undefined && looksLikeGreenVerdict(JSON.parse(r.cacheRaw).verdict),
    "green base: the green verdict is written to the repo-level cache",
  );
  assert(
    notesOf(r.state).some((s) => s.includes("GREEN")),
    "green base: a note records what the probe established",
  );
  const again = await probe(f, { state: r.state });
  assert(
    again.gateRuns.length === 0 && again.worktreeAdds === 0,
    `green base, probed again in the same cycle: no second suite run (got ${again.gateRuns.length})`,
  );
}

// ── 3 — a project with no verify command is not probed at all.
{
  const f = await redGateFixture(root, "nocmd", RED_GATE, { "notes.md": "x\n" });
  const r = await probe(f, { noCmd: true });
  assert(
    capsOf(r.state).length === 0 && r.gateRuns.length === 0,
    "no verify command: nothing runs and nothing parks",
  );
  assert(
    notesOf(r.state).some((s) => s.includes("no verify command")),
    "no verify command: the note says there was nothing to probe",
  );
}

// ── 4 — `unknown` never parks: the throwaway tree could not be created.
{
  const f = await redGateFixture(root, "add-fail", GREEN_GATE, { "notes.md": "x\n" });
  const r = await probe(f, { state: branchState("0".repeat(40)) });
  assert(
    capsOf(r.state).length === 0,
    "worktree add fails: the cycle is NOT parked — unknown is never a verdict",
  );
  assert(
    r.state.pipelineState.baseHealthProbe?.status === "unknown",
    "worktree add fails: the state records the unknown verdict",
  );
  assert(
    r.gateRuns.length === 0,
    "worktree add fails: the gate never ran, so nothing was paid for",
  );
  assert(r.cacheRaw === undefined, "worktree add fails: nothing cached");
}

// ── 5 — `unknown` never parks: the base failed for want of dependencies.
{
  const f = await redGateFixture(root, "deps", GREEN_GATE, { "notes.md": "x\n" });
  // A stub gate printing the dependency signature a bare checkout really
  // produces, and exiting 1 — the shape `looksLikeMissingDeps` decides on, not
  // hand-written prose this file invents.
  const stub = path.join(root, "deps-stub.sh");
  writeFileSync(stub, "#!/bin/sh\necho \"Cannot find module 'zod' from src/a.ts\"\nexit 1\n", {
    mode: 0o755,
  });
  writeFileSync(path.join(f.repo, "gate.sh"), `#!/bin/sh\nexec sh ${stub}\n`, { mode: 0o755 });
  await realExec("git", { argv: ["add", "-A"], cwd: f.repo });
  await realExec("git", { argv: ["commit", "-q", "-m", "chore: deps stub gate"], cwd: f.repo });
  const base = (await realExec("git", { argv: ["rev-parse", "HEAD"], cwd: f.repo })).stdout.trim();
  const r = await probe(f, { state: branchState(base) });
  const reason = r.state.pipelineState.baseHealthProbe?.reason ?? "none";
  assert(
    capsOf(r.state).length === 0 && reason.includes("dependencies"),
    `missing deps at base: NOT parked, and the unknown verdict says so (reason ${reason})`,
  );
}

// ── 6 — an exec that throws with NO stream is unknown, never green.
{
  const f = await redGateFixture(root, "no-stream", GREEN_GATE, { "notes.md": "x\n" });
  let sawGate = 0;
  const out = await applyBaseHealthProbe(
    async (cmd, o) => {
      const line = execLine(cmd, o);
      if (!line.startsWith("git ")) {
        sawGate += 1;
        // An executor that captured nothing at all: `combinedExecFailureStream`
        // then falls back to the Error's own message, which is node's bare
        // `Command failed: <cmd>` echo. The gate printed nothing, so an operator
        // reading the evidence could not tell a red base from a broken harness —
        // which is why the probe must earn no verdict here, and above all must
        // not hand back a cached green.
        rmSync(baseHealthCacheFile(f.repo), { force: true });
        throw new Error("Command failed: sh gate.sh");
      }
      return await realExec(cmd, o);
    },
    { host: {}, repoRoot: f.repo, issue: 1765 } as never,
    branchState(f.baseSha),
    CMD,
  );
  assert(sawGate === 1, "no stream: the gate really ran, so the case is not vacuous");
  assert(
    out.red === undefined && out.verdict?.status === "unknown" && out.ran === true,
    "no stream: an error whose only text is the harness message is no verdict — never a green base",
  );
}

// ── 7 — the green verdict is cached across cycles, keyed by the run it judged.
{
  const f = await redGateFixture(root, "cache-green", GREEN_GATE, { "notes.md": "x\n" });
  const first = await probe(f);
  assert(first.gateRuns.length === 1, "cache: the first cycle pays for the probe");
  const second = await probe(f);
  assert(
    second.gateRuns.length === 0 && second.worktreeAdds === 0,
    `cache: a second cycle on the same base does NOT re-probe (got ${second.gateRuns.length})`,
  );
  assert(capsOf(second.state).length === 0, "cache: the cached green proceeds like a probed green");
  await realExec("git", {
    argv: ["commit", "-q", "--allow-empty", "-m", "chore: base moved"],
    cwd: f.repo,
  });
  const moved = (await realExec("git", { argv: ["rev-parse", "HEAD"], cwd: f.repo })).stdout.trim();
  const third = await probe(f, { state: branchState(moved) });
  assert(
    third.gateRuns.length === 1,
    `cache: a new baseSha re-probes (got ${third.gateRuns.length}) — a green is only a green for the commit it ran on`,
  );
  // The bound is the key's third part: a project that raises its suite budget
  // has not been judged under the new one, so the cached verdict may not answer
  // for it. `.pi/verify-timeout-ms` is the suite tier's own project file.
  const bound = (await developTierTimeouts(f.repo)).suite;
  const cached = await readBaseHealthCache(
    async () => readFileSync(baseHealthCacheFile(f.repo), "utf8"),
    f.repo,
  );
  assert(cached?.status === "green", "cache key: a green sits in the file to be judged");
  assert(
    matchingVerdict(cached, { baseSha: f.baseSha, command: CMD, tierBoundMs: bound + 1 }) ===
      undefined,
    "cache key: a different tier bound is a different run — re-probe",
  );
  await realExec("git", { argv: ["checkout", "-q", "--detach", f.baseSha], cwd: f.repo });
  mkdirSync(path.join(f.repo, ".pi"), { recursive: true });
  writeFileSync(path.join(f.repo, ".pi", "verify-timeout-ms"), `${bound + 60_000}\n`);
  const raised = await probe(f);
  assert(
    raised.gateRuns.length === 1,
    `cache key: a raised suite bound re-probes (got ${raised.gateRuns.length}) — the cached verdict judged a different budget`,
  );
  rmSync(path.join(f.repo, ".pi", "verify-timeout-ms"), { force: true });
  const green: BaseHealthVerdict = {
    status: "green",
    baseSha: f.baseSha,
    command: CMD,
    tierBoundMs: bound,
  };
  assert(
    matchingVerdict(green, {
      baseSha: f.baseSha,
      command: "sh other.sh",
      tierBoundMs: bound,
    }) === undefined,
    "cache key: a different command is a different run — re-probe",
  );
  assert(
    baseHealthKey(green) === baseHealthKey({ ...green }),
    "cache key: the same run, the same key",
  );
  const hit = await cachedBaseHealth(initialState(1765), f.repo, {
    baseSha: f.baseSha,
    command: CMD,
    tierBoundMs: bound + 60_000,
  });
  assert(hit.from === "cache" && hit.verdict?.status === "green", "cache: read back from the file");
}

// ── 8 — a RED is never cached across cycles.
{
  const f = await redGateFixture(root, "cache-red", RED_GATE, { "notes.md": "x\n" });
  const first = await probe(f);
  assert(capsOf(first.state).length === 1, "red cache: the first cycle parked");
  const second = await probe(f);
  assert(
    second.gateRuns.length === 1 && capsOf(second.state).length === 1,
    `red cache: the next cycle RE-PROBES before it parks (got ${second.gateRuns.length} runs) — one flaky red must not park cycles it never ran in`,
  );
  const red: BaseHealthVerdict = {
    status: "red",
    baseSha: f.baseSha,
    command: CMD,
    tierBoundMs: 1,
  };
  const read = await readBaseHealthCache(async () => JSON.stringify({ verdict: red }), f.repo);
  assert(
    read?.status === "red",
    "red cache: a red CAN be read back, so refusing to reuse it is the policy, not the parser",
  );
  const held = branchState(f.baseSha);
  held.pipelineState.baseHealthProbe = red;
  const hit = await cachedBaseHealth(held, f.repo, {
    baseSha: f.baseSha,
    command: CMD,
    tierBoundMs: 1,
  });
  assert(
    hit.verdict?.status === "red",
    "red cache: an in-state red is readable (the aggregate reuses it)",
  );
  const third = await probe(f, { state: held });
  assert(
    third.gateRuns.length === 1 && capsOf(third.state).length === 1,
    "red cache: an in-state red does NOT let the branch step park without re-probing",
  );
}

// ── 9 — a malformed cache file means re-probe, never green.
{
  const f = await redGateFixture(root, "cache-bad", GREEN_GATE, { "notes.md": "x\n" });
  mkdirSync(path.dirname(baseHealthCacheFile(f.repo)), { recursive: true });
  const cases: Array<[string, string]> = [
    ["not JSON", "{ this is not json"],
    ["a bare array", "[]"],
    ["no verdict field", '{"other":1}'],
    ["a green with no sha", '{"verdict":{"status":"green","command":"x","tierBoundMs":1,"at":0}}'],
    [
      "a green with a zero bound",
      '{"verdict":{"status":"green","baseSha":"a","command":"x","tierBoundMs":0,"at":0}}',
    ],
    ["an unknown status", '{"verdict":{"status":"purple","baseSha":"a"}}'],
  ];
  for (const [label, body] of cases) {
    writeFileSync(baseHealthCacheFile(f.repo), body);
    const r = await probe(f);
    assert(
      r.gateRuns.length === 1 && capsOf(r.state).length === 0,
      `malformed cache (${label}): re-probe, and never read as green`,
    );
  }
  const healthy = JSON.parse(readFileSync(baseHealthCacheFile(f.repo), "utf8"));
  assert(healthy.verdict?.status === "green", "malformed cache: the good probe rewrote the file");
}

// ── 10 — the post-failure comparison reuses the in-cycle verdict: no second tree.
{
  const f = await redGateFixture(root, "reuse", RED_GATE, { "notes.md": "x\n" });
  const bound = (await developTierTimeouts(f.repo)).suite;
  const held = branchState(f.baseSha);
  const red: BaseHealthVerdict = {
    status: "red",
    baseSha: f.baseSha,
    command: CMD,
    tierBoundMs: bound,
  };
  held.pipelineState.baseHealthProbe = red;
  let worktreeAdds = 0;
  const execFn: DriverExecFn = async (cmd, o) => {
    if (execLine(cmd, o).startsWith("git worktree add")) worktreeAdds += 1;
    return await realExec(cmd, o);
  };
  const failures: string[] = [
    "verify command `sh gate.sh` failed in worktree a: expected 1, got 2",
  ];
  const notes: string[] = [];
  const attributed = await aggregateVerifyOutcome({
    execFn,
    ctx: { host: {}, repoRoot: f.repo, issue: 1765 } as never,
    cmd: CMD,
    baseSha: f.baseSha,
    suiteTimeoutMs: bound,
    cons: {
      status: "failed",
      detail: failures[0] as string,
      rawFailure: failures[0] as string,
      timedOut: false,
    } as never,
    perWorktreeVerifyFailures: [],
    failures,
    notes,
    baseHealthProbe: red,
  });
  assert(
    worktreeAdds === 0,
    `reuse: the post-failure comparison paid for NO second throwaway worktree (got ${worktreeAdds})`,
  );
  assert(
    failures.some((x) => x.startsWith(BASELINE_RED_MARKER)),
    "reuse: the baseline-red finding still leads the failures",
  );
  assert(
    notes.some((n) => n.includes("reused the branch step")),
    "reuse: the note says the verdict came from the branch step, not a new run",
  );
  assert(
    attributed === false,
    "reuse: a reused verdict holds no stream, so it never earns #1349's excuse",
  );
}

// ── 11 — the switches restore today's behaviour.
for (const [label, env] of [
  ["PI_ENSEMBLE_DEVELOP_BASELINE_PROBE=0", { PI_ENSEMBLE_DEVELOP_BASELINE_PROBE: "0" }],
  ["PI_ENSEMBLE_VERIFY=0", { PI_ENSEMBLE_VERIFY: "0" }],
] as const) {
  const f = await redGateFixture(root, `off-${label}`, RED_GATE, { "notes.md": "x\n" });
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const r = await probe(f);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  assert(
    capsOf(r.state).length === 0 && r.gateRuns.length === 0,
    `${label}: no probe and no park — the develop gate answers for the base as before`,
  );
  assert(
    notesOf(r.state).some((s) => s.includes("disabled")),
    `${label}: the note names the switch that skipped the probe`,
  );
}

// ── 12 — the probe tree never collides with the develop step's own probe.
{
  const f = await redGateFixture(root, "label", GREEN_GATE, { "notes.md": "x\n" });
  const r = await probe(f);
  const branchTree = baselineProbeWorktreePath(f.repo, "branch-1765");
  assert(
    branchTree.endsWith(path.join(".worktrees", "baseline-verify-branch-1765")),
    `tree name: the branch probe names itself (${branchTree})`,
  );
  assert(
    branchTree !== baselineProbeWorktreePath(f.repo, 1765),
    "tree name: it cannot collide with the develop step's baseline-verify-<issue>",
  );
  assert(r.state.pipelineState.baseSha === f.baseSha, "the probe leaves baseSha on the state");
}

// ── 13/14 — the red-base ATTRIBUTION rule (a bare `[verify-timeout]` names no
// base) and the pre-#1765 legacy-cache rule (a cache file that still carries
// `at` stays readable) live in `test-verify-baseline-attribution.ts`: both are
// pure and were over this file's AGENTS.md §12 budget.

// ── 15/16 — the arms a probe FAILS on (a red that parks, an echo that proves
// nothing, an executor that threw) and the two abort arms live in
// `test-verify-base-health-probe-failures.ts`: they drive the same entry with
// hostile executors, and splitting along that seam is what keeps both files
// inside the AGENTS.md §12 line budget. The fixtures are shared, not duplicated.

rmSync(root, { recursive: true, force: true });
process.exit(exit);

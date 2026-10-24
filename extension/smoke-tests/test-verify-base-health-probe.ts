#!/usr/bin/env bun
/**
 * #1765 — the base-commit probe, and the rules that make it affordable; plus the
 * change that took it OFF the branch step's critical path.
 *
 * Three /work attempts on one base each re-paid a develop round (4909 s,
 * 6883 s, 8211 s) before anything said "the gate is red at the base commit, no
 * change can pass it". The probe answers that question. Two rules make it
 * affordable: a GREEN is cached across cycles for the exact run it judged, and a
 * RED is never cached — each cycle re-probes, so one flaky red cannot speak for
 * cycles it never ran in.
 *
 * What changed since: awaiting that probe IN the branch step cost a median 711 s
 * on every cycle of a busy mainline (the green cache is keyed on the exact
 * base/command/bound triple and holds one record, so it is cold on essentially
 * every cycle), in exchange for a zero-developer park on the ~2 % of runs whose
 * base is red. So the branch step now REGISTERS the probe and returns; the develop
 * gate consults it only when its own verify has failed, and a red base is
 * attributed there as `verify-baseline-red:develop`. No case here expects a
 * `:branch` cap — each one asserts its absence, and that a passing develop pays
 * the probe nothing.
 *
 * Offline: temp git repos, no dispatch, no spawn.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HostBudget, __setHostBudget } from "../src/host-resources.ts";
import { clearBaseHealthInflight } from "../src/work-driver-base-health-inflight.ts";
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
  freshProbe,
  keyFor,
  probe,
  settled,
} from "./lib/base-health-probe-fixture.ts";
import { realExec } from "./lib/restore-start-ref-fixtures.ts";
import { redGateFixture } from "./lib/verify-baseline-probe-harness.ts";

/** Read the repo-level cache after a settled probe; undefined when absent/unreadable. */
function readBaseHealthCacheSync(repo: string): BaseHealthVerdict | undefined {
  try {
    const raw = JSON.parse(readFileSync(baseHealthCacheFile(repo), "utf8"));
    return raw.verdict as BaseHealthVerdict;
  } catch {
    return undefined;
  }
}
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

// ── 1 — a red base raises NO cap at the branch step; the verdict travels to the
// develop gate, which is where `verify-baseline-red:develop` is raised.
{
  const f = await redGateFixture(root, "red", RED_GATE, { "notes.md": "x\n" });
  const r = await probe(f);
  const caps = capsOf(r.state);
  assert(
    caps.length === 0 && !caps.some((c) => c.cap === "verify-baseline-red:branch"),
    `red base: the branch step raises no cap at all (got ${JSON.stringify(caps.map((c) => c.cap))}) — a red base is attributed at develop`,
  );
  const out = await settled(r);
  assert(
    r.gateRuns.length === 1 && r.worktreeAdds === 1,
    `red base: exactly one gate run in one throwaway tree (got ${r.gateRuns.length} runs / ${r.worktreeAdds} adds)`,
  );
  const message = out.red?.message ?? "";
  assert(
    out.verdict?.status === "red" && out.red !== undefined,
    `red base: the outcome carries the red and its evidence (got ${out.verdict?.status})`,
  );
  assert(
    message.includes(BASELINE_RED_MARKER) && message.includes(f.baseSha.slice(0, 12)),
    "red base: the evidence is the baseline-red finding and names the base sha",
  );
  assert(message.includes(CMD), "red base: the evidence names the command the probe ran");
  assert(
    !r.state.eventLog.some((e) => e.kind === "dispatch-started"),
    "red base: the step itself dispatched nothing",
  );
  assert(
    !r.state.eventLog.some((e) => e.step === "develop"),
    "red base: the branch step entered no develop step of its own",
  );
  const listed = (await realExec("git", { argv: ["worktree", "list"], cwd: f.repo })).stdout;
  assert(
    !listed.includes("baseline-verify-branch-1765"),
    `red base: the probe tree is torn down (${listed.trim().replace(/\n/g, " | ")})`,
  );
  assert(
    out.ms !== undefined && out.ms >= 0,
    `red base: the probe reports its own measured ms for the develop gate's record (got ${out.ms})`,
  );
  assert(
    readBaseHealthCacheSync(f.repo) === undefined,
    "red base: the repo-level cache stays empty — red is never cached",
  );
}

// ── 2 — a green base pays for exactly one probe, then proceeds.
{
  const f = await redGateFixture(root, "green", GREEN_GATE, { "notes.md": "x\n" });
  const r = await probe(f);
  assert(capsOf(r.state).length === 0, "green base: no cap — the cycle proceeds to develop");
  // Cost and cache are read AFTER the probe settles: the branch step no longer
  // waits, so counting before it would race the run it is meant to count.
  const green = await settled(r);
  assert(
    r.gateRuns.length === 1 && r.worktreeAdds === 1,
    `green base: the gate ran exactly once (got ${r.gateRuns.length} runs / ${r.worktreeAdds} adds)`,
  );
  assert(
    green.verdict?.status === "green",
    "green base: the probe's outcome is the verdict the develop gate would consult",
  );
  // Read after the probe settled, like the cost counters above.
  const cached = readBaseHealthCacheSync(f.repo);
  assert(
    cached !== undefined && looksLikeGreenVerdict(cached),
    "green base: the green verdict is written to the repo-level cache",
  );
  assert(
    green.notes.some((n) => n.includes("GREEN")),
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
    (await settled(r)).notes.some((n) => n.includes("no verify command")),
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
    (await settled(r)).verdict?.status === "unknown",
    "worktree add fails: the outcome carries the unknown verdict",
  );
  assert(
    r.gateRuns.length === 0,
    "worktree add fails: the gate never ran, so nothing was paid for",
  );
  assert(readBaseHealthCacheSync(f.repo) === undefined, "worktree add fails: nothing cached");
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
  const reason = (await settled(r)).verdict?.reason ?? "none";
  assert(
    capsOf(r.state).length === 0 && reason.includes("dependencies"),
    `missing deps at base: no cap, and the unknown verdict says so (reason ${reason})`,
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
    await keyFor(f.repo, f.baseSha),
  );
  assert(sawGate === 1, "no stream: the gate really ran, so the case is not vacuous");
  assert(
    out.red === undefined && out.verdict?.status === "unknown" && out.ran === true,
    "no stream: an error whose only text is the harness message is no verdict — never a green base",
  );
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
  // The switch is read at the moment the probe runs, so it must be set for the
  // WHOLE call: restoring it before the caller reads the notes let the previous
  // label's probe (still registered for this repo) answer, and the note that came
  // back was the other switch's.
  // One probe per key per process, and the key here is the fixture's base, whose
  // probe the PREVIOUS label left running: the registry joins it, and it is that
  // probe's notes the case would read. A new cycle starts with an empty registry,
  // so a switch case observes the effect of the switch it set only after dropping
  // what another label registered.
  clearBaseHealthInflight();
  const r = await probe(f);
  const out = await settled(r);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  assert(
    capsOf(r.state).length === 0 && r.gateRuns.length === 0,
    `${label}: nothing registered and no cap — the develop gate answers for the base as before`,
  );
  assert(
    out.notes.some((n) => n.includes("disabled") && n.includes(label.split("=")[0])),
    `${label}: the note names the switch that skipped the probe (got ${JSON.stringify(out.notes)})`,
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

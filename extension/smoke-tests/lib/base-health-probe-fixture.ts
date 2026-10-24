/**
 * Shared fixture for the base-health probe tests (the probe seam is #1765; taking
 * it off the branch step's critical path is what these cases pin).
 *
 * The cases drive the real probe against a real git repo whose gate IS the suite's
 * own `verify-loop.sh` over its own fixtures, so the `FAILED:` markers a red
 * verdict's evidence quotes are ones the loop really emitted — never a hand-written
 * imitation. What reading the state cannot do is assert the COST rule: a case that
 * only reads the state cannot tell one extra suite run from none, so every probe
 * call here counts executions of the PROJECT's command and the `git worktree add`
 * calls separately and hands both back to the caller's assertions.
 *
 * The probe is registered by the branch step and never awaited by it, so `probe`
 * returns the step's state AND the promise the step left behind: a case that wants
 * the verdict awaits `settled(r)`, and a case that asserts the step did not wait
 * measures the call itself.
 *
 * Split out for the 500-line cap (AGENTS.md §12): the probe wrapper and its event
 * readers are executor plumbing that reads better once than twice, and a counter
 * that drifts between two files would quietly make one of them test a different
 * cost model than the other.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DriverExecFn } from "../../src/work-driver-context.ts";
import type { BaseHealthConsulted } from "../../src/work-driver-verify-base-health-channels.ts";
import {
  type BaseHealthProbeOutcome,
  baseHealthCacheFile,
} from "../../src/work-driver-verify-base-health.ts";
import { developTierTimeouts } from "../../src/work-driver-verify-budget.ts";
import { recordDevelopGateEvents } from "../../src/work-driver-verify-events.ts";
import type { BaseHealthKey } from "../../src/workflow-state-schema-base-health.ts";
import { type WorkState, initialState } from "../../src/workflow-state.ts";
import { realExec } from "./restore-start-ref-fixtures.ts";
import type { redGateFixture } from "./verify-baseline-probe-harness.ts";

/** The project's verify command, as `.pi/verify-cmd` carries it in every case. */
export const PROBE_CMD = "sh gate.sh";
/** The new file's own alias for it, so both files name one command. */
export { PROBE_CMD as CMD } from "./base-health-probe-fixture.ts";
/**
 * The harness maps any test name that is not `allpass*` onto the always-failing
 * fixture, so a GREEN base gate has to be named `allpass-*`: that mapping is the
 * fixture vocabulary, not a convention a caller may quietly change.
 */
export const GREEN_GATE = ["tests/allpass-a.ts"];
export const RED_GATE = ["tests/test-red.ts"];

/** What one probe call did: the gate runs it paid for, and what it left behind. */
export interface ProbeRun {
  state: WorkState;
  /** One entry per execution of the PROJECT's command (never a git call). */
  gateRuns: string[];
  worktreeAdds: number;
  /** The repo-level cache file's contents, or undefined when nothing wrote it. */
  cacheRaw: string | undefined;
  /**
   * The background probe's outcome — what the branch step registered and did NOT
   * await. `undefined` when nothing was registered: no verify command, an
   * unusable baseSha, or the switches off (#1809 fix round — those cases register
   * nothing rather than a sentinel key nothing can match). Stored UN-awaited, so a
   * case can observe the probe while it is still running; read it through
   * `settled(r)` rather than awaiting it here, which would make "the step did not
   * wait" unobservable. The type is the probe seam's own `BaseHealthProbeOutcome`,
   * not a locally invented shape, so a case that reads `settled(r).verdict` is
   * reading what the gate's consultation reads.
   */
  outcome: Promise<BaseHealthProbeOutcome | undefined> | undefined;
}

/** A state carrying the branch step's own outputs, as the probe's caller has them. */
export function branchState(baseSha: string, issue = 1765): WorkState {
  const st = initialState(issue);
  st.pipelineState.baseSha = baseSha;
  return st;
}

/** The command line an executor call ran, argv joined for matching. */
export const execLine = (cmd: string, o?: { argv?: string[] }) =>
  o?.argv ? [cmd, ...o.argv].join(" ") : cmd;

/**
 * Register and run the probe against a fixture, exactly as the branch step does —
 * without awaiting it. `opts.noCmd` leaves the project with no verify command (the
 * skip condition); `opts.state` supplies a state that already holds a verdict,
 * which is how the cache rules are exercised from both sides.
 */
export async function probe(
  f: Awaited<ReturnType<typeof redGateFixture>>,
  opts: { noCmd?: boolean; state?: WorkState } = {},
): Promise<ProbeRun> {
  const { startBaseHealthProbeAtBranch } = await import(
    "../../src/work-driver-verify-base-health.ts"
  );
  const piDir = path.join(f.repo, ".pi");
  mkdirSync(piDir, { recursive: true });
  const cmdFile = path.join(piDir, "verify-cmd");
  if (opts.noCmd === true) rmSync(cmdFile, { force: true });
  else writeFileSync(cmdFile, `${PROBE_CMD}\n`);
  // The gate lists a fixed set of paths, so a case whose change adds one of
  // them has to commit the gate too — `redGateFixture` only rewrites it when the
  // caller passed `changeGateFiles`.
  const gate = path.join(f.worktrees.a, "gate.sh");
  if (existsSync(gate)) await realExec("git", { argv: ["add", "-A"], cwd: f.worktrees.a });
  const gateRuns: string[] = [];
  let worktreeAdds = 0;
  const execFn: DriverExecFn = async (cmd, o) => {
    const line = execLine(cmd, o);
    // Substring, not prefix: the probe qualifies each git call with `-C <root>`,
    // and a prefix match would silently never fire and report "no probe tree" for
    // a probe that built one. The counters fill BEFORE the child is awaited: the
    // red-base arm's child always throws, so a counter after the await would record
    // no run at all and "one gate run in one tree" would be unfalsifiable.
    if (line.includes("git worktree add")) worktreeAdds += 1;
    else if (!line.includes("git ")) gateRuns.push(o?.cwd ?? "");
    return await realExec(cmd, o);
  };
  const ctx = { host: {}, repoRoot: f.repo, issue: 1765 } as never;
  const state = opts.state ?? branchState(f.baseSha);
  // Registered ONCE (#1809 fix round): this used to call
  // `startBaseHealthProbeAtBranch` AND `probeBaseAtBranch`, which registered the
  // same probe twice (the second coalescing into the first via the single-flight
  // registry, so a case that counted runs saw one while a real cycle pays for what
  // may be another). Both entry points share one policy — `probeBaseAtBranch` is a
  // one-line call to the other — so the seam under test is still exercised here.
  //
  // `outcome` carries the UN-AWAITED promise the branch step itself drops, and that
  // is the fix: it is the only thing that lets a case tell "the step registered a
  // probe" from "the step registered nothing" — but NOT by value. The seam resolves
  // a SKIPPED outcome (`{ ran: false, notes: ["… nothing to probe"] }`) for the
  // no-command and unreadable-baseSha cases, so `undefined` never occurs on this
  // path and a case asserts the registration by what the probe reported: a
  // registration whose notes say "nothing to probe" is no registration. `settled(r)`
  // never fabricates that shape, which the old `?? { ran: false, notes: [] }` did —
  // it made "no probe" and "a probe that established nothing" one value. A case may
  // also read the counters while the probe is still in flight, since they fill as
  // each call is made, which is what "the step did not wait" costs a case to observe.
  const outcome = startBaseHealthProbeAtBranch(execFn, ctx, state);
  // The fixture does await what the step would not, for one reason: the cache file
  // below is the single observable a running probe WRITES, and reading it at
  // registration time reports a green the probe already earned as absent. The
  // promise never rejects, so this await cannot fault.
  await outcome;
  let cacheRaw: string | undefined;
  try {
    cacheRaw = readFileSync(baseHealthCacheFile(f.repo), "utf8");
  } catch {
    cacheRaw = undefined;
  }
  return { state, gateRuns, worktreeAdds, cacheRaw, outcome };
}

/**
 * Await what the branch step left running, so a case can read the verdict the
 * develop gate would have consulted. `undefined` is the caller's answer for "no
 * probe was registered" (no verify command, an unusable baseSha, or the switches
 * off) — it is NEVER fabricated here, because an invented `{ ran: false }` is
 * indistinguishable from a probe that ran and established nothing. The promise
 * itself never rejects, so no case has to defend itself against a probe that
 * faulted.
 */
export async function settled(r: ProbeRun): Promise<BaseHealthProbeOutcome | undefined> {
  return r.outcome === undefined ? undefined : await r.outcome;
}

/** The cap-hit events a probe left on the state. No base verdict raises one. */
export function capsOf(s: WorkState): Array<{ cap: string; evidence: string; nextStep: string }> {
  return s.eventLog.filter((e) => e.kind === "cap-hit") as Array<{
    cap: string;
    evidence: string;
    nextStep: string;
  }>;
}

/** The probe's own notes, as the driver's synthesized step-completion summary. */
export function notesOf(s: WorkState): string[] {
  return s.eventLog
    .filter((e) => e.kind === "dispatch-completed" && e.label === "driver:base-health")
    .map((e) => (e as { summary: string }).summary);
}

/**
 * The key a probe run answers for, as the branch step would have computed it: the
 * suite tier's own bound read from the fixture repo, so a case's cached verdict and
 * the gate's lookup agree on which run they are talking about.
 */
export async function keyFor(
  repo: string,
  baseSha: string,
  cmd: string = PROBE_CMD,
): Promise<BaseHealthKey> {
  return { baseSha, command: cmd, tierBoundMs: (await developTierTimeouts(repo)).suite };
}

/** The synchronous form, for a case that already knows the fixture's bound. */
export function branchKey(baseSha: string, tierBoundMs = 1): BaseHealthKey {
  return { baseSha, command: PROBE_CMD, tierBoundMs };
}

/**
 * Run the probe the way a FRESH CYCLE does — through `applyBaseHealthProbe`, which
 * is the probe body with the single-flight registry in front of it. A case that
 * calls `probe` twice in one process would otherwise have the second call answer
 * from the first call's registry entry and report "0 runs" for a cycle that in a
 * real process pays for its own; this is the only way to observe what a new cycle
 * actually pays.
 */
export async function freshProbe(
  f: Awaited<ReturnType<typeof redGateFixture>>,
  opts: { noCmd?: boolean; state?: WorkState; key?: BaseHealthKey } = {},
): Promise<{
  state: WorkState;
  out: BaseHealthProbeOutcome;
  gateRuns: string[];
  worktreeAdds: number;
}> {
  const piDir = path.join(f.repo, ".pi");
  mkdirSync(piDir, { recursive: true });
  const cmdFile = path.join(piDir, "verify-cmd");
  if (opts.noCmd === true) rmSync(cmdFile, { force: true });
  else writeFileSync(cmdFile, `${PROBE_CMD}\n`);
  const gate = path.join(f.worktrees.a, "gate.sh");
  if (existsSync(gate)) await realExec("git", { argv: ["add", "-A"], cwd: f.worktrees.a });
  const gateRuns: string[] = [];
  let worktreeAdds = 0;
  const execFn: DriverExecFn = async (cmd, o) => {
    const line = execLine(cmd, o);
    if (line.includes("git worktree add")) worktreeAdds += 1;
    else if (!line.includes("git ")) gateRuns.push(o?.cwd ?? "");
    return await realExec(cmd, o);
  };
  const { applyBaseHealthProbe } = await import("../../src/work-driver-verify-base-health.ts");
  const ctx = { host: {}, repoRoot: f.repo, issue: 1765 } as never;
  const state = opts.state ?? branchState(f.baseSha);
  const out = await applyBaseHealthProbe(
    execFn,
    ctx,
    state,
    PROBE_CMD,
    opts.key ?? (await keyFor(f.repo, f.baseSha)),
  );
  return { state, out, gateRuns, worktreeAdds };
}

/**
 * The record a develop gate makes when it consults a background probe: the colour
 * it read and the run's measured wall clock. A case that drives the gate directly
 * (rather than through `runDevelopVerifyGate`) builds this itself, which is why it
 * lives beside the fixture rather than only inside the gate.
 */
export function consultedRecord(
  out: BaseHealthProbeOutcome,
  status: BaseHealthConsulted["status"],
): BaseHealthConsulted {
  return {
    status,
    baseSha: out.verdict?.baseSha ?? "",
    ...(out.ms === undefined ? {} : { ms: out.ms }),
    ...(out.verdict?.timedOut === true ? { timedOut: true as const } : {}),
  };
}

/** The event the develop gate appends for a consultation, through the real recorder. */
export function consultedEvent(
  state: WorkState,
  out: BaseHealthProbeOutcome,
  status: BaseHealthConsulted["status"],
): WorkState {
  // The recorder derives the event's ms from the consultation's OWN measured probe
  // time, so the probe's duration is the only number a case has to hand it.
  return recordDevelopGateEvents(state, {
    baseHealthConsulted: consultedRecord(out, status),
  } as never);
}

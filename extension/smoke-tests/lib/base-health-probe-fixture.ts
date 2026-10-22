/**
 * Shared fixture for the #1765 pre-develop base-health probe tests.
 *
 * `test-verify-base-health-probe.ts` drives the real branch-step probe
 * (`probeBaseAtBranch`) against a real git repo whose gate IS the suite's own
 * `verify-loop.sh` over its own fixtures, so the `FAILED:` markers a park's
 * evidence quotes are ones the loop really emitted — never a hand-written
 * imitation of them. What the file cannot do is also assert the cost rule from
 * a transcript alone: a case that only reads the state cannot tell one extra
 * suite run from none. So every probe call here counts the executions of the
 * PROJECT's command and the `git worktree add` calls separately, and hands both
 * back to the caller's assertions.
 *
 * Split out for the 500-line cap (AGENTS.md §12): the probe wrapper and its two
 * event readers are ~80 lines of executor plumbing that read better once than
 * twice, and a counter that drifts between two files would quietly make one of
 * them test a different cost model than the other.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DriverExecFn } from "../../src/work-driver-context.ts";
import { baseHealthCacheFile } from "../../src/work-driver-verify-base-health.ts";
import { type WorkState, initialState } from "../../src/workflow-state.ts";
import { realExec } from "./restore-start-ref-fixtures.ts";
import type { redGateFixture } from "./verify-baseline-probe-harness.ts";

/** The project's verify command, as `.pi/verify-cmd` carries it in every case. */
export const PROBE_CMD = "sh gate.sh";
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
 * Run the real branch-step probe against a fixture. `opts.noCmd` leaves the
 * project with no verify command (the spec's skip condition); `opts.state`
 * supplies a state that already holds a verdict, which is how the cache rules
 * are exercised from both sides.
 */
export async function probe(
  f: Awaited<ReturnType<typeof redGateFixture>>,
  opts: { noCmd?: boolean; state?: WorkState } = {},
): Promise<ProbeRun> {
  const piDir = path.join(f.repo, ".pi");
  mkdirSync(piDir, { recursive: true });
  const cmdFile = path.join(piDir, "verify-cmd");
  if (opts.noCmd === true) rmSync(cmdFile, { force: true });
  else writeFileSync(cmdFile, `${PROBE_CMD}\n`);
  // The gate lists a fixed set of paths, so a case whose change adds one of
  // them has to commit the gate too — `redGateFixture` only rewrites it when
  // the caller passed `changeGateFiles`.
  const gate = path.join(f.worktrees.a, "gate.sh");
  if (existsSync(gate)) await realExec("git", { argv: ["add", "-A"], cwd: f.worktrees.a });
  const gateRuns: string[] = [];
  let worktreeAdds = 0;
  const execFn: DriverExecFn = async (cmd, o) => {
    const line = execLine(cmd, o);
    if (line.startsWith("git worktree add")) worktreeAdds += 1;
    else if (!line.startsWith("git ")) gateRuns.push(o?.cwd ?? "");
    return await realExec(cmd, o);
  };
  const { probeBaseAtBranch } = await import("../../src/work-driver-verify-base-health.ts");
  const ctx = { host: {}, repoRoot: f.repo, issue: 1765 } as never;
  const next = await probeBaseAtBranch(execFn, ctx, opts.state ?? branchState(f.baseSha));
  let cacheRaw: string | undefined;
  try {
    cacheRaw = readFileSync(baseHealthCacheFile(f.repo), "utf8");
  } catch {
    cacheRaw = undefined;
  }
  return { state: next, gateRuns, worktreeAdds, cacheRaw };
}

/** The cap-hit events a probe left on the state — the park, if there was one. */
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

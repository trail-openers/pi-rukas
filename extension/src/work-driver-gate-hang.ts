/**
 * work-driver-gate-hang — #1427: when a driver-run gate is killed at its
 * bound, say WHAT hung.
 *
 * The wall-clock bound on a gate already exists (#1324: `execTree` runs the
 * command as the leader of its own process group and SIGTERMs/SIGKILLs the
 * GROUP at the timeout), and the cap vocabulary already distinguishes a killed
 * run from a verdict (`verify-timeout:<step>`, #1324/#1349). What was missing
 * is the content of the report. The lantern #1054 measurement is the reason this
 * file exists: a `cargo test` gate hung for **75 minutes** with no output, the
 * cycle emitted only `slow` notices, and nothing said which test was stuck or
 * that the `git fetch` grandchildren of a test's own already-killed `git pull`
 * were still alive holding the worktree. A handoff that says "slow" sends the
 * operator to the diff. One that names the process says where to look.
 *
 * Three facts are captured, from one call to `reportGateHang`:
 *
 *   - **the still-running test names**, lifted from the output the run had
 *     already written when it was killed. libtest prints
 *     `test <name> has been running for over 60 seconds` on stderr for exactly
 *     this situation, and cargo's own "running N tests" / `test x ... ok` lines
 *     are kept as context. The lines are read from the captured streams, so
 *     they cost nothing extra and are gone if the run wrote nothing;
 *   - **the gate's own command line**, so the report names what was running;
 *   - **a process-tree snapshot of the gate's process group**, taken BEFORE the
 *     kill: `ps -eo pid,ppid,etime,args --ppid <pid>`, walked breadth-first
 *     from the leader. A snapshot taken after the kill shows the very
 *     nothingness the operator needs no help seeing; taken before it, it is the
 *     evidence of what was holding on, including the orphaned grandchildren
 *     that outlived their parent (`git remote-http`, in the measured case).
 *
 * The snapshot degrades honestly. `ps` is not on every host, and a walk is
 * bounded so a fork bomb cannot make the reporter the second problem: the
 * report says `could not capture a process tree (<reason>)` rather than
 * silently dropping the section. A hang report is an ADDITION to a gate
 * failure — it never turns one into a pass, and nothing here may throw.
 */

import { spawnSync } from "node:child_process";

/**
 * Leading marker of a hang report, the same convention as the other
 * no-verdict labels (`[verify-timeout]`, `[host-resource-exhaustion]`,
 * `[build-residue]`): the string is operator-facing text, and routing reads
 * the structured field, never this substring.
 */
export const GATE_HANG_LABEL = "[gate-hang]";

/**
 * #1427 fix round — the clause's "the runner named nothing" marker, exported
 * because the handoff explainer reads it out of the failure string to decide
 * whether to tell the operator to fall back to the process tree. A caller must
 * not have to guess the wording: `gateHangClause` is the only writer and this
 * is the one name it shares.
 */
export const GATE_HANG_NO_NAMED_TEST = "no named test";

/** Bound on the walking ps calls, so a stuck tree cannot make us a second problem. */
const MAX_PROCESSES = 60;

/** Bound on a single `ps` walk's output, characters. */
const MAX_SNAPSHOT_CHARS = 4_000;

/** Bound on one process line's command text. */
const MAX_ARGS_CHARS = 160;

/**
 * A `ps`-shaped process row. `etime` is `ps`' own elapsed-time column
 * (`[[HH:]MM:]SS`), which is what tells an operator a child has been sitting
 * there for 75 minutes rather than being a fresh spawn.
 */
export interface HangProcess {
  pid: number;
  ppid: number;
  /** The `ps` elapsed field verbatim, e.g. `01:14:47`. */
  etime: string;
  /** The command line, bounded to {@link MAX_ARGS_CHARS}. */
  args: string;
}

export interface HangEvidence {
  /**
   * Test names the runner had already flagged as slow, in order of first
   * appearance, deduplicated. Empty when the run printed nothing recognisable
   * — which is itself information the renderer says out loud rather than
   * reporting an empty list as if it were a verdict.
   */
  runningTests: string[];
  /** The gate's own command line. */
  cmd: string;
  /** Where it ran. */
  cwd: string;
  /** The bound it hit, in ms — formatted by the caller's `boundText`. */
  timeoutMs: number;
  /** The process-tree rows, breadth-first from the leader. Empty = no tree. */
  processes: HangProcess[];
  /**
   * Extra prose the caller wants in the headline — bounded, and the caller's
   * responsibility to keep short. The per-worktree seam uses it to name the
   * deepest commands in the group, which is the part of the tree an operator
   * acts on ("the test's `git pull` left a `git remote-http` behind").
   */
  detail?: string;
  /** Why no tree could be captured; `undefined` when `processes` is non-empty. */
  treeUnavailable?: string;
  /**
   * The killed run's own stream, whose tail the report prints. Optional because
   * a caller that only composes a one-line clause has nothing to show.
   */
  stdoutTail?: string;
}

/**
 * What `execTree` reports on a killed run. The type is declared here rather
 * than imported from `exec-tree.ts` because the gate seams reach a killed run
 * through the injected `ExecFn`, whose rejections are produced by test fakes
 * and by `withFastTier`'s rethrow as well as by the real executor — so the
 * caller reads these fields off whatever came back, optionally.
 */
export interface KilledRunError {
  stdout?: string;
  stderr?: string;
  /** True on either kill path (timeout OR maxBuffer overflow); see `timedOutKill`. */
  killed?: boolean;
  /** #1427 — the run was stopped by the wall-clock bound: the hang shape. */
  timedOutKill?: boolean;
  /** #1427 — the stream that overflowed when the run was overflow-killed. */
  overflow?: string;
}

/**
 * The runner's own "this test is slow" line, for the three suites this repo's
 * gates actually run: cargo's libtest, Go's testing package, and bun's test
 * runner (whose wording carries no spaces, hence the `\S+`). Any line whose
 * shape says "a named test has been going for a while" is a hang candidate.
 *
 * Deliberately NOT matched: a line that merely prints a duration without the
 * "running" verb — a passing test that took 90 seconds is not evidence of a
 * hang, and naming it as one is exactly the false accusation this feature must
 * not make.
 */
const RUNNING_FOR_RE =
  /^[\s>*-]*(?:test|test:)\s+(\S+).*?\b(?:has been )?running for (?:over )?([0-9.]+)\s*se(?:c|conds?)/im;

/** The same line, globally, for extraction across a whole stream. */
const RUNNING_FOR_RE_GLOBAL = new RegExp(RUNNING_FOR_RE.source, "gim");

/**
 * The names the runner itself flagged as still running, in first-appearance
 * order. Bounded so a suite that printed thousands of them still yields a
 * report that fits its evidence window.
 */
export function extractRunningTests(output: string, limit = 10): string[] {
  if (!output) return [];
  const out: string[] = [];
  for (const m of output.matchAll(RUNNING_FOR_RE_GLOBAL)) {
    const name = m[1];
    if (!name) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The last bounded stretch of the run's own output. A gate that hangs silently
 * prints nothing, so "the last thing it said" is usually the name of the thing
 * it started and never finished — the second-best signal after the runner's own
 * slow-test line, and better than nothing.
 *
 * The last line is dropped when the runner wrote no trailing newline: it is a
 * partial line, the one the killed process was mid-write on, and a truncated
 * fragment reads as a claim.
 */
export function lastOutputLines(output: string, maxLines = 6): string {
  const lines = output.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "";
  const window = lines.slice(-maxLines);
  return window.map((l) => l.slice(0, MAX_ARGS_CHARS)).join("\n");
}

/** Parse one `ps -eo pid,ppid,etime,args` row. Returns null for headers/junk. */
function parsePsLine(line: string): HangProcess | null {
  const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
  if (!m) return null;
  const pid = Number(m[1]);
  const ppid = Number(m[2]);
  if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null;
  const args = (m[4] ?? "").trim();
  if (!args) return null;
  return { pid, ppid, etime: m[3] ?? "?", args: args.slice(0, MAX_ARGS_CHARS) };
}

/** The command a `ps` walk runs. Exported so the offline test can drive it. */
export function psWalkArgv(parentPid: number): string[] {
  return ["-eo", "pid,ppid,etime,args", "--ppid", String(parentPid)];
}

/**
 * One level of the tree, via `ps --ppid`. `spawnSync` is used rather than
 * `execFile`: the caller is the failure path of a gate whose executor may be
 * the thing that is misbehaving, and a synchronous spawn of a stdlib binary
 * cannot deadlock on a promise the dying gate is holding.
 */
function psChildren(
  parentPid: number,
  run: typeof spawnSync,
): { rows: HangProcess[]; error?: string } {
  let res: ReturnType<typeof spawnSync>;
  try {
    res = run("ps", psWalkArgv(parentPid), { encoding: "utf8", timeout: 3_000 });
  } catch (e) {
    return { rows: [], error: `ps could not be started (${(e as Error).message?.slice(0, 80)})` };
  }
  if (res.error)
    return { rows: [], error: `ps could not be started (${res.error.message.slice(0, 80)})` };
  // exit 1 with no output is `ps`' answer to "no such parent", which is a
  // legitimate empty level, not a failure to snapshot.
  const stdout = typeof res.stdout === "string" ? res.stdout : "";
  if (res.status !== 0 && stdout.trim() === "") {
    return { rows: [], error: `ps exited ${res.status} without output` };
  }
  const rows: HangProcess[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const row = parsePsLine(line);
    if (row) rows.push(row);
  }
  return { rows };
}

/**
 * Walk the gate's process tree breadth-first from its leader, bounded to
 * {@link MAX_PROCESSES} rows and {@link MAX_SNAPSHOT_CHARS} of command text.
 *
 * `childrenOf` is injectable so the walk is testable without forking, and a
 * real `ps` on the host is what production gets. A failure on the FIRST level
 * (no `ps` binary, a host without `--ppid`) is reported as `treeUnavailable`;
 * a failure deeper in is not — the levels already walked are the evidence.
 */
export function walkProcessTree(
  leaderPid: number,
  childrenOf: (pid: number) => { rows: HangProcess[]; error?: string } = (pid) =>
    psChildren(pid, spawnSync),
): { processes: HangProcess[]; treeUnavailable?: string } {
  const processes: HangProcess[] = [];
  const visited = new Set<number>();
  const queue: number[] = [leaderPid];
  let firstLevelError: string | undefined;
  while (queue.length > 0 && processes.length < MAX_PROCESSES) {
    const parent = queue.shift() as number;
    if (visited.has(parent)) continue;
    visited.add(parent);
    const level = childrenOf(parent);
    if (level.error) {
      if (processes.length === 0 && visited.size === 1) firstLevelError = level.error;
      continue;
    }
    for (const row of level.rows) {
      if (processes.length >= MAX_PROCESSES) break;
      processes.push(row);
      queue.push(row.pid);
    }
  }
  if (processes.length === 0) {
    return {
      processes: [],
      treeUnavailable: firstLevelError ?? "no descendant process answered for the gate's pid",
    };
  }
  return { processes };
}

/** The default tree walker, kept behind a name so callers stay readable. */
export function captureProcessTree(leaderPid: number): {
  processes: HangProcess[];
  treeUnavailable?: string;
} {
  return walkProcessTree(leaderPid);
}

/** Render the still-running test names, or say the run printed nothing. */
function runningTestsSection(e: HangEvidence): string {
  if (e.runningTests.length > 0) {
    return e.runningTests.map((t) => `\n  - still running: ${t}`).join("");
  }
  return "\n  - the run printed no test-runner 'has been running for over N seconds' line";
}

function treeSection(e: HangEvidence): string {
  if (e.processes.length === 0) {
    return `\n  - process tree: unavailable (${e.treeUnavailable ?? "not captured"})`;
  }
  const rows = e.processes
    .slice(0, 20)
    .map((p) => `      ${String(p.pid).padStart(7)}  ${p.etime.padStart(9)}  ${p.args}`)
    .join("\n");
  const more = e.processes.length > 20 ? `\n      …${e.processes.length - 20} more` : "";
  return `\n  - process tree of the gate's group, taken before the kill:\n${rows}${more}`;
}

/**
 * The one-line headline a gate failure carries, bounded to survive the 800-char
 * evidence window (work-develop-cap-evidence.ts keeps the tail of each failure
 * string, so the parts an operator acts on lead).
 */
export function gateHangClause(e: HangEvidence): string {
  const who = e.runningTests.length > 0 ? e.runningTests.join(", ") : GATE_HANG_NO_NAMED_TEST;
  const held =
    e.processes.length > 0
      ? `${e.processes.length} process(es) still alive${e.detail === undefined ? "" : ` (${e.detail})`}`
      : "no child process";
  return `${GATE_HANG_LABEL} hung in ${who}; ${held}`;
}

/**
 * The full report: headline, the names, the tree, and the tail of the run's own
 * output. Returns the text only — the caller decides where it lands (a failure
 * string, the cap's evidence, or a scratch log).
 */
export function renderGateHangReport(e: HangEvidence): string {
  const tail = lastOutputLines(`${e.stdoutTail ?? ""}`, 6);
  const mins = Math.round(e.timeoutMs / 60_000);
  const bound = e.timeoutMs >= 60_000 ? `${mins}m` : `${Math.round(e.timeoutMs / 1000)}s`;
  return [
    `${gateHangClause(e)} (command \`${e.cmd}\` in ${e.cwd}, bound ${bound})`,
    runningTestsSection(e),
    treeSection(e),
    tail ? `\n  - last output before the kill:\n${tail}` : "",
  ].join("");
}

/** The fields a caller supplies when it has no separate stdout tail. */
export type GateHangInput = Omit<HangEvidence, "runningTests" | "processes" | "treeUnavailable"> & {
  runningTests?: string[];
  /** The killed run's combined stream; the source of `runningTests` and the tail. */
  output?: string;
  processes?: HangProcess[];
  treeUnavailable?: string;
  /** The leader pid whose process group the executor killed. */
  leaderPid?: number;
};

/**
 * Build a hang report from a killed gate run.
 *
 * `leaderPid` is the pid whose process group was killed — the leader `execTree`
 * spawned. It is `undefined` on the test-fake paths and on any executor that
 * does not report one, and then the report says so rather than walking the
 * whole session and blaming something unrelated to the gate.
 *
 * Never throws: a hang report is an addition to a gate failure, and a reporter
 * that can take the failure path down is worse than no reporter.
 */
export function reportGateHang(
  input: GateHangInput,
  deps: {
    /** Injectable tree walker (tests drive it without forking `ps`). */
    walk?: (leaderPid: number) => { processes: HangProcess[]; treeUnavailable?: string };
  } = {},
): string {
  try {
    const output = input.output ?? `${input.stdoutTail ?? ""}`;
    const running = input.runningTests ?? extractRunningTests(output);
    const tree =
      input.processes !== undefined || input.treeUnavailable !== undefined
        ? { processes: input.processes ?? [], treeUnavailable: input.treeUnavailable }
        : input.leaderPid === undefined
          ? { processes: [], treeUnavailable: "the executor reported no gate pid" }
          : (deps.walk ?? captureProcessTree)(input.leaderPid);
    return renderGateHangReport({
      runningTests: running,
      cmd: input.cmd,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      processes: tree.processes,
      ...(tree.treeUnavailable !== undefined ? { treeUnavailable: tree.treeUnavailable } : {}),
      stdoutTail: output,
    });
  } catch (err) {
    return `${GATE_HANG_LABEL} hung test could not be identified (reporting failed: ${(err as Error).message?.slice(0, 80)})`;
  }
}

/**
 * The commands worth naming in a one-line clause: the ones no other row in the
 * tree is a parent of — the leaves. In the measured case the leaf is
 * `git remote-https`, orphaned under a `git pull` the test had already killed,
 * and naming the *leader* (`cargo test`) would tell the operator nothing they
 * did not already know. Bounded to two rows so the clause keeps its shape.
 */
export function deepestCommands(rows: HangProcess[], limit = 2): string {
  if (rows.length === 0) return "";
  // A row is a leaf when nothing else in the snapshot claims it as a parent.
  const parents = new Set(rows.map((r) => r.ppid));
  const leaves = rows.filter((r) => !parents.has(r.pid));
  return (leaves.length > 0 ? leaves : rows)
    .slice(0, limit)
    .map((r) => r.args)
    .join("; ");
}

/** True when a failure string already carries a hang report. */
export function isGateHangFailure(failure: string): boolean {
  return failure.includes(GATE_HANG_LABEL);
}

/** The subset of `DriverContext` the recorder touches. Declared structurally so
 *  this module keeps no import edge to the driver context (which imports it). */
export interface GateHangPathSink {
  gateHangLogPaths?: string[];
}

/**
 * #1427 — record a written hang report on the cycle context, which is where the
 * cap emit site looks. Written as a function rather than an assignment at each
 * call site because a develop cycle reaches its verify cap from three places
 * (first pass, fence merge, symbol merge) and each would otherwise have to
 * remember the spread; a recorder is the one shape that cannot be half-applied.
 */
export function recordGateHangLogPath(sink: GateHangPathSink, logPath: string): void {
  if (sink.gateHangLogPaths?.includes(logPath)) return;
  sink.gateHangLogPaths = [...(sink.gateHangLogPaths ?? []), logPath];
}

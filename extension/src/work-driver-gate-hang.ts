/**
 * work-driver-gate-hang — #1427: when a driver-run gate is killed at its
 * bound, say WHAT hung.
 *
 * The wall-clock bound on a gate already exists (#1324: `execTree` runs the
 * command as the leader of its own process group and SIGTERMs/SIGKILLs the
 * GROUP at the timeout), and the cap vocabulary already distinguishes a killed
 * run from a verdict (`verify-timeout:<step>`, #1324/#1349). What was missing
 * is the content of the report. The nessie #1054 measurement is the reason this
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

import { MAX_ARGS_CHARS, captureProcessTree } from "./work-driver-gate-hang-tree.ts";

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

/**
 * #1427 round 4 — what the clause says when the caller handed in no process tree
 * at all. A distinct string from {@link GATE_HANG_NO_NAMED_TEST} and from
 * `gateHangClause`'s `no child process`, because the three are three different
 * claims: no test was named, the group was observed empty, and nobody looked.
 * The last one must never be rendered as the second.
 */
export const NO_TREE_CAPTURED = "no tree was captured";

// #1427 round 3 — the process-tree half of this module (the `ps` walk and its
// three bounds) lives in `work-driver-gate-hang-tree.ts` for AGENTS.md §12's
// line cap. Re-exported so the renderer's own consumers, and the smoke tests
// that assert the bounds, keep one import path — the bounds are part of what a
// hang report claims, so they belong to this module's vocabulary.
export {
  MAX_ARGS_CHARS,
  MAX_SNAPSHOT_CHARS,
  WALK_BUDGET_MS,
  captureProcessTree,
  psWalkArgv,
  walkProcessTree,
} from "./work-driver-gate-hang-tree.ts";

/**
 * #1427 round 3 — bound on ONE still-running test name as it enters a report.
 * A libtest name is normally 40-80 chars, so the bound never bites in the
 * measured case; the case it exists for is a 3-worktree fan-out where each of
 * ten names is a generated-proptest path several hundred characters deep. Ten
 * of those joined into the clause is more than the 800-char evidence window a
 * failure string survives (`work-develop-cap-evidence.ts` keeps the TAIL of
 * each failure, so everything ahead of it is what gets kept — and a long tail
 * of names is precisely what pushes `[verify-timeout]` out of the string).
 */
const MAX_TEST_NAME_CHARS = 120;

/** The one-kept-character-of-ellipsis marker on a clipped name. */
const NAME_ELLIPSIS = "\u2026";

/**
 * #1427 round 4 — the clause bound is DERIVED from the worst case rather than
 * chosen to look safe. Every quantity the clause can print is accounted for, so
 * the 800-char evidence window (`CAP_EVIDENCE_PER_FAILURE_MAX` in
 * `work-develop-cap-evidence.ts`, which keeps a failure's TAIL and finds no
 * `FAILED:` marker in a timeout string, so the tail really is `slice(-800)`)
 * always carries BOTH the `[verify-timeout]` headline that `verifyCapFor` routes
 * on and everything the clause adds.
 */
const EVIDENCE_WINDOW_CHARS = 800;
/** The longest leaf-command list `deepestCommands` emits: its own `limit = 2`. */
const MAX_DETAIL_ROWS = 2;
/** How many characters of the #1324 headline the window must still carry. */
const TIMEOUT_HEADLINE_RESERVE_CHARS = 96;
/** The clause's fixed prose around the names and the process count. */
const CLAUSE_PROSE_OVERHEAD_CHARS =
  // "[gate-hang] hung in " + "; " + " process(es) still alive (" + ")" — the
  // populated case is the wider of the two branches — plus the longest reason an
  // empty tree can be given, which rides in the same parentheses when nothing
  // was collected.
  "[gate-hang] hung in ;  process(es) still alive ()".length +
  "process tree unavailable ()".length +
  "process snapshot bounded to 4000 characters".length;
/** Digits the process count can occupy — at most `MAX_PROCESSES`, so two, and
 *  three is reserved rather than exact so widening the row cap cannot overrun. */
const PROCESS_COUNT_RESERVE_CHARS = 32;

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
    // The bound is applied HERE rather than in `gateHangClause` so the report
    // file and the failure-string clause carry the same clipped name — the
    // round-2 fix established that one kill describes itself once, and a name
    // that reads differently in the two places is that defect in new clothing.
    const clipped =
      name.length <= MAX_TEST_NAME_CHARS
        ? name
        : `${name.slice(0, MAX_TEST_NAME_CHARS - NAME_ELLIPSIS.length)}${NAME_ELLIPSIS}`;
    if (!out.includes(clipped)) out.push(clipped);
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
  const who = boundWho(e.runningTests);
  // Three distinct claims, three distinct strings — an operator who reads "no
  // child process" believes the group was looked at and found empty. When nobody
  // looked (or the walk was cut short), the clause says which of those happened
  // and why. #1427 round 4: the clause composer can no longer walk, so this is
  // the only honest way to render an absent tree.
  const held =
    e.processes.length > 0
      ? `${e.processes.length} process(es) still alive${e.detail === undefined ? "" : ` (${e.detail})`}`
      : `process tree unavailable (${e.treeUnavailable ?? "not captured"})`;
  return `${GATE_HANG_LABEL} hung in ${who}; ${held}`;
}

/**
 * Bound on the joined "hung in …" list, characters. DERIVED from the widest
 * clause the module can produce — the maximum name list, the process count, and
 * {@link MAX_DETAIL_ROWS} leaf commands at {@link MAX_ARGS_CHARS} each — so that
 * the `[verify-timeout]` headline the cap router keys on stays inside the
 * evidence window in the adversarial case, not merely the measured one. The test
 * drives exactly that worst case; a bound nothing constructs is not a bound.
 */
const MAX_WHO_CHARS =
  EVIDENCE_WINDOW_CHARS -
  TIMEOUT_HEADLINE_RESERVE_CHARS -
  MAX_DETAIL_ROWS * MAX_ARGS_CHARS -
  PROCESS_COUNT_RESERVE_CHARS -
  CLAUSE_PROSE_OVERHEAD_CHARS;

/**
 * #1427 round 3 — the bounded `who` of a hang clause: each name is already
 * clipped by {@link extractRunningTests}, and the JOIN is clipped here so a
 * fan-out that killed ten long-named tests in one run cannot produce a clause
 * longer than the evidence window that has to carry it. The tail is what gets
 * cut, which is why the headline leads.
 */
function boundWho(runningTests: string[]): string {
  if (runningTests.length === 0) return GATE_HANG_NO_NAMED_TEST;
  const joined = runningTests.join(", ");
  if (joined.length <= MAX_WHO_CHARS) return joined;
  return `${joined.slice(0, MAX_WHO_CHARS - NAME_ELLIPSIS.length)}${NAME_ELLIPSIS}`;
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

/**
 * #1427 — the per-gate-CALL collector for written hang report paths.
 *
 * One sink per `verifyStepOutcome` call: `work-driver-verify-pr17.ts` creates it,
 * `runVerifyCommandGate` feeds it from both writing seams (the per-worktree loop
 * and the consolidated probe), and the same call returns its contents as
 * `hangLogPaths` — which is exactly the scope a cap has. It replaced the
 * cycle-context accumulator, which lived for the whole cycle while the develop
 * gate runs up to three times (first pass, fence merge-and-retry, sibling-symbol
 * merge), so a late cap named an early call's reports and the handoff pointed the
 * operator at a file from a run that had killed nothing (#1427 round 3).
 *
 * Structural (declared here, not on the driver context) so this module keeps no
 * import edge to the context that imports it. Callers push onto the array
 * directly: the recorder that used to sit here had exactly one reader — a smoke
 * test's local variable — and an idempotence guarantee nothing calls is dead code
 * with a docstring on it (#1427 round 4).
 */
export interface GateHangPathSink {
  gateHangLogPaths?: string[];
}

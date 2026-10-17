/**
 * Offline smoke: #1427 fix round — the two directions of the handoff's hang
 * advice, and the overflow-vs-timeout gate at the seams.
 *
 * `explainVerifyTimeout` used to key its "read the process tree before
 * suspecting the diff" advice on the substring `still running:`, which the
 * failure strings NEVER contain — the clause builder emits
 * `[gate-hang] hung in no named test; …` when nothing was named, and the
 * `still running:` lines live only in the full report file. So the advice
 * printed for every hang, including one that named the stuck test, which is
 * exactly the case where the operator does not need it.
 *
 * Both directions are asserted here, plus the #1427 overflow gate: a run the
 * executor killed for OVERFLOWING its buffer is not a hang and earns no report
 * and no clause.
 *
 * Run:
 *   cd extension && bun run smoke-tests/test-gate-hang-advice.ts
 */

import { GATE_HANG_LABEL, gateHangClause, reportGateHang } from "../src/work-driver-gate-hang.ts";
import { explainVerifyTimeout } from "../src/work-driver-explain-verify.ts";
import { isTimedOutKill, timeoutWhere } from "../src/work-driver-verify-develop-helpers.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

const ADVVICE = "read it before suspecting the diff";

function stateWith(failures: string[]): WorkState {
  let s = initialState(1427, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      verifyEvidence: { step: "develop", failures, at: Date.now() },
    },
  };
  return appendEvent(s, {
    kind: "cap-hit",
    at: Date.now(),
    cap: "verify-timeout:develop",
    reviewRound: 0,
    nextStep: "handoff",
    evidence: failures.join(" | "),
  });
}

const clauseWithTest = `${"[verify-timeout]"} … ${gateHangClause({
  runningTests: ["repo::sync::tests::pull_then_fetch"],
  cmd: "cargo test",
  cwd: "/wt/a",
  timeoutMs: 600_000,
  processes: [{ pid: 1, ppid: 0, etime: "1:00", args: "cargo-test" }],
})}`;

const clauseNoTest = `${"[verify-timeout]"} … ${gateHangClause({
  runningTests: [],
  cmd: "cargo test",
  cwd: "/wt/a",
  timeoutMs: 600_000,
  processes: [{ pid: 1, ppid: 0, etime: "1:00", args: "cargo-test" }],
})}`;

// The clause's own vocabulary is what the explainer keys on — assert that
// first, or the two directions below could both pass on a stale constant.
assert(
  clauseNoTest.includes(`${GATE_HANG_LABEL} hung in no named test`),
  "clause: a run with no named test says so in the clause itself",
);
assert(
  !clauseWithTest.includes("no named test") &&
    clauseWithTest.includes("repo::sync::tests::pull_then_fetch"),
  "clause: a run whose runner flagged a test names it",
);

{
  const explained = explainVerifyTimeout("verify-timeout:develop", stateWith([clauseWithTest]));
  assert(explained.includes("[gate-hang]"), "advice: the hang report is surfaced");
  assert(
    !explained.includes(ADVVICE),
    "advice: a hang that NAMED the test gets no 'read the tree instead' lecture",
  );
}
{
  const explained = explainVerifyTimeout("verify-timeout:develop", stateWith([clauseNoTest]));
  assert(
    explained.includes(ADVVICE),
    "advice: a hang that named NOTHING tells the operator to read the process tree",
  );
}
{
  // A plain timeout with no hang clause at all gets neither line.
  const explained = explainVerifyTimeout(
    "verify-timeout:develop",
    stateWith(["[verify-timeout] verify command `x` exceeded its 10-min timeout in /wt/a"]),
  );
  assert(
    !explained.includes(ADVVICE) && !explained.includes(GATE_HANG_LABEL),
    "advice: a timeout with no report says nothing about reports",
  );
}

// ── The full report still names the test in its own section ───────────────
{
  const report = reportGateHang({
    output: "test a::b::slow has been running for over 60 seconds\nrunning 3 tests",
    cmd: "cargo test",
    cwd: "/wt/a",
    timeoutMs: 600_000,
    processes: [{ pid: 1, ppid: 0, etime: "1:00", args: "cargo-test" }],
  });
  assert(
    report.includes("still running: a::b::slow"),
    "report: the still-running section is a REPORT line, not a failure-string line",
  );
}

// ── #1427: an overflow kill is not a hang, at the seam's gate ─────────────
assert(
  isTimedOutKill({ killed: true, timedOutKill: false, overflow: "stdout" }) === false,
  "gate: an overflow kill is not a hang",
);
assert(
  isTimedOutKill({ killed: true, timedOutKill: true }) === true,
  "gate: a wall-clock kill is a hang",
);
assert(
  isTimedOutKill({ killed: true }) === true,
  "gate: a fake that predates timedOutKill is accepted on the documented shape",
);
assert(
  isTimedOutKill({ killed: true, overflow: "stderr" }) === false,
  "gate: an overflow reported without timedOutKill is still not a hang",
);
assert(isTimedOutKill({ killed: false }) === false, "gate: a run that was not killed is not one");

// An overflow run produces no clause at all: the seam calls `timeoutWhere`
// only for a hang, and a run it does not treat as hung gets the plain `where`.
{
  const overflowErr = Object.assign(new Error("maxBuffer"), {
    killed: true,
    timedOutKill: false,
    overflow: "stdout",
    stdout: "x".repeat(10),
    stderr: "",
  });
  const hung = isTimedOutKill(overflowErr);
  const where = hung ? timeoutWhere("in /wt/a", { output: "", cmd: "c", cwd: "/wt/a", timeoutMs: 1 }) : "in /wt/a";
  assert(
    !where.includes(GATE_HANG_LABEL),
    `overflow: no gate-hang clause is produced (${where})`,
  );
}

process.exit(exit);

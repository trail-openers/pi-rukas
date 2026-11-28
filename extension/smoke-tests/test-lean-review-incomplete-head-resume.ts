/**
 * smoke-tests/test-lean-review-incomplete-head-resume.ts — #2667 decision 5.
 *
 * A run whose `review` threw over a head its own gate certified is routed into the reporting
 * step, and the operator is told the head is handed back. If a RESUME of that record dispatched
 * the review again, the run would pay for a second review pass on bytes it had already handed
 * back, and the handback the operator read would stop being the run's last word. Decision 5 says
 * it must not: a resumed run does not re-review a head it already handed back as incomplete
 * without the operator's restart.
 *
 * Both records are the bytes a drive really wrote. The first is produced by driving the real
 * `runLean` (the panel's rig: real review step, real engine route, real reporting step) and
 * truncating its log at the step under test; the resume then reads those bytes back through the
 * real loader, the real fold and the real loop. Nothing about the log is typed from the table.
 *
 *   (a) a run whose log ENDS on the routed errored-review handback: resumed, it dispatches no
 *       review and no other work step, and it ends at the same handback with the same stamp;
 *   (b) the control: the same resume over a log whose review COMPLETED (the machine's own
 *       `ci + red` route to the report) behaves as it did before the feature — the review the
 *       walk already ran is not re-run either, and the run still ends handed-back.
 */

import { readFileSync } from "node:fs";
import { runLean } from "../src/lean/engine.ts";
import { handbackHeads } from "../src/lean/handback-heads.ts";
import { leanStateFile, loadRun, type Step } from "../src/lean/state.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { driveRow } from "./lib/lean-review-incomplete-head-panel.ts";
import { ISSUE } from "./lib/lean-review-incomplete-head-consts.ts";

const { assert, failures } = makeAssert();

// (a) The errored arm: drive the real chain to a finished routed handback, then resume the
// record it wrote. `readFileSync`-free by design — the resume reads the file the drive saved.
const row = await driveRow("configLoad");
assert(
  row.steps.some((s) => s.state === "review" && s.outcome?.kind === "error") &&
    row.steps.some((s) => s.state === "handback" && s.outcome?.kind === "done"),
  `precondition: the drive really ended on an errored review and its routed report (${row.steps.map((s) => `${s.state}:${s.outcome?.kind ?? "?"}`).join(",")})`,
);
const before = count(row.steps);
const counter = { started: [] as string[] };

const resumed = await runLean({
  repoRoot: row.repoRoot,
  issue: ISSUE,
  handlers: countingHandlers(counter),
  now: () => Date.now(),
  seed: { baseSha: row.steps[0]?.outcome?.baseSha ?? "", branch: `lean/issue-${String(ISSUE)}` },
});

assert(
  resumed.code === row.code && resumed.state === "handed-back",
  `(a) the resumed run ends at the same handback (code ${String(resumed.code)}, state ${resumed.state})`,
);
assert(
  resumed.run.result?.reason === row.reason,
  `(a) and carries the same reason line, not a fresh one (${JSON.stringify(resumed.run.result?.reason)})`,
);
const after = count(resumed.run.steps);
assert(
  after.review === before.review,
  `(a) a resumed run dispatched NO review for a head it already handed back (${String(before.review)} before, ${String(after.review)} after)`,
);
assert(
  after.handback === before.handback,
  `(a) and dispatched no second reporting step (${String(before.handback)} before, ${String(after.handback)} after)`,
);
for (const work of ["build", "verify", "publish", "ci", "land", "specify"] as const) {
  assert(
    after[work] === before[work],
    `(a) and started no ${work} step on resume (${String(before[work])} before, ${String(after[work])} after)`,
  );
}
assert(
  loadRun(row.repoRoot, ISSUE)?.steps.length === resumed.run.steps.length,
  "(a) the record the resume wrote is the record it read — no step appended",
);
assert(
  readFileSyncText(row.repoRoot) !== undefined,
  "(a) the state file the drive wrote is the file the resume drove from",
);

// (b) The control: a COMPLETED review over the same walk, reached through the machine's own
// route to the report. The same resume questions are asked of it, and the same answers are due:
// nothing is re-dispatched, and the run stays handed-back.
const control = await driveRow("none", { route: "to-review", reviewKind: "done" });
const cBefore = count(control.steps);
const cCounter = { started: [] as string[] };
const cResumed = await runLean({
  repoRoot: control.repoRoot,
  issue: ISSUE,
  handlers: countingHandlers(cCounter),
  now: () => Date.now(),
  seed: { baseSha: "", branch: `lean/issue-${String(ISSUE)}` },
});
const cAfter = count(cResumed.run.steps);
assert(
  cResumed.code === control.code && cResumed.state === "handed-back",
  `(b) control: a completed review's handback resumes to the same exit (code ${String(cResumed.code)}, state ${cResumed.state})`,
);
assert(
  cAfter.review === cBefore.review && cAfter.handback === cBefore.handback,
  `(b) control: and re-dispatches neither the completed review nor its report (${String(cBefore.review)}/${String(cBefore.handback)} before, ${String(cAfter.review)}/${String(cAfter.handback)} after)`,
);
assert(
  cBefore.review === 1,
  `(b) control earns its keep: the walk really ran the review step once (${String(cBefore.review)})`,
);
assert(
  counter.started.length === 0 && cCounter.started.length === 0,
  `(c) neither resume DISPATCHED a step at all (a: ${counter.started.join(",")}; b: ${cCounter.started.join(",")})`,
);

// (d) A head whose newest decided `verify` is NOT green is unchanged: nothing is recorded as
// verified, and the run does not become a handback over bytes its gate refused. The row drives
// the real walk with the gate answering red, so the record is the machine's own.
const redRow = await driveRow("budgetStop", { verifyKind: "red" });
const redHandback = redRow.steps.find((s) => s.state === "handback")?.outcome;
assert(
  redRow.steps.some((s) => s.state === "verify" && s.outcome?.kind === "red"),
  "(d) the walk's own gate really answered red",
);
assert(
  redHandback !== undefined &&
    redHandback.shippedHead === undefined &&
    redHandback.unshippedHead === undefined &&
    redHandback.shippedVerified === undefined,
  `(d) a red gate records no verified head on the handback (${JSON.stringify(redHandback)})`,
);
assert(
  redRow.code === 10 && redRow.state === "handed-back",
  `(d) and the run is still a handback, not a landing (code ${String(redRow.code)}, ${redRow.state})`,
);
assert(
  redRow.handback?.shippedVerified !== true,
  "(d) and nothing on the record claims a certified head",
);
// The rule's own finding for a refused gate, asked of the rule over the walk's own log: the red
// verdict is named as the reason nothing is verified, so the run cannot read as a handback over
// bytes its gate had already rejected. The walk's own publish record supplies the head and the
// walk's own gate the red verdict — nothing about the log is typed from the table, and the only
// edit is the review entry the machine could not route on a refused gate. Dropping the green
// condition from the rule is what this row is for: with it gone the finding is never produced.
const greenFinding = handbackHeadsRedFinding(redRow.steps);
assert(
  greenFinding.includes("not green, so no head is verified"),
  `(d) and the rule names the refused verdict as the reason nothing is verified (${JSON.stringify(greenFinding)})`,
);
assert(
  redRow.steps.filter((s) => s.state === "verify" && s.outcome?.kind === "red").length > 0,
  "(d) control: the gate verdicts the finding is built from are the walk's own red answers",
);

/**
 * The rule's finding over a walk whose newest decided `verify` is red, with the review step's own
 * record made to be the newest decided WORK step — the standing an errored review leaves, and the
 * only way to ask this question of a walk the machine turned back at the gate.
 */
function handbackHeadsRedFinding(steps: Step[]): string {
  const review = steps[steps.findIndex((s) => s.state === "publish") + 1] ?? {
    key: `${String(ISSUE)}:review:0`,
    state: "review",
    startedAt: 1,
  };
  const log = [
    ...steps,
    { ...review, state: "review", outcome: { kind: "error", message: "the review did not finish" } },
  ];
  return handbackHeads(log as Step[]).reason ?? "";
}

function count(steps: { state: string }[]): Record<string, number> {
  const out: Record<string, number> = { handback: 0 };
  for (const s of steps) out[s.state] = (out[s.state] ?? 0) + 1;
  return out;
}

/**
 * Handlers that refuse to run: a resumed run that dispatches ANY of these has started work the
 * record already settled. The counting assertions compare step counts, and these make a start
 * loud rather than silent — a re-dispatched review here would throw rather than quietly pass.
 */
function countingHandlers(counter: { started: string[] }) {
  const refuse = (name: string) => async () => {
    counter.started.push(name);
    throw new Error(`resume dispatched the ${name} step it had already settled`);
  };
  return {
    ready: refuse("ready"),
    specify: refuse("specify"),
    build: refuse("build"),
    challenge: refuse("challenge"),
    verify: refuse("verify"),
    publish: refuse("publish"),
    review: refuse("review"),
    ci: refuse("ci"),
    land: refuse("land"),
    handback: refuse("handback"),
    decline: refuse("decline"),
  };
}

/** The record on disk, as the resume's own loader sees it. */
function readFileSyncText(repoRoot: string): string | undefined {
  try {
    return readFileSync(leanStateFile(repoRoot, ISSUE), "utf8");
  } catch {
    return undefined;
  }
}

const failed = failures();
if (failed !== 0) {
  console.error("FAILED");
  process.exit(1);
}
console.log("✓ lean review-incomplete-head resume cases passed");

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
// (e) The routing never lets a head whose review did not complete reach a landing: the walk's own
// log holds no publish past the handback and no `ci` or `land` step at all, and the record's exit
// is the handback code. Route the throw to publish or ci instead of the report and these lines are
// the ones that go red — the plain stamp leaves the walk where the table had it, with no report.
assert(
  !redRow.steps.some((s) => ["ci", "land", "decline"].includes(s.state)),
  `(e) a run whose review threw dispatched no ci, no land and no decline (${redRow.steps.map((s) => s.state).join(",")})`,
);
assert(
  redRow.code === 10,
  `(e) and the run is handed back at the handback exit, not landed (code ${String(redRow.code)})`,
);
assert(
  row.steps.filter((s) => s.state === "publish").length === 1 &&
    !row.steps.some((s) => ["ci", "land"].includes(s.state)),
  `(e) the errored arm's own walk published once and never reached ci or land (${row.steps.map((s) => s.state).join(",")})`,
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
  // The base rule's own finding for a refused gate, asked of the rule where the run's newest decided
  // WORK step is a `fixed` review and the walk's own gate answered red: a red verdict is one the run
  // already paid for, and the rule must name it rather than fall back to some older green. Every
  // verdict here is the walk's own; the only record the row supplies is the review's own kind, which is
  // the standing an errored review leaves and the shape the machine could not route on a refused gate.
  const gate = [...steps].reverse().find((s) => s.state === "verify" && s.outcome !== undefined);
  return handbackHeads([
    ...steps.filter((s) => s.state !== "handback"),
    {
      key: `${String(ISSUE)}:review:0`,
      state: "review",
      startedAt: 1,
      outcome: { kind: "fixed", reason: "one fix wave" },
    },
  ] as Step[]).reason ?? `"" (the walk's newest decided gate answer was ${String(gate?.outcome?.kind)})`;
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

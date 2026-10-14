#!/usr/bin/env bun
/**
 * The `verify-failed:<step>` cap is reused by parks the outcome gate never
 * raised, and its explanation told every one of them that the gate "rejected
 * the step's done claim", that "the driver ran the checks itself (… the
 * project's verify command …)" and to set PI_ENSEMBLE_VERIFY=0. A fix pass
 * that parked on its own comment check, on a cycle whose verify command had
 * passed, was reported that way — and so was a park with no evidence at all,
 * where nothing on the state file shows a check ran.
 *
 * Covers: the explanation routes on the writer's marker, says so when the
 * reason was not recorded, and keeps the real gate's text byte-identical.
 */
import { prGoneRefusal } from "../src/work-driver-commit-reentry.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { FIX_PASS_EVIDENCE_PREFIX, PR_NOT_OPEN_MARKER } from "../src/workflow-state-cap.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const GATE_CLAIMS = [
  /outcome-verification gate rejected/,
  /the driver ran the checks itself/,
  /PI_ENSEMBLE_VERIFY=0/,
];
const claimsTheGate = (text: string) => GATE_CLAIMS.some((re) => re.test(text));

function withEvidence(
  step: "develop" | "commit-pr",
  failures: string[],
  origin?: "outcome-gate" | "fix-pass" | "pr-not-open",
): WorkState {
  const s = initialState(9001, 1000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      verifyEvidence: { step, failures, at: 2000, ...(origin ? { origin } : {}) },
    },
  };
}

// A real outcome-gate failure keeps its text exactly.
{
  const failure = "developer claimed done but every worktree has an empty diff";
  const text = explainCap("verify-failed:develop", withEvidence("develop", [failure]));
  assert(
    text ===
      `the driver's outcome-verification gate rejected the develop step's "done" claim — the claimed result is not backed by executed evidence:\n  - ${failure}\nNo LLM judged this; the driver ran the checks itself (git diff/rev-list, the project's verify command, gh pr view). Inspect the worktree(s), fix or re-dispatch, and re-run. Set PI_ENSEMBLE_VERIFY=0 to disable the gate (not recommended)`,
    `a real gate failure keeps the gate's text byte-for-byte (got: ${text})`,
  );
}

// The fix pass's own park names the fix pass, not the gate.
{
  const reason = `${FIX_PASS_EVIDENCE_PREFIX}the fix pass removed 3 origin/main comment line(s) in default and wrote no comment in their place (a.sh: # keep)`;
  const text = explainCap("verify-failed:develop", withEvidence("develop", [reason]));
  assert(text.includes(reason), "fix-pass park: the recorded reason is rendered");
  assert(
    /adversarial fix pass did not clear/.test(text),
    "fix-pass park: the lead-in names the pass",
  );
  assert(!claimsTheGate(text), `fix-pass park: no gate claim, no VERIFY=0 advice (got: ${text})`);
}

// A gate failure recorded next to a fix-pass entry is still a gate failure.
{
  const text = explainCap(
    "verify-failed:develop",
    withEvidence("develop", [`${FIX_PASS_EVIDENCE_PREFIX}noted`, "verify command exited 1"]),
  );
  assert(claimsTheGate(text), "mixed evidence: a real gate failure keeps the gate's text");
}

// Legacy (no origin): a pr-not-open marker beside a real gate failure is a
// gate failure, not a refused re-entry — the marker counts only when every
// failure carries it.
{
  const text = explainCap(
    "verify-failed:commit-pr",
    withEvidence("commit-pr", [`${PR_NOT_OPEN_MARKER} PR #7 is CLOSED`, "no PR resolves"]),
  );
  assert(
    /rejected the commit-pr step's "done" claim/.test(text) && !/no longer open/.test(text),
    `mixed evidence (pr-not-open + gate, no origin): renders the gate text (got: ${text})`,
  );
}

// Origin-tagged parks route on the origin, whatever their text says.
{
  const prText = explainCap(
    "verify-failed:commit-pr",
    withEvidence("commit-pr", ["PR #7 is CLOSED, not OPEN"], "pr-not-open"),
  );
  assert(
    /no longer open/.test(prText),
    "origin pr-not-open: routes to the refused re-entry text without a marker",
  );

  const gateText = explainCap(
    "verify-failed:develop",
    withEvidence("develop", [`${FIX_PASS_EVIDENCE_PREFIX}looks like a park`], "outcome-gate"),
  );
  assert(
    claimsTheGate(gateText),
    "origin outcome-gate: a failure that reads like a marker still renders the gate text",
  );

  const fixText = explainCap(
    "verify-failed:develop",
    withEvidence("develop", ["scope fence: touched a.ts"], "fix-pass"),
  );
  assert(
    /adversarial fix pass did not clear/.test(fixText) && !claimsTheGate(fixText),
    "origin fix-pass: routes to the fix-pass text without a marker",
  );

  const emptyGate = explainCap(
    "verify-failed:develop",
    withEvidence("develop", [], "outcome-gate"),
  );
  assert(
    /does not record the reason/.test(emptyGate) && !claimsTheGate(emptyGate),
    "origin outcome-gate with no failures: says the reason was not recorded",
  );
}

// No evidence: the text must not claim the driver ran anything.
{
  const bare = initialState(9001, 1000);
  const text = explainCap("verify-failed:develop", bare);
  assert(
    /does not record the reason/.test(text),
    "absent evidence: says the reason was not recorded",
  );
  assert(!claimsTheGate(text), `absent evidence: claims no executed check (got: ${text})`);

  const withEvent = appendEvent(bare, {
    kind: "cap-hit",
    at: 3000,
    cap: "verify-failed:develop",
    reviewRound: 0,
    nextStep: "handoff",
    evidence: "the gate wrote no failure list",
  });
  const viaEvent = explainCap("verify-failed:develop", withEvent);
  assert(
    viaEvent.includes("the gate wrote no failure list") && !claimsTheGate(viaEvent),
    "absent evidence: the cap-hit event's own evidence is quoted",
  );
  const empty = explainCap("verify-failed:develop", withEvidence("develop", []));
  assert(!claimsTheGate(empty), "empty failure list: claims no executed check");

  // Empty failures, but the cap carries the raw-output log paths: the early
  // return must not drop them (#841 renders the log path for develop caps).
  const logged = appendEvent(bare, {
    kind: "cap-hit",
    at: 3000,
    cap: "verify-failed:develop",
    reviewRound: 0,
    nextStep: "handoff",
    logPaths: ["/tmp/pi-rukas-dev/run1.log", "/tmp/pi-rukas-dev/run2.log"],
  });
  const loggedText = explainCap("verify-failed:develop", logged);
  assert(
    loggedText.includes(
      "Full raw verify output: /tmp/pi-rukas-dev/run1.log, /tmp/pi-rukas-dev/run2.log",
    ),
    `empty failures + logPaths: the log path renders (got: ${loggedText})`,
  );
  assert(
    /does not record the reason/.test(loggedText) && !claimsTheGate(loggedText),
    "empty failures + logPaths: keeps the no-reason wording, claims no executed check",
  );
}

// The commit-pr re-entry refusal, through its real writer.
{
  const { reason, haltedAfter } = prGoneRefusal(
    initialState(9001, 1000),
    7,
    "fix/issue-9001-x",
    "MERGED",
  );
  const recorded = haltedAfter.pipelineState.verifyEvidence?.failures ?? [];
  assert(
    recorded.length === 1 && recorded[0] === `${PR_NOT_OPEN_MARKER} ${reason}`,
    "PR not open: the writer leads its failure with the marker",
  );
  const text = explainCap("verify-failed:commit-pr", haltedAfter);
  assert(text.includes("PR #7 is MERGED, not OPEN"), "PR not open: the PR state is rendered");
  assert(
    !/rejected the commit-pr step's "done" claim/.test(text) && !claimsTheGate(text),
    `PR not open: no rejected-claim sentence (got: ${text})`,
  );
  // The outcome gate's own commit-pr failure is untouched.
  const gate = explainCap("verify-failed:commit-pr", withEvidence("commit-pr", ["no PR resolves"]));
  assert(
    /rejected the commit-pr step's "done" claim/.test(gate),
    "commit-pr gate failure: keeps the gate's sentence",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

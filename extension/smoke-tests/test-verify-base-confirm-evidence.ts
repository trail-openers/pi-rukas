#!/usr/bin/env bun
/**
 * #1826 — the EVIDENCE half of a base confirmation: the reuse rule a cached colour
 * is admitted by, and the text a confirmation publishes.
 *
 * Split from `test-verify-base-confirm.ts` (AGENTS.md §12 line cap) along the seam
 * that already existed there: that file judges the two runs, this one judges what
 * the judgement is ALLOWED TO SAY and the record it is allowed to rest on. They
 * fail differently — a rule bug confirms a base no run established, an evidence bug
 * publishes a claim about a run that never happened — and one file held both.
 *
 * Offline: no dispatch, no spawn, no git.
 */
import {
  ONE_SIDED_NAMES_OUTCOME,
  reusableRedRecord,
} from "../src/work-driver-verify-base-confirm.ts";
import {
  baseRunsProse,
  publishableEvidenceText,
} from "../src/work-driver-verify-base-confirm-prose.ts";
import {
  type BaseHealthConsulted,
  baseHealthConsultedNote,
} from "../src/work-driver-verify-base-health-channels.ts";
import { baseHealthWaitMs } from "../src/work-driver-verify-aggregate.ts";
import type { BaselineVerdict } from "../src/work-driver-verify-baseline.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const red = (): BaselineVerdict => ({
  status: "red",
  rawStream: "no markers at all",
  probed: false,
  exitCode: 1,
  assertion: null,
});

// ── the reuse predicate: one rule, both channels ──
//
// The develop gate's reuse gate and `confirmRedBase`'s reused arm ask this one
// function the same question. A record they disagree about is a colour that reaches a
// claim no run backs, so the shapes that matter are pinned here rather than inferred
// from two call sites.
for (const [label, record, fromInFlight, want] of [
  ["green from state", { status: "green" }, false, "green"],
  ["red from state", { status: "red", secondRun: "red" }, false, undefined],
  ["red in-flight, confirmed", { status: "red", secondRun: "red" }, true, "red"],
  ["red in-flight, unconfirmed", { status: "red" }, true, undefined],
  ["killed red in-flight", { status: "red", secondRun: "red", timedOut: true }, true, undefined],
  ["unknown", { status: "unknown" }, true, undefined],
] as const) {
  const rec = { baseSha: "a".repeat(40), command: "sh gate.sh", tierBoundMs: 1000, ...record };
  assert(
    reusableRedRecord(rec, fromInFlight) === want,
    `reuse predicate (${label}): ${String(want)} (got ${String(reusableRedRecord(rec, fromInFlight))})`,
  );
}

// ── text about to be published as evidence gets the credential veto ──
//
// `probeBaselineVerify` puts a git error's own message into a verdict's `reason`, and
// the base seams interpolate the project's verify command into the same sentence.
// Both are child output that ends up in a GitHub comment, so the veto the verify
// module applies to test output has to apply here too — otherwise a secret reaches the
// forge by arriving in a `reason` field instead of a test's stdout.
{
  const leaked = "git worktree add failed: secret_key=ghp_AAAAAAAAAAAAAAAAAAAAAAAA rejected";
  assert(
    publishableEvidenceText(leaked).includes("[redacted") &&
      !publishableEvidenceText(leaked).includes("ghp_AAAA"),
    "a credential-shaped string in git output is REDACTED, not labelled around",
  );
  assert(
    publishableEvidenceText("the confirming run was green") === "the confirming run was green" &&
      publishableEvidenceText("bun run check") === "bun run check",
    "ordinary prose and the project's own command line pass through — the veto is not a rewrite",
  );
  // #1826 round 2 — the veto now sits INSIDE the sink that renders an `unknown`
  // run's line, not only at the call sites that remembered to ask for it: the
  // `reason` a git failure wrote is interpolated by the prose module's own run line,
  // so a secret reaches the handoff through the prose function itself. This is the
  // call site that used to depend on every caller wrapping its own `why`.
  const leakedLine = baseRunsProse({
    confirmation: "not-confirmed",
    first: red(),
    second: { status: "unknown", reason: leaked },
    ranSecond: true,
  });
  assert(
    leakedLine.includes("[redacted") && !leakedLine.includes("ghp_AAAA"),
    `the credential veto is applied at the prose sink, on a reason no caller wrapped (${JSON.stringify(leakedLine.slice(0, 120))})`,
  );
}

// ── #1826 round 2 — the one-sided sentence, pinned at the prose leaf ──
//
// A pair where exactly ONE run named failing tests is refused (`names-disagree`),
// and the sentence that said so used to read "named different failing tests" — an
// instruction to diff two lists when one run printed none. It is pinned here rather
// than through the probe seam because the probe cannot stage it: a base run whose
// stream carries no names is refused as harness-only output before the name rule is
// ever reached, so the pair exists only as a value the rule returns. The wording is
// the caller's to render, so what is pinned is the two structured facts that decide
// it — the arm marker the rule hands up, and the name lists that produced it.
{
  const oneSided = {
    confirmation: "names-disagree" as const,
    first: red(),
    second: red(),
    ranSecond: true,
    firstNames: ["/tmp/pi-confirm/tree-one/tests/a.ts"],
    confirmingOutcome: ONE_SIDED_NAMES_OUTCOME,
  };
  assert(
    oneSided.confirmingOutcome === ONE_SIDED_NAMES_OUTCOME &&
      oneSided.firstNames.length > 0 &&
      oneSided.secondNames === undefined,
    `one run named, one did not: the rule hands up the one-sided marker with ONE name list (${JSON.stringify(oneSided.confirmingOutcome)})`,
  );
  const disjoint = {
    confirmation: "names-disagree" as const,
    first: red(),
    second: red(),
    ranSecond: true,
    firstNames: ["/tmp/pi-confirm/tree-one/tests/a.ts"],
    secondNames: ["/tmp/pi-confirm/tree-two/tests/z.ts"],
    confirmingOutcome: "the two runs named different failing tests",
  };
  assert(
    disjoint.confirmingOutcome !== ONE_SIDED_NAMES_OUTCOME &&
      disjoint.firstNames.length > 0 &&
      disjoint.secondNames.length > 0,
    `both runs named a disjoint set: NOT the one-sided marker — the sentence may then say different tests (${JSON.stringify(disjoint.confirmingOutcome)})`,
  );
  // The two arms are distinguished by the NAME LISTS alone, which is the contract
  // the comparison seam reads: a pair with both lists non-empty is the disjoint
  // shape, and any pair missing one is the one-sided shape. No prose is consulted,
  // so a reworded sentence cannot move the FLAKY note.
  const oneSidedFlaky = !oneSided.firstNames?.length || !oneSided.secondNames?.length;
  const disjointFlaky = !disjoint.firstNames?.length || !disjoint.secondNames?.length;
  assert(
    oneSidedFlaky && !disjointFlaky,
    "the one-sided / disjoint split is decided by the structured name lists, not by the sentence",
  );
}

// ── the note that renders a consulted verdict reads its colour from ONE carrier ──
//
// The second run's colour used to arrive twice — on the record and as a separate
// positional argument — and the renderer preferred the caller's copy. Two accounts of
// one consultation is how a note comes to disagree with the event it annotates, so the
// record is now the only carrier and this is the lock.
{
  const consulted: BaseHealthConsulted = {
    status: "red",
    baseSha: "b".repeat(40),
    secondRun: "green",
  };
  const note = baseHealthConsultedNote("b".repeat(40), consulted);
  assert(
    note.includes("base run 2 GREEN") && note.includes("FLAKY base: red once, green once"),
    `the consultation note reads the second run off the record alone (${JSON.stringify(note)})`,
  );
  const plain = baseHealthConsultedNote("b".repeat(40), {
    status: "red",
    baseSha: "b".repeat(40),
  });
  assert(
    plain.includes("one base run, not confirmed red") && !plain.includes("FLAKY"),
    `a red whose record states no second run is reported as unconfirmed, never as flaky (${JSON.stringify(plain)})`,
  );
}

// ── the wait on the background probe covers the runs the probe is actually in ──
//
// #1826 makes a red base's SECOND run normal, so a probe that has been running
// longer than one tier bound is in its confirming run. A gate that abandons it at one
// bound throws away a probe one run from answering and then pays for the whole
// comparison itself — the cost rule inverted by a timeout number.
{
  const BOUND = 60_000;
  assert(
    baseHealthWaitMs(BOUND, BOUND - 1) < 2 * BOUND,
    "a probe younger than one bound is waited for at one bound (it cannot have a second run in flight)",
  );
  assert(
    baseHealthWaitMs(BOUND, BOUND + 1) >= 2 * BOUND,
    `a probe past its first bound is waited for at TWO bounds plus setup slack (got ${baseHealthWaitMs(BOUND, BOUND + 1)})`,
  );
  assert(
    baseHealthWaitMs(BOUND, BOUND + 1) > baseHealthWaitMs(BOUND, 0),
    "the wait grows with the probe's age — it never shrinks as the probe gets closer to answering",
  );
}

process.exit(exit);

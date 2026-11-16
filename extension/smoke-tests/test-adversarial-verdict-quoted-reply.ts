#!/usr/bin/env bun
/**
 * #2312 — the loop must not approve a round whose reviewer objected.
 *
 * The incident, in full: job mwj6am6d-8ve1rl, a non-reportOnly adversarial_loop
 * on PR #2304. Round 2's reviewer filed an `### ISSUES` section, wrote
 * `VERDICT: ISSUES_FOUND`, and then, under `### TESTED SCENARIOS`, quoted
 * `VERDICT: APPROVED` as the example it had been checking. `parseVerdict` asked
 * the whole-reply reader what verdict the text contained, that reader takes the
 * LAST match anywhere in the string, and the quotation was last. The loop
 * printed "Adversarial APPROVED after round 2.", wrote a `passed:true` ledger
 * row, and stopped. Nothing logged the misread: the header and the row were the
 * only operator-visible artefacts, and both said the review had passed.
 *
 * A unit assertion on `parseVerdict` would not have caught this class. The bug
 * was not that the parser misreported a string — it was that a *specific* reply
 * shape, at a *specific* round, took the loop's pass branch. So this drives the
 * real `runAdversarialLoop` with a per-round reply script and asserts what the
 * loop did with the incident's own bytes: round 2 routes to a fix round, and no
 * round reports an approval it did not earn.
 *
 * The reply script is the loop's own sequence: a blocking round 1 (so a fix pass
 * really runs and round 3 is reachable), the incident fixture as round 2, and a
 * clean approval as round 3. Under the misread, round 2 was the last round the
 * loop ever ran.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { BLOCK_THEN_APPROVE, stubAdversarialChildren } from "./lib/classic-caller-harness.ts";
// The harness mocks `adversarial-ledger.ts`'s writer, so this run never touches
// the real per-clone ledger; the isolation is named HERE as well because #1069's
// static scan reads THIS file for a marker, and the exposure — a loop driven at
// `process.cwd()`, which in a worktree is the real clone — is this test's.
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

const isolation = isolateLedger();

let exit = 0;
function assert(cond: boolean, msg: string, actual?: unknown): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    if (actual !== undefined) console.error(`   actual: ${JSON.stringify(actual)}`);
    exit = 1;
  }
}

// Installed before the loop is imported: `mock.module` only takes effect for
// later imports, and a mock installed after the real module was awaited leaves
// the real spawn in place — the "mock" then tries to run `pi`.
const children = await stubAdversarialChildren();
const { runAdversarialLoop } = await import("../src/adversarial.ts");

const DIFF = "diff --git a/a.ts b/a.ts\n+export const draw = () => 1;\n";

/** The reviewer's round-2 reply, read off disk rather than retyped: a fixture
 *  copied into the test body drifts from the incident, and the whole value of
 *  this suite is that its input is the bytes that caused the misread. */
const INCIDENT = readFileSync(
  path.join(import.meta.dirname, "fixtures", "adversarial-replies", "incident-2304-round2.txt"),
  "utf8",
);

assert(
  INCIDENT.includes("VERDICT: ISSUES_FOUND") && INCIDENT.includes("`VERDICT: APPROVED`"),
  "the fixture carries both the real verdict and the quoted one that out-ranked it",
);

// The pre-fix whole-reply read, reconstructed here so the test can say what it
// is actually refuting: of the two verdict strings in the fixture, the LAST one
// in the text is the quotation. If that ever stops being true the fixture has
// drifted and the arms below prove nothing.
const lastWholeReplyMatch = [
  ...INCIDENT.matchAll(
    /VERDICT\s*:?\s*\**\s*:?\s*(CRITICAL_ISSUES_FOUND|ISSUES_FOUND|MINOR_OBSERVATIONS|APPROVED)\b/gi,
  ),
].pop();
assert(
  lastWholeReplyMatch?.[1]?.toUpperCase() === "APPROVED",
  "canary: the whole-reply reader's last match in the fixture is APPROVED — this is the misread, reproduced from the fixture's own bytes",
  lastWholeReplyMatch?.[1],
);

// The child queue is consumed per dispatch and EMPTY means the stub answers
// `VERDICT: APPROVED` (see lib/classic-caller-harness.ts), so a script that
// wants round 1 to block must say so explicitly: a one-entry script that the
// first round consumes would have round 2 approved by the default, and this
// suite's central assertion would be checking a reply nobody queued.
const BLOCKING_ROUND_1 = "VERDICT: ISSUES_FOUND\n\n### ISSUES\n- a.ts:1 — the draw is not guarded";
const APPROVING = "VERDICT: APPROVED";

children.setReplies({
  reviewers: [BLOCKING_ROUND_1, INCIDENT, APPROVING],
  developers: ["guarded the draw", "addressed both findings"],
});

const result = await runAdversarialLoop(
  {
    diff: DIFF,
    context: "#2312 incident",
    workCwd: process.cwd(),
    branch: "feature/2312",
  } as never,
  new AbortController().signal,
  "job-2312-incident",
);

// ── (1) the round the loop got wrong, judged from the loop's own records ─────
//
// `adversarialRounds` is the per-round account the loop carries out — the same
// records the lean gate reads and the ledger row is derived from, so asserting
// here is asserting on what the driver actually believes happened, not on prose.
const rounds = result.adversarialRounds ?? [];
assert(rounds.length === 3, `all three rounds ran (got ${String(rounds.length)})`, rounds);
assert(
  rounds[1]?.round === 2 &&
    rounds[1]?.status === "ISSUES_FOUND" &&
    rounds[1]?.verdictParsed === true,
  "canary: round 2 of the incident reply is ISSUES_FOUND with a PARSED verdict — not APPROVED, and not the no-verdict default",
  rounds[1],
);

// ── (2) the misread's signature is gone from the operator's view ─────────────
//
// `passedRoundText` is the only place the string "Adversarial APPROVED" is
// produced, and it is produced exactly when a round takes the pass branch. A
// round-2 header is therefore proof the loop approved the review that objected.
assert(
  !result.text.includes("Adversarial APPROVED after round 2"),
  "no round-2 'Adversarial APPROVED' header — the header that a misread prints and nothing else writes",
  result.text.slice(0, 200),
);
assert(
  !result.text.includes("PASSED WITH FINDINGS after round 2"),
  "…nor a round-2 'PASSED WITH FINDINGS' header, which is the other pass-branch wording",
);

// ── (3) the loop kept working instead of stopping ────────────────────────────
//
// A blocking verdict mid-loop earns a fix round. The two assertions below are
// the behavioural half: the loop dispatched a second fixer and reached round 3,
// which is only possible if round 2 did not take the pass branch.
const reviewerDispatches = children.prompts.filter((p) => p.role === "adversarial-developer");
const fixDispatches = children.prompts.filter((p) => p.role === "developer");
assert(
  reviewerDispatches.length === 3,
  `the reviewer ran three rounds (${String(reviewerDispatches.length)})`,
);
assert(
  fixDispatches.length === 2,
  `a fix pass ran after EACH blocking round (${String(fixDispatches.length)})`,
);
assert(
  fixDispatches[1]?.prompt.includes("Silent failure on the ledger write"),
  "the round-3 fixer carried round 2's finding — the reply's objections reached the developer, not just the log",
);

// ── (4) the pre-fix shape is still refused, and the loop still passes cleanly ─
//
// Guards against the over-correction: making the reader refuse quotations must
// not make the loop unable to read a plain verdict at all, or every review would
// now die as `incomplete` — the failure this file's own issue calls the mirror of
// the bug it fixes.
{
  children.setReplies({
    reviewers: [BLOCKING_ROUND_1, APPROVING],
    developers: ["guarded the draw"],
  });
  const clean = await runAdversarialLoop(
    {
      diff: DIFF,
      context: "clean after fix",
      workCwd: process.cwd(),
      branch: "feature/2312-clean",
    } as never,
    new AbortController().signal,
    "job-2312-clean",
  );
  assert(
    clean.loopOutcome === "approved" && clean.ok,
    `a plain VERDICT: APPROVED still passes the loop (got ${String(clean.loopOutcome)})`,
  );
  assert(
    clean.text.includes("Adversarial APPROVED after round 2"),
    "…through the same header, so the header is not forbidden — only unearned",
  );
}

{
  // A reviewer that quotes a verdict and never signs one is unreadable, and an
  // unreadable reply is infrastructure, never an approval. This is the direction
  // a naive "exclude the quoted line" fix gets wrong: it leaves the reply with no
  // candidate, and a no-candidate reply must not pass.
  // The same unreadable reply on all three rounds: the queue must be the reply
  // THREE times, because an empty queue makes the stub answer `VERDICT: APPROVED`
  // and the loop would then be reading a verdict this arm never queued — which is
  // how a scripted test comes to assert on a reply that does not exist.
  const quotedReply = [
    "### ISSUES",
    "- x.ts:1 — the ledger row can be lost",
    "",
    "The closing line would read `VERDICT: APPROVED` if I approved.",
    "",
    "```text",
    "VERDICT: APPROVED",
    "```",
  ].join("\n");
  children.setReplies({
    reviewers: [quotedReply, quotedReply, quotedReply],
    developers: ["fixed", "fixed again"],
  });
  const quoted = await runAdversarialLoop(
    {
      diff: DIFF,
      context: "quoted only",
      workCwd: process.cwd(),
      branch: "feature/2312-quoted",
    } as never,
    new AbortController().signal,
    "job-2312-quoted",
  );
  assert(
    quoted.loopOutcome !== "approved",
    `a reply whose only verdict lines are quoted never approves (got ${String(quoted.loopOutcome)})`,
  );
  assert(
    (quoted.adversarialRounds ?? []).every((r) => r.verdictParsed === false),
    "…and every round records that no verdict was parsed",
    quoted.adversarialRounds,
  );
  assert(
    !quoted.text.includes("Adversarial APPROVED"),
    "…with no approval header anywhere in the result",
  );
}

console.log(`\nexit ${exit}`);
isolation();
process.exit(exit);

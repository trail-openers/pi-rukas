#!/usr/bin/env bun
/**
 * lean: the verified handback (#2242) — the RULE, i.e. which step log says a
 * handback is standing over unverified bytes, and which head it should ship.
 *
 * The defect: a `review` step whose fix wave pushed leaves origin holding bytes no
 * `verify` ever certified, because the table routes `review:fixed` into a
 * re-verification a run that ended before it never ran. The rule therefore reads
 * the LOG, not the stop cause — how the run got to `handback` (deadline, step cap,
 * a handler that threw) changes nothing about what origin holds. So these cases
 * construct the log and drive `handbackHeads` directly; driving the engine's
 * deadline or killing a child mid-replay would test the engine's routing, which
 * `test-lean-engine-review-reverify.ts` and the deadline files own.
 *
 *   (a) the rule over a driven log: a `fixed` review newer than the newest decided
 *       green → applies, and ships that green's head;
 *   (b) a `verify` decided AFTER the fix wave → the run's own gate already spoke for
 *       the head, so the rule is silent;
 *   (c) `review:done` → no fix wave, nothing unverified, silent;
 *   (d) no green `verify`: the rule applies and says there is no verified head,
 *       rather than shipping a head it never saw — three different silences, three
 *       different answers: (d1) the gate was entered and never answered, (d2) a green
 *       that named no head, (d3) no gate step at all.
 *
 * What the step RECORDS and PRINTS from the rule's answer is
 * `test-lean-verified-handback-report.ts`; what the rewind leaves origin holding is
 * `test-lean-verified-handback-rewind.ts`. All three drive the one rig
 * (lib/lean-verified-handback-fixture), whose logs are written by the engine rather
 * than typed by hand — a hand-written array is a guess about what a drive writes.
 */

import { rmSync } from "node:fs";
import { handbackHeads } from "../src/lean/handback-heads.ts";
import {
  FAKE_VERIFIED,
  ROOTS,
  fixedReviewLog,
  reverifiedLog,
  reviewDoneLog,
  unaskedGateReviewLog,
  undecidedFixLog,
  unverifiedFixLog,
} from "./lib/lean-verified-handback-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── (a) a `fixed` review newer than the newest decided green ───────────────
{
  const steps = await fixedReviewLog();
  const heads = handbackHeads(steps);
  assert(heads.applies, "(a) the rule applies to a log whose newest work step is review:fixed");
  assert(
    heads.verifiedHead === FAKE_VERIFIED,
    `(a) the head it ships is the green verify's own head (${String(heads.verifiedHead)})`,
  );
  assert(
    heads.reason === undefined,
    `(a) there is no reason when a verified head exists (${String(heads.reason)})`,
  );
}

// ── (b) a verify decided AFTER the fix wave speaks for the head ─────────────
{
  const steps = await reverifiedLog();
  const heads = handbackHeads(steps);
  assert(
    !heads.applies,
    `(b) a log whose newest work step is a decided verify is not the rule's (${JSON.stringify(heads)})`,
  );
}

// ── (c) review:done left nothing unverified ─────────────────────────────────
{
  const steps = await reviewDoneLog();
  const heads = handbackHeads(steps);
  assert(
    !heads.applies,
    `(c) a clean review (done, no fix wave) does not trigger the rule (${JSON.stringify(heads)})`,
  );
}

// ── (d) no verified head: three different silences, three different answers ─
{
  // (d1) the gate was ENTERED and never answered. The routing green stays — a run
  // reaches a review only through a decided gate — and the re-verification the table
  // routes the `fixed` review into is appended as the engine would have written it,
  // then left undecided: the log of a run stopped inside that second gate visit.
  const steps = await undecidedFixLog();
  const verifies = steps.filter((s) => s.state === "verify");
  assert(verifies.length > 1, `(d1) the log carries more than one gate step (${verifies.length})`);
  assert(
    verifies.slice(1).every((s) => s.outcome === undefined),
    "(d1) and every gate after the routing green decided nothing",
  );
  assert(
    verifies[0]?.outcome?.kind === "green",
    `(d1) the routing green itself did decide (${String(verifies[0]?.outcome?.kind)})`,
  );
  const entered = handbackHeads(steps);
  assert(entered.applies, "(d1) the rule applies to a handback over an unfinished gate");
  assert(
    entered.verifiedHead === undefined,
    `(d1) and names no head it cannot verify (${String(entered.verifiedHead)})`,
  );
  assert(
    (entered.reason ?? "").includes("never recorded what it decided"),
    `(d1) the reason says the gate was entered and unanswered (${String(entered.reason)})`,
  );
  // What the refusal turns on: the unfinished visit is the NEWEST gate step in the
  // log, ahead of the green the rule must not fall back to.
  assert(
    verifies[verifies.length - 1]?.outcome === undefined,
    "(d1) the newest gate step of the log is the unfinished one",
  );
}
{
  // (d2) the gate answered and named no head — a `green` whose verdict is silent
  // about the bytes it looked at. Same refusal, different sentence: the rule read an
  // answer, and the answer was incomplete.
  const steps = await unverifiedFixLog();
  const heads = handbackHeads(steps);
  assert(heads.applies, "(d2) the rule applies to a green that named no head");
  assert(
    heads.verifiedHead === undefined,
    `(d2) and names no head it cannot verify (${String(heads.verifiedHead)})`,
  );
  assert(
    (heads.reason ?? "").includes("recorded no head"),
    `(d2) the reason says the green named no head (${String(heads.reason)})`,
  );
}
{
  // (d3) the gate never ran at all over a `fixed` review: nothing in the log to read.
  const steps = unaskedGateReviewLog();
  assert(
    steps.every((s) => s.state !== "verify"),
    "(d3) the log holds no gate step",
  );
  const heads = handbackHeads(steps);
  assert(heads.applies, "(d3) the rule applies with no green verify at all");
  assert(
    heads.verifiedHead === undefined,
    `(d3) it names no head it cannot verify (${String(heads.verifiedHead)})`,
  );
  assert(
    (heads.reason ?? "").includes("no verify step of this run decided anything"),
    `(d3) the reason says no verify of this run decided anything (${String(heads.reason)})`,
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
process.exit(exit);

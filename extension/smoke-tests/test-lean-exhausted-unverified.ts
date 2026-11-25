#!/usr/bin/env bun
/**
 * lean: `build + exhausted` with no verified head (#2617) — the table's arms, the handback that follows an
 * unverified publish, and the cause readers over that log.
 *
 * The defect: a run whose builder came back with an empty change set, on a log where its own gate had never
 * gone green, was routed to `publish`. The arm's comment read "no draft means the code was green", which is
 * only a fact about a run that ever ASKED its gate. Such a run opened a draft PR, died at the review's
 * refusal, and the handback that followed said nothing about the head standing on origin unverified.
 *
 *   (a) no decided verify at all → hand back at once, the round billed, the draft counter set, so the run
 *       never reaches `publish` and cannot reach `land`;
 *   (a2) a decided verify that is NOT green → the same hand back: the publish arm is the green arm alone;
 *   (b) a decided GREEN verify → still publishes a draft, as before;
 *   (c) the rule and the reporting step over a driven log whose publish pushed a head no green of this run
 *       covers: `Shipped head: <sha> (NOT verified)` printed from the publish step's own record, origin
 *       unreadable, and NO rewind; the record carries `shippedHead` + `shippedVerified: false` with neither
 *       `unshippedHead` nor `unshippedReason`;
 *   (c2) the same log with a green that DOES cover that head: silent;
 *   (e/e2) the cause readers still name the exhausted round over a log whose newest work step is that build;
 *   (g) the host's projection reads the arm's head off the handback step's own record.
 *
 * The logs come from real drives (lib/lean-exhausted-fixture), cut at the step each case is about.
 */

import { handbackHeads } from "../src/lean/handback-heads.ts";
import { handbackOutcome, neededFromLog } from "../src/lean/handback.ts";
import { leanGates } from "../src/headless/work-lean-gates.ts";
import { MAX_BUILD_ATTEMPTS, next } from "../src/lean/machine.ts";
import {
  INITIAL_COUNTERS,
  type LeanRun,
  type LeanState,
  type Outcome,
  type Step,
} from "../src/lean/state.ts";
import {
  EXHAUSTED,
  ISSUE,
  PUBLISHED,
  cleanupExhausted,
  ctxFor,
  greenCertified,
  publishStep,
  redVerify,
  seedRun,
  walkNoVerify,
} from "./lib/lean-exhausted-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function run(state: LeanState, steps: Step[] = [], counters: LeanRun["counters"] = { ...INITIAL_COUNTERS }): LeanRun {
  return { ...seedRun(), state, counters, steps };
}

/** A decided step for a hand-assembled log, keyed the way the engine keys its attempts. */
function decided(state: LeanState, outcome: Outcome, n = 0): Step {
  return { key: `${String(ISSUE)}:${state}:${String(n)}`, state, startedAt: 1, endedAt: 2, outcome };
}

// ── (a) no decided verify: hand back at once, billed, drafted ──────────────
{
  const moved = next(run("build"), { kind: "exhausted" });
  assert(
    moved.state === "handback",
    `(a) build exhausted with no verify in the log hands back instead of publishing (got ${moved.state})`,
  );
  assert(
    moved.counters.buildAttempts === 1,
    `(a) the hand back still bills the round the builder was dispatched for (got ${moved.counters.buildAttempts})`,
  );
  assert(
    moved.counters.draft === true,
    `(a) and sets the draft counter, which is what keeps the run out of land (got ${String(moved.counters.draft)})`,
  );
}

// ── (a2) a decided verify that is not green: the same hand back ────────────
{
  const afterRed = next(run("build", [decided("verify", redVerify())]), { kind: "exhausted" });
  assert(
    afterRed.state === "handback",
    `(a2) build exhausted after a RED verify hands back too — the publish arm is the green arm alone (got ${afterRed.state})`,
  );
  assert(
    afterRed.counters.buildAttempts === 1 && afterRed.counters.draft === true,
    `(a2) billed and drafted like the never-asked arm (${afterRed.counters.buildAttempts}/${String(afterRed.counters.draft)})`,
  );
}

// ── (b) a decided green verify: the draft publish stays ────────────────────
{
  const afterGreen = next(run("build", [decided("verify", greenCertified())]), {
    kind: "exhausted",
  });
  assert(
    afterGreen.state === "publish" && afterGreen.counters.draft === true,
    `(b) build exhausted after a decided GREEN verify still publishes a draft (got ${afterGreen.state}/${String(afterGreen.counters.draft)})`,
  );
  assert(
    afterGreen.counters.buildAttempts === 1,
    `(b) and still bills exactly one round (got ${afterGreen.counters.buildAttempts})`,
  );
  assert(
    next(run("build", [], { ...INITIAL_COUNTERS, draft: true }), { kind: "exhausted" }).state ===
      "handback",
    "(b) control: the red-marker arm still hands back, unchanged",
  );
}

// ── (c) the handback over an unverified draft publish ──────────────────────
{
  const walked = await walkNoVerify();
  const steps = [...walked, publishStep(PUBLISHED)];
  const heads = handbackHeads(steps);
  assert(
    heads.applies === true,
    `(c) the rule speaks for a handback whose newest work step is a draft publish (got ${JSON.stringify(heads)})`,
  );
  assert(
    heads.shippedHead === PUBLISHED && heads.shippedVerified === false,
    `(c) and names the publish step's own head, unverified (${JSON.stringify([heads.shippedHead, heads.shippedVerified])})`,
  );
  assert(
    heads.reason === undefined,
    `(c) with no reason of its own to print beside it (${String(heads.reason)})`,
  );

  const posts: string[] = [];
  let rewinds = 0;
  const outcome = await handbackOutcome(
    ctxFor(steps),
    async (_repo, _issue, body) => {
      posts.push(body);
    },
    async () => {
      rewinds++;
      return { shipped: false };
    },
    // Origin unreadable: the line must still print, because it comes from the step's own record.
    async () => undefined,
  );
  const body = posts[0] ?? "";
  assert(
    outcome.kind === "done" && outcome.posted === true,
    `(c) the handback posts and ends the run (${JSON.stringify([outcome.kind, outcome.posted])})`,
  );
  assert(
    body.includes(`Shipped head: \`${PUBLISHED}\` (NOT verified)`),
    `(c) the comment prints the unverified head from the publish step's own record, with origin unreadable (${JSON.stringify(body.split("\n").find((l) => l.startsWith("Shipped head")) ?? "<none>")})`,
  );
  assert(
    !body.includes("Unshipped head:") && !body.includes("Why nothing was moved:"),
    `(c) and names no head it displaced and no rewind that never ran (${JSON.stringify(body.split("\n").slice(3, 7))})`,
  );
  assert(rewinds === 0, `(c) the draft-publish arm takes no rewind — nothing moved (${rewinds})`);
  assert(
    outcome.shippedHead === PUBLISHED && outcome.shippedVerified === false,
    `(c) the record carries shippedHead + shippedVerified: false (${JSON.stringify([outcome.shippedHead, outcome.shippedVerified])})`,
  );
  assert(
    outcome.unshippedHead === undefined && outcome.unshippedReason === undefined,
    `(c) and neither unshipped field, because nothing moved (${JSON.stringify([outcome.unshippedHead, outcome.unshippedReason])})`,
  );
}

// ── (c2) a publish whose head a decided green covers: silent ───────────────
{
  // The ordinary shape — the gate cleared the head its own publish pushed — assembled from the driven log
  // with a covering green under the publish, because the defect is a run whose gate never cleared anything
  // and a green run never reaches the empty round at all.
  const walked = await walkNoVerify();
  const green: Step = {
    key: `${String(ISSUE)}:verify:green`,
    state: "verify",
    startedAt: 18,
    endedAt: 19,
    outcome: { kind: "green", verifiedHead: PUBLISHED, reason: `all frozen tests green at ${PUBLISHED}` },
  };
  const steps: Step[] = [...walked, green, publishStep(PUBLISHED)];
  assert(
    !handbackHeads(steps).applies,
    `(c2) a draft publish a decided green of this run covers is not the rule's (${JSON.stringify(handbackHeads(steps))})`,
  );
  const uncovered = handbackHeads([...walked, publishStep(PUBLISHED)]);
  assert(
    uncovered.applies === true && uncovered.shippedHead === PUBLISHED,
    `(c2) the same publish of a head no green of this run names IS the rule (${JSON.stringify(uncovered)})`,
  );
  // A green naming a DIFFERENT head does not cover it either — "covers" binds the head, not just the kind.
  const otherGreen: Step = {
    ...green,
    outcome: { kind: "green", verifiedHead: "a".repeat(40), reason: "green at another head" },
  };
  const wrongHead = handbackHeads([...walked, otherGreen, publishStep(PUBLISHED)]);
  assert(
    wrongHead.applies === true && wrongHead.shippedHead === PUBLISHED,
    `(c2) a green of a different head does not cover the published one (${JSON.stringify(wrongHead)})`,
  );
}

// ── (e) the cause readers still name the exhausted round ──────────────────
{
  // The hand-back's own record is what the reader reads: the exhausted build sits in the log with its
  // verdict, and the reporting step is newer — a report never hides the work it reports (the rule
  // `test-lean-handback-cause.ts` pins for the other causes).
  const capped = `${EXHAUSTED.reason ?? ""} after ${String(MAX_BUILD_ATTEMPTS)} build attempts`;
  const log = [
    // The gate spoke, and what the operator still needs to know is the round that produced nothing.
    decided("verify", { kind: "red", reason: "AC1 exited 1" }, 0),
    decided("build", { ...EXHAUSTED, reason: capped }),
    decided("handback", { kind: "done", reason: "handback comment posted" }, 0),
  ];
  const needed = neededFromLog(log);
  assert(
    needed.includes("the developer produced no change"),
    `(e) the cause over a log whose newest work step is the exhausted build names the empty round (got ${needed})`,
  );
  assert(
    needed.includes(`after ${String(MAX_BUILD_ATTEMPTS)} build attempts`),
    `(e) and keeps the round count the step itself recorded (got ${needed})`,
  );
}

// ── (e2) the cause names the empty round once the hand-back reports it ─────
{
  // The exhausted round, with the hand-back's own step on top of it: the record the operator reads. That the
  // run reaches the hand-back at all, rather than dying at a gate nobody built, is the fix.
  const walked = await walkNoVerify();
  const posts: string[] = [];
  await handbackOutcome(
    ctxFor(walked),
    async (_repo, _issue, body) => {
      posts.push(body);
    },
    async () => ({ shipped: false }),
    async () => undefined,
  );
  const body = posts[0] ?? "";
  assert(
    body.includes("the developer produced no change"),
    `(e2) the hand-back names the empty round the table handed back for (${JSON.stringify(body.split("\n").slice(2, 5))})`,
  );
  const reported = neededFromLog([...walked, decided("handback", { kind: "done" }, 0)]);
  assert(
    reported.includes("the developer produced no change"),
    `(e2) once the hand-back reports it, the cause is still the empty round (got ${reported})`,
  );
}

// ── (e3) a log whose gate never decided, and nothing else to quote ─────────
{
  // The cause readers' hardest log: no verdict anywhere but the empty round, so the comment has only the
  // builder's own account to name. The head rule is what noticed the gate never spoke; this pins that the
  // readers of the retired duplicate helper still answer over that log.
  const log = [
    decided("build", { ...EXHAUSTED, reason: "the developer produced no change" }),
    decided("handback", { kind: "done", reason: "handback comment posted" }, 0),
  ];
  assert(
    neededFromLog(log).includes("the developer produced no change"),
    `(e3) the cause over a log with no gate verdict at all still names the empty round (got ${neededFromLog(log)})`,
  );
  assert(
    handbackHeads(log.slice(0, 1)).applies === false,
    "(e3) and the head rule stays silent for a log whose newest work step is the build itself",
  );
}

// ── (g) the gates projection speaks the draft-publish arm's head ──────────
{
  // The host reads this run through `gates.handback`, so the fields the arm records have to be what that
  // projection prints — an uncertified head reads `verified: false`, not the gate's silence.
  const walked = await walkNoVerify();
  const steps = [...walked, publishStep(PUBLISHED)];
  const outcome = await handbackOutcome(
    ctxFor(steps),
    async () => undefined,
    async () => ({ shipped: false }),
    async () => undefined,
  );
  const gates = leanGates([...steps, decided("handback", outcome, 0)], (s) => s);
  const h = gates.handback;
  assert(
    h.head === PUBLISHED && h.verified === false,
    `(g) gates.handback reads the unverified head off the handback step's own record (${JSON.stringify([h.head, h.verified])})`,
  );
  assert(
    h.unshipped === null,
    `(g) and nothing displaced, because the arm moved nothing (${JSON.stringify(h.unshipped)})`,
  );
}

cleanupExhausted();
process.exit(exit);

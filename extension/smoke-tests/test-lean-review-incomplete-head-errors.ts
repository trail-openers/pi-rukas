/**
 * smoke-tests/test-lean-review-incomplete-head-errors.ts — what the errored-review arm must
 * NOT speak for, and what it must (#2667).
 *
 * The head rule reads the gate's newest DECIDED verdict, and one line keeps a run the gate never
 * certified out of the reporting step: a `verify` that was not green, or a gate that never
 * answered, makes the errored arm `{applies: false}`, so the run keeps the bare engine stamp it
 * had before the knob existed. Delete that line and every test in the repo still passes. The
 * panel's red and undecided rows walk a machine that turns back at the gate and never routes to
 * the review, so they assert the BASE rule's wording through the `fixed` standing those rows have
 * to script. The rows here stand where that machine cannot walk: the newest decided WORK step is
 * an `error` `review` (its kind and message are the engine's own `errorOutcome`), and the gate
 * behind it is the walk's own red, a green that named no commit, or a walk that never let the gate
 * decide. Three questions per shape: the rule must refuse the head, the routing must refuse the
 * report, and the run must end as the plain stamp ends it.
 *
 * Each log is a real drive's log (`driveRow`); the only record a row supplies is that one review
 * entry. The green-with-head control beside them is what makes the set an answer and not a blanket
 * refusal: on that same walk the rule names the head, the routing admits the report, and the
 * reporting step's NEEDING line says the review did not complete exactly once, with the throw's own
 * reason after it.
 */

import { neededFromLog } from "../src/lean/handback.ts";
import { handbackHeads } from "../src/lean/handback-heads.ts";
import { reportRouteFor } from "../src/lean-report-route.ts";
import type { Step } from "../src/lean/state.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  driveRow,
  erroredReviewOver,
  panelWalk,
} from "./lib/lean-review-incomplete-head-panel.ts";

const { assert, failures } = makeAssert();

/** The throw the rows stand the review on: one message, so a row's expectation is one string. */
const THROWN = "the review child died before pass 1 judged anything";

/**
 * The three shapes a gate leaves when it certified nothing, and what each one owes the operator.
 *
 * `silent` is whether the errored arm must answer `{applies: false}` outright (a gate that decided
 * red, or never decided: the run never had a certified head to owe anyone), or whether it owes the
 * comment with no head at all (a green that NAMED no commit: it speaks, ships no head, asks for no
 * rewind, and its NEEDING line is the run's own sentence). `needed` is the clause the comment must
 * land on, from a verdict the walk really recorded.
 */
const refused: {
  name: string;
  verifyKind: "red" | "headless" | "undecided";
  /** The base rule's own words for the gate's refusal, which the silent errored arm must not eat. */
  why: string;
  /** Whether the head rule answers `{applies: false}` outright, or only refuses to name a head. */
  silent: boolean;
  /** A clause the NEEDING line must carry, from a verdict the walk really recorded. */
  needed: string;
}[] = [
  {
    name: "a RED newest verify",
    verifyKind: "red",
    why: "the newest decided verify is red, not green, so no head is verified",
    route: true,
    silent: true,
    needed: "AC1 exited 1",
  },
  {
    name: "a GREEN verify that named no commit",
    verifyKind: "headless",
    why: "the green verify recorded no head, so there is no verified head to ship",
    route: true,
    silent: false,
    needed: "all frozen tests green at an unnamed commit",
  },
  {
    name: "no decided verify at all",
    verifyKind: "undecided",
    why: "the newest decided verify is red, not green, so no head is verified",
    route: true,
    silent: true,
    needed: "AC1 exited 1",
  },
];

/**
 * The rule and the routing, both asked of the one log a row built.
 *
 * The routing's errored arm consults the head rule, so the two cannot disagree about a certified
 * head by construction; asking both is what stops a row from passing on the premise the routing
 * takes and never noticing the rule stopped answering.
 */
function readLog(log: Step[]): {
  newest: Step;
  applies: boolean;
  verifiedHead: string | undefined;
  routed: boolean;
} {
  const newest = [...log]
    .reverse()
    .find((s) => s.outcome !== undefined && !["handback", "decline"].includes(s.state));
  if (newest === undefined) throw new Error("the row's walk decided no work step");
  const heads = handbackHeads(log);
  return {
    newest,
    applies: heads.applies,
    ...(heads.verifiedHead === undefined ? {} : { verifiedHead: heads.verifiedHead }),
    routed: reportRouteFor(newest, log),
  };
}

/** The base rule's own reading of the same walk: the review entry made `fixed` instead of `error`. */
function baseRuleFinding(log: Step[]): string {
  const read = readLog(log);
  return (
    handbackHeads([
      ...log.filter((s) => s.key !== read.newest.key),
      { ...read.newest, outcome: { kind: "fixed", reason: "one fix wave" } },
    ] as Step[]).reason ?? ""
  );
}

for (const row of refused) {
  const { name, verifyKind, why, needed, silent } = row;
  const walk = await driveRow("budgetStop", { verifyKind });
  const log = erroredReviewOver(walk.steps, { message: THROWN, keepReport: true });
  const read = readLog(log);
  // The pair that discriminates the guard: an errored review whose gate certified NO HEAD must
  // name none, and the routing that consults the rule must not admit a report on that head's
  // strength. Whether the run owes a comment at all is the rule's own answer, stated per shape.
  assert(
    read.applies === !silent && read.verifiedHead === undefined && read.routed === false,
    `errored review over ${name}: the errored arm ${silent ? "stays silent" : "owes the comment, with no head"} and no report is routed on a head (${JSON.stringify([read.applies, read.verifiedHead, read.routed])})`,
  );
  // The base rule keeps its own words for the gate's refusal: the errored arm is silent, so the
  // finding a red gate owes is still the finding a red gate gets.
  const base = baseRuleFinding(log);
  assert(
    base.includes(why),
    `errored review over ${name}: the base rule still words the refusal the gate owes (${JSON.stringify(base)})`,
  );
  // The pair that makes the guard observable: on a gate that certified nothing, what the errored
  // arm answers must not be the finding the base rule owns. A run whose newest decided `verify`
  // was never green judged nothing and certified nothing, so its head is not owed the errored
  // arm's reading at all — that is the whole content of the guard, and dropping it is what sends
  // the row's own answer away from `{applies: false}` or away from the base rule's words.
  if (silent) {
    const own = handbackHeads(log);
    assert(
      own.applies === false &&
        own.verifiedHead === undefined &&
        own.reason === undefined &&
        own.shippedHead === undefined,
      `errored review over ${name}: the errored arm adds nothing to what the base rule says (${JSON.stringify(own)})`,
    );
  }
  // And the run itself: the machine's own route, which never reached a report over a head, and the
  // record it wrote names no head.
  assert(
    !walk.visited.includes("handback") ||
      (walk.handback?.shippedHead === undefined && walk.handback?.unshippedHead === undefined),
    `errored review over ${name}: no handback record names a head (${JSON.stringify([walk.visited.join(","), walk.handback?.shippedHead, walk.handback?.unshippedHead])})`,
  );
  assert(
    neededFromLog(log).includes(needed),
    `errored review over ${name}: the NEEDING line quotes a verdict the walk really recorded (${neededFromLog(log)})`,
  );
}

// The control on the same shape: a walk whose gate certified a head. The rule names it, the
// routing admits the report, and the reporting step says the review did not complete once.
{
  const walk = await driveRow("budgetStop");
  const log = erroredReviewOver(walk.steps, { message: THROWN, keepReport: true });
  const read = readLog(log);
  assert(
    read.applies === true &&
      read.verifiedHead === walk.verifiedHead &&
      read.routed === true,
    `control, errored review over a CERTIFIED head: the rule names the head the walk certified and the routing admits the report (${JSON.stringify([read.applies, read.verifiedHead === walk.verifiedHead, read.routed])})`,
  );
  assert(
    walk.handback?.shippedHead !== undefined &&
      walk.handback?.shippedVerified === true &&
      walk.visited.includes("handback"),
    "control: the run really ended on a routed report that named a certified head",
  );
  // The NEEDING line, read off the walk WITHOUT its report: the stamped shape, which is the one
  // shape that has no cause line of its own. The engine's own throw record supplies the reason.
  const stamped = neededFromLog(erroredReviewOver(panelWalk(walk.steps), { message: THROWN }));
  assert(
    stamped === `the review did not complete: ${THROWN}`,
    `the NEEDING line says the clause ONCE with the throw's own reason after it (${stamped})`,
  );
  assert(
    !stamped.includes("Why the review did not complete"),
    `and does not say it twice (${stamped})`,
  );
  // A routed run's own comment already carries the clause: the reporting step quotes the throw
  // verbatim as the run's cause, so the heading is written once across the whole comment.
  assert(
    (walk.posts[0]?.match(/the review did not complete/g) ?? []).length === 1,
    `a routed run's comment states the clause exactly once (${JSON.stringify(walk.posts[0]?.split("\n").slice(0, 6))})`,
  );
  // The shape the errored arm is silent about and the base rule owns: no gate verdict at all.
  const noGate = panelWalk(walk.steps).filter((s) => s.state !== "verify");
  const silent = neededFromLog(erroredReviewOver(noGate, { message: THROWN }));
  assert(
    silent.includes("the review did not complete"),
    `a stamped errored review with no gate record still gets the one clause (${silent})`,
  );
}

const failed = failures();
if (failed !== 0) {
  console.error("FAILED");
  process.exit(1);
}
console.log("✓ lean review-incomplete-head errored-review rows passed");

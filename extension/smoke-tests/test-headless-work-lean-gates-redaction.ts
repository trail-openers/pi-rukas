/**
 * The `gates` cases for the one thing the projection has to ADD to a record: the redaction.
 *
 * Every other case in `test-headless-work-lean-gates.ts` asks whether the projection
 * publishes what the record holds — a faithful read, asserted field by field. These ask the
 * opposite question, about the two strings a run's own child authored: `reviewBound.reason`
 * quotes what the step's bound said and `unreviewedLanes` names lanes off a skill roster,
 * so either can carry whatever a child printed, credential included. Every other published
 * gates string goes through `textOf` (redact, then clip); when these two did not, the host
 * document shipped the token intact while the fields beside it were scrubbed.
 *
 * So this file holds the pair the reading owes: the document scrubbed, and the record
 * demonstrably carrying the token in the first place — without which the first assertion
 * only proves a seam was never handed anything to redact.
 *
 * Split from that file for the size gate, along the seam the two questions draw: that one
 * reads a record, this one reads what the projection did to it on the way out.
 */

import { leanGates } from "../src/headless/work-lean-gates.ts";
import { REDACTED } from "../src/secret-patterns.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { driveLean } from "./lib/lean-result-fixture.ts";
import { REVIEW_BOUND, gatesLog, gatesOf } from "./lib/lean-result-gates-fixture.ts";

const { assert, failures } = makeAssert();

/** A GitHub-token-shaped secret, the shape `secret-patterns` recognises. */
const SECRET = `ghp_${"a".repeat(36)}`;

/** The same review step, its bound carrying `SECRET` in both of its free-text fields. */
function leakyBoundLog() {
  return gatesLog({ review: "fixed" }).map((s) =>
    s.state === "review"
      ? {
          ...s,
          outcome: {
            ...(s.outcome as object),
            reviewBound: {
              wave: "fix" as const,
              unreviewedLanes: [`adversarial re-review`, `token in a lane ${SECRET}`],
              reason: `review STEP stopped: a child printed ${SECRET} before its bound`,
            },
          } as never,
        }
      : s,
  );
}

{
  const leaky = await driveLean("handed-back", 10, leakyBoundLog());
  const leakyDoc = JSON.stringify(leaky.doc);
  const reviewNode = leakyDoc.match(/"reviewBound":\{.*?\}/)?.[0] ?? "no bound published";
  assert(
    !reviewNode.includes(SECRET) &&
      reviewNode.includes(REDACTED) &&
      (reviewNode.match(/\[REDACTED\]/g) ?? []).length === 2,
    // Witnessed from the published node rather than a whole-document scan: the assertion's
    // own message carries the token, so anything wider would be satisfied by this line.
    // TWO markers — one for the reason, one for the lane — because a fix that redacted only
    // one of the two strings is the bug this case exists to catch.
    `review: a credential-shaped token in reviewBound.reason or an unreviewed lane is redacted out of the whole document (${reviewNode})`,
  );
  // The projection called ONCE, so an empty seam is the code path that publishes the
  // record's bytes verbatim — which is what the two reviewBound strings did before they
  // went through `textOf` like every other gates string.
  const rawBound = (
    leanGates(leaky.run.steps, (s) => s) as unknown as {
      review: { reviewBound: { reason: string; unreviewedLanes: string[] } | null } | null;
    }
  ).review?.reviewBound;
  assert(
    rawBound?.reason.includes(SECRET) === true &&
      rawBound.unreviewedLanes.some((lane) => lane.includes(SECRET)),
    `review: the record really carries the token in BOTH fields, so the document's silence above is the seam and not an empty lane list (${JSON.stringify(rawBound)})`,
  );
  // And the case is not reading a bound the fixture dropped on the floor: the same log
  // through the ordinary projection publishes every field of the record it carries, so the
  // only thing that can make the document differ from it is what the projection did.
  const plain = await driveLean(
    "handed-back",
    10,
    gatesLog({ review: "fixed" }).map((s) =>
      s.state === "review"
        ? { ...s, outcome: { ...(s.outcome as object), reviewBound: { ...REVIEW_BOUND } } as never }
        : s,
    ),
  );
  assert(
    JSON.stringify(gatesOf(plain.issue).review?.reviewBound) ===
      JSON.stringify({
        wave: REVIEW_BOUND.wave,
        reason: REVIEW_BOUND.reason,
        unreviewedLanes: REVIEW_BOUND.unreviewedLanes,
      }),
    `review: a bound with nothing to redact is published field for field (${JSON.stringify(gatesOf(plain.issue).review?.reviewBound)})`,
  );
}

console.log(`\nexit ${String(failures())}`);
process.exit(failures());

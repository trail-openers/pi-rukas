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
 * TWO surfaces print those two strings, and the pair is asserted on both: `gates.review.reviewBound`
 * (the object) and the older string-valued `issues[].reviewBound` (the top-level line, reason +
 * wave + lanes joined). They read the same two fields off the same step outcome, so scrubbing
 * one and concatenating the other verbatim is the leak this file's second block pins — a scan
 * scoped to the object form stays green through it, which is how it was missed once.
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
              unreviewedLanes: ["adversarial re-review", `token in a lane ${SECRET}`],
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
      // The record's fields published as they are named, plus the print count beside the
      // lane list it counts — the marker is the only thing this projection adds here, and
      // it comes off the same pass that produced the list.
      JSON.stringify({
        wave: REVIEW_BOUND.wave,
        reason: REVIEW_BOUND.reason,
        unreviewedLanes: REVIEW_BOUND.unreviewedLanes,
        unreviewedLanesTotal: REVIEW_BOUND.unreviewedLanes.length,
      }),
    `review: a bound with nothing to redact is published field for field (${JSON.stringify(gatesOf(plain.issue).review?.reviewBound)})`,
  );
}

// ─── the SIBLING surface: the top-level string `issues[].reviewBound` ────────────
// The object form above is one of the two places this fact reaches the host. The other is
// the older one-line field, which prints the same `reason` and the same lanes joined into one
// sentence — so it takes the same two child-authored strings and, before the fix, published
// them raw while the object beside it was scrubbed. The assertion is deliberately NOT scoped
// to the object form: a scan of `"reviewBound":{...}` is exactly what stayed green while the
// string sibling leaked the token, so this case witnesses the whole document and the two
// surfaces together, and pins that neither holds a token-shaped byte.
{
  const leaky = await driveLean("handed-back", 10, leakyBoundLog());
  const line = leaky.issue?.reviewBound;
  assert(
    typeof line === "string" &&
      !line.includes(SECRET) &&
      line.includes(REDACTED) &&
      (line.match(/\[REDACTED\]/g) ?? []).length === 2,
    // Two markers again — the reason's token and the lane's — and the sentence's own shape
    // still legible, since a redaction that turned the line into noise is a different bug.
    `review: the top-level issues[].reviewBound line redacts BOTH strings, like the gates object beside it (${JSON.stringify(line)})`,
  );
  assert(
    typeof line === "string" && /; wave fix; unreviewed: /.test(line),
    `review: the redacted line keeps the shape the host contract publishes (reason; wave; unreviewed: lanes) (${JSON.stringify(line)})`,
  );
  // The whole document, both surfaces at once: nothing credential-shaped survives the
  // projection on either of them. The message carries no token, so this scan cannot be
  // satisfied by the assertion's own text (unlike a message that echoed the secret).
  const doc = JSON.stringify(leaky.doc);
  assert(
    !doc.includes(SECRET),
    "review: no credential-shaped byte survives on the host document, from either reviewBound surface",
  );
  // And the sibling is not vacuously clean: the record really carried the token, which the
  // object-form control above established, and the same projection with an EMPTY redaction
  // seam — the code path a missing call is equivalent to — publishes it on this line too.
  // Without this, the assertion above could be satisfied by a field that never got the bytes.
  const rawLine = leaky.run.steps
    .filter((s) => s.state === "review")
    .map((s) => s.outcome?.reviewBound)
    .find((b) => b !== undefined);
  assert(
    rawLine?.reason.includes(SECRET) === true &&
      (rawLine?.unreviewedLanes ?? []).some((lane) => lane.includes(SECRET)),
    `review: the step's record holds the token in both strings, so the line's silence is the seam (${JSON.stringify(rawLine)})`,
  );
}

// ─── the third surface: `gates.verify[].tiers` ──────────────────────────────
// The tier list was the one published gates string that reached the document without the
// seam: the loader bounds a tier NAME's length but says nothing about its content, and
// `criteria` is re-filtered to `/^AC\d+$/` while `tiers` got neither filter nor clip.
// A name the projection prints verbatim is a name the host parses, so the record's own
// shape rule is not the defence — the seam is, here exactly as beside it.
{
  const leakyTiers = gatesLog({
    verify: "red",
    reds: { tiers: [`tier ${SECRET}`, "fast", "x".repeat(640)], criteria: ["AC1"] },
  });
  const r = await driveLean("handed-back", 10, leakyTiers);
  const doc = JSON.stringify(r.doc);
  assert(
    !doc.includes(SECRET),
    "verify: no credential-shaped byte survives the gates.verify[].tiers projection",
  );
  const entry = (gatesOf(r.issue).verify as Record<string, unknown>[])[0];
  assert(
    Array.isArray(entry.tiers) &&
      (entry.tiers as string[]).every((t) => !t.includes(SECRET) && t.length <= 500) &&
      (entry.tiers as string[]).some((t) => t.includes(REDACTED)),
    `verify: each tier goes through the seam and the print clip, like every other published string (${JSON.stringify(entry.tiers)})`,
  );
  // Not vacuously clean: the same log through an EMPTY redaction seam publishes the token
  // and the whole oversized name — the code path the missing call was equivalent to.
  const raw = leanGates(r.run.steps, (s) => s).verify[0];
  assert(
    (raw?.tiers ?? []).some((t) => t.includes(SECRET)) === true &&
      (raw?.tiers ?? []).some((t) => t.length > 500) === true,
    `verify: the record really carries the token and the oversized name, so the document's silence above is the seam (${JSON.stringify(raw?.tiers)})`,
  );
  // `criteria` keeps its own stricter rule — an id is either `AC<n>` or nothing — so a
  // token-shaped id is refused rather than scrubbed, and this pins that the two lists are
  // not accidentally given the same treatment.
  const bogus = await driveLean(
    "handed-back",
    10,
    gatesLog({ verify: "red", reds: { tiers: ["fast"], criteria: [`AC1 ${SECRET}`] } }),
  );
  assert(
    !JSON.stringify(bogus.doc).includes(SECRET),
    "verify: a criterion id that is not AC<n> is dropped by the id rule, not published scrubbed",
  );
}

console.log(`\nexit ${String(failures())}`);
process.exit(failures());

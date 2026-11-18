#!/usr/bin/env bun
/**
 * The `review-incomplete` cap's own switch, and the claim that lets it ship on by default.
 *
 * A lean run whose review judged no further lens reports `review-incomplete` and
 * `reviewComplete: false` instead of the merge-deciding `awaiting-human-merge`. That is a
 * new value on a published document, so it ships behind `PI_ENSEMBLE_LEAN_REVIEW_INCOMPLETE_CAP`
 * — and the off arm's promise is that the document is the one this build wrote BEFORE the
 * cap existed. A field-absence check is not that proof (`reviewComplete: undefined` is
 * absent to a field check and present to a host that string-compares the file), and with
 * TWO switches on the same document the off arm cannot be pinned against the on arm with a
 * key deleted: both arms would have to be equally wrong for the comparison to pass. So each
 * off arm is compared, as the WHOLE serialised document, against the bytes captured before
 * the change in `lib/lean-review-incomplete-cap-golden.ts` — and the four-arm matrix
 * (`PI_ENSEMBLE_LEAN_RESULT_GATES` × this switch) is driven over one fixed record, so a
 * `gates` cut leaking into the review arm, or the reverse, fails with the key's name.
 *
 * The exit code is asserted beside the arms: the cap change must not move it, or a host
 * that ends cycles on 10 would see a new failure it was never told about.
 *
 * Section (3) pins the cap's other half: it is bound to the HEAD, not just to the newest
 * `review` step. `machine.ts` re-runs `publish` after the review on a CI-fix round, so a
 * predicate that asked only that step could report a finished review over bytes no lens read
 * — and this is where that is pinned, because the arms it decides are the cap's.
 */

import { leanResultDocument } from "../src/headless/work-lean-result.ts";
import { leanReviewIncompleteCapEnabled } from "../src/lean/review-incomplete-cap-switch.ts";
import { handoffMarker } from "../src/work-driver-handoff-channel.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { URL, driveLean, leanLog } from "./lib/lean-result-fixture.ts";
import {
  GOLDEN_GATES_OFF,
  GOLDEN_GATES_ON,
  fixedWaveLog,
  goldenLog,
  judgedReviewStep,
  republishedAfterReview,
  withReviews,
} from "./lib/lean-review-incomplete-cap-golden.ts";

const { assert, failures } = makeAssert();

/** The two env keys this document reads, restored after every case: both switches are
 * read at CALL time and the arms are pinned per block, so the set has to be the one the
 * scope clears — a key left set by an earlier block is a switch that silently arms the
 * next file in the same bun process. */
const KEYS = ["PI_ENSEMBLE_LEAN_RESULT_GATES", "PI_ENSEMBLE_LEAN_REVIEW_INCOMPLETE_CAP"];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

async function withArms(arms: Record<string, string | undefined>, body: () => Promise<void>) {
  for (const k of KEYS) {
    const v = arms[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await body();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ─── (1) the switch's truth table ──────────────────────────────────────────────
// Only the literal "0" takes the cap back. An empty value is a shell that meant nothing,
// and `false` is a value, not the token the contract names.
for (const [value, want] of [
  [undefined, true],
  ["", true],
  ["1", true],
  ["false", true],
  ["0", false],
] as const) {
  await withArms({ PI_ENSEMBLE_LEAN_REVIEW_INCOMPLETE_CAP: value }, async () => {
    assert(
      leanReviewIncompleteCapEnabled() === want,
      `switch ${JSON.stringify(value)} → ${String(want)}`,
    );
  });
}

// ─── (2) THE FOUR ARMS, OVER ONE RECORD ───────────────────────────────────────
// One run, four documents: a ready PR whose review step carries unjudged lanes, driven
// once and projected under each arm. The two arms with this switch at "0" must be BYTE
// FOR BYTE the captured pre-change documents; the two with it on answer the new cap and
// carry the new key, and differ from the captured bytes ONLY in the cap text and that key.
{
  const seed = await driveLean("handed-back", 10, goldenLog());
  const GATES = "PI_ENSEMBLE_LEAN_RESULT_GATES";
  const CAP = "PI_ENSEMBLE_LEAN_REVIEW_INCOMPLETE_CAP";
  const docs: Record<string, string> = {};
  const pin = (gates: string | undefined, cap: string | undefined): Promise<void> =>
    withArms({ [GATES]: gates, [CAP]: cap }, async () => {
      docs[`${String(gates)}/${String(cap)}`] = JSON.stringify(
        leanResultDocument(seed.run, 10).doc,
      );
    });
  await pin(undefined, undefined);
  await pin("0", undefined);
  await pin(undefined, "0");
  await pin("0", "0");

  const issueOf = (text: string): Record<string, unknown> => {
    const issues = (JSON.parse(text).issues ?? []) as Record<string, unknown>[];
    return issues[0] ?? {};
  };

  // The two off arms: byte equality against the bytes this build wrote before the cap.
  assert(
    docs["undefined/0"] === GOLDEN_GATES_ON,
    `cap off, gates on: the whole document is the pre-change one, key order included (${String(docs["undefined/0"]?.length)} bytes vs ${String(GOLDEN_GATES_ON.length)})`,
  );
  assert(
    docs["0/0"] === GOLDEN_GATES_OFF,
    `both off: the whole document is the pre-change one with no \`gates\` key (${String(docs["0/0"]?.length)} bytes vs ${String(GOLDEN_GATES_OFF.length)})`,
  );
  // …and the capture is not vacuous: the two goldens are real documents, distinct, and
  // each carries the marker of its own arm.
  assert(
    GOLDEN_GATES_ON !== GOLDEN_GATES_OFF &&
      GOLDEN_GATES_ON.includes('"gates":{') &&
      !GOLDEN_GATES_OFF.includes('"gates":') &&
      GOLDEN_GATES_ON.length > 1_000,
    `the two goldens are distinct non-trivial documents (${String(GOLDEN_GATES_ON.length)} vs ${String(GOLDEN_GATES_OFF.length)} bytes)`,
  );
  assert(
    GOLDEN_GATES_ON.includes("awaiting-human-merge") && !GOLDEN_GATES_ON.includes("reviewComplete"),
    "the pre-change document reports awaiting-human-merge for this record and no reviewComplete key — the bug, pinned",
  );
  // The ON arms are checked against the captured bytes with the cap RENAMED, a prediction
  // that is byte-exact only while the handoff body is not clipped: `leanHandoff` sizes the
  // reason to `TEXT_MAX - marker.length - gap`, and `review-incomplete` is three characters
  // shorter than `awaiting-human-merge`, so a reason near the bound would legitimately gain
  // those three and the rename would not predict them. One clip bound is therefore a
  // precondition of the comparison below — pinned, not assumed. The OFF arm's marker is the
  // LONGER of the two, so fitting it means neither arm clips.
  const reason = String(goldenLog().at(-1)?.outcome?.reason ?? "");
  assert(
    reason.length <= 500 - handoffMarker(7, "awaiting-human-merge").length - "\n\n".length,
    `the golden's handback reason fits the tighter clip, so the cap rename cannot move the body (${String(reason.length)} chars)`,
  );

  // The on arms: the new cap, the new key, and the same exit code.
  for (const [gates, label] of [
    [undefined, "gates on"],
    ["0", "gates off"],
  ] as const) {
    const text = docs[`${String(gates)}/undefined`] ?? "";
    const i = issueOf(text);
    assert(
      i.cap === "review-incomplete",
      `${label}, cap on: the unjudged review hands back review-incomplete (got ${String(i.cap)})`,
    );
    assert(
      i.reviewComplete === false,
      `${label}, cap on: reviewComplete false (got ${String(i.reviewComplete)})`,
    );
    assert(i.exitCode === 10, `${label}, cap on: the run still exits 10 (${String(i.exitCode)})`);
    assert(
      text.includes("cap=review-incomplete") && !text.includes("awaiting-human-merge"),
      `${label}, cap on: the handoff marker followed the cap and no old name survived`,
    );
    assert(
      text.includes('"reviewComplete":false'),
      `${label}, cap on: the key is written, not left holding undefined (${JSON.stringify(
        Object.keys(i).filter((k) => k.startsWith("review")),
      )})`,
    );
    // The ONLY difference from the captured document is the cap text and that one key:
    // drop the key from the on arm and the bytes must be the pre-change document with the
    // cap renamed. Nothing else on the record moved.
    const stripped = JSON.parse(text) as { issues: Record<string, unknown>[] };
    // Reflect.deleteProperty, not `delete`: same removal, without the biome `noDelete`
    // finding on a computed optional-chain delete. The guard keeps the missing-row case a
    // failed assertion downstream rather than a throw here.
    const row = stripped.issues[0];
    if (row) Reflect.deleteProperty(row, "reviewComplete");
    const expected = (gates === "0" ? GOLDEN_GATES_OFF : GOLDEN_GATES_ON).replace(
      /awaiting-human-merge/g,
      "review-incomplete",
    );
    assert(
      JSON.stringify(stripped) === expected,
      `${label}, cap on: minus the new key the document is today's, cap renamed (${String(JSON.stringify(stripped).length)} vs ${String(expected.length)} bytes)`,
    );
  }

  // The arms really differ — the comparisons above are not satisfied by one document
  // repeated under four pins.
  assert(
    new Set(Object.values(docs)).size === 4,
    `four arms, four distinct documents (${Object.values(docs)
      .map((d) => String(d?.length))
      .join(", ")} bytes)`,
  );
}

// ─── (3) THE CAP IS BOUND TO THE HEAD THE PR NOW STANDS ON ──────────────────
// `machine.ts` sends `publish` → `review`, and a CI-fix round runs `publish` AGAIN after
// the review — so the newest `review` step can be older than the newest `publish`, and what
// it judged is not what the forge holds. A predicate that asked only that step would report
// `reviewComplete: true` and `awaiting-human-merge` on a head no lens ever read: this cap's
// own harm. The answer is therefore taken from LOG ORDER, not from the review step alone.
{
  const ready = leanLog({ prUrl: URL, draft: false });
  const judged = withReviews(ready, [judgedReviewStep()]);
  // (b) the normal case first: publish, then a review that judged everything. This is the
  // arm that must NOT regress — the newest review postdates the newest publish.
  const normal = (await driveLean("handed-back", 10, judged)).issue ?? {};
  assert(
    normal.prState === "ready" &&
      normal.cap === "awaiting-human-merge" &&
      normal.reviewComplete === true,
    `review-then-nothing: a judged review after the publish keeps today's cap (${JSON.stringify([normal.prState, normal.cap, normal.reviewComplete])})`,
  );
  // (a) publish → review(judged) → publish: same records, one more publish. The review step
  // is unchanged and still the newest `review`, so only its POSITION behind the new push can
  // answer — and the answer must be "not this head".
  const moved = (await driveLean("handed-back", 10, republishedAfterReview(judged))).issue ?? {};
  assert(
    moved.prState === "ready",
    `republished: publish's own rule still calls the PR ready — so the cap is the only field that can refuse the merge (${String(moved.prState)})`,
  );
  assert(
    moved.cap === "review-incomplete" && moved.reviewComplete === false,
    `republished: a review older than the newest publish is not a review of this head (got ${String(moved.cap)} / ${String(moved.reviewComplete)})`,
  );
  assert(
    String((moved.handoff as Record<string, unknown> | undefined)?.marker ?? "").includes(
      "cap=review-incomplete",
    ),
    `republished: the handoff marker follows the cap, not the older review (${JSON.stringify(moved.handoff)})`,
  );
  // The same position with the second publish DEAD MID-PUSH and no outcome of its own: a
  // push that recorded nothing cannot be shown to have moved nothing, so it fails closed.
  const crashed =
    (await driveLean("handed-back", 10, republishedAfterReview(judged, true))).issue ?? {};
  assert(
    crashed.cap === "review-incomplete" && crashed.reviewComplete === false,
    `republished-crashed: an outcome-less publish after the review is not evidence the head held (got ${String(crashed.cap)} / ${String(crashed.reviewComplete)})`,
  );
}

// ─── (4) THE `fixed` REVIEW'S OWN PUBLISH IS NOT A MOVEMENT ─────────────────
// `machine.ts` routes `review + fixed → verify → publish`, so a review that found and
// fixed findings ALWAYS has a `publish` step after it — no CI-fix round involved. A
// position-only head-binding called that whole legitimate class `review-incomplete`, which
// makes `awaiting-human-merge` unreachable for every PR whose review found anything. The
// record separates the two cases: the review's own wave names the full head its `integrate`
// pushed, so equality with the published head says the verdict is about what stands on the
// PR, and a genuine CI-fix round moves the head to a commit no wave of the review named.
{
  const fixedWave = (await driveLean("handed-back", 10, fixedWaveLog())).issue ?? {};
  assert(
    fixedWave.prState === "ready",
    `fixed-wave: publish's own rule still calls this PR ready, so the cap is the only field at issue (${String(fixedWave.prState)})`,
  );
  assert(
    fixedWave.cap === "awaiting-human-merge" && fixedWave.reviewComplete === true,
    `fixed-wave: a returned review whose own fix wave pushed the very head the PR stands on is a finished review of it (got ${String(fixedWave.cap)} / ${String(fixedWave.reviewComplete)})`,
  );
  const ciFix = (await driveLean("handed-back", 10, fixedWaveLog(true))).issue ?? {};
  assert(
    ciFix.prState === "ready",
    `ci-fix-round: the round's own green clears the head it shipped — only the review can refuse it (${String(ciFix.prState)})`,
  );
  assert(
    ciFix.cap === "review-incomplete" && ciFix.reviewComplete === false,
    `ci-fix-round: a published head no wave of the review named is a head no lens read (got ${String(ciFix.cap)} / ${String(ciFix.reviewComplete)})`,
  );
}

// ─── (5) THE WAVE ARM REFUSES AN UNDECIDED PUBLISH AFTER THE REVIEW ──────────
// Every other undecided-publish assertion in this file drives the POSITION arm (a `done`
// review, whose record names no head). This is the only case that reaches the loop in
// `work-lean-pr.ts`'s wave arm: the record is the well-formed `fixed` wave of section (4)
// — the newest decided publish's head EQUALS the wave head, so identity alone would
// answer `true` — and the single fact refusing it is an outcome-less `publish` attempt
// after the review. A push whose outcome nobody wrote cannot be shown to have moved
// nothing, and the wave's own head does not vouch for a branch the log says moved again.
{
  const deadPush =
    (await driveLean("handed-back", 10, republishedAfterReview(fixedWaveLog(), true))).issue ??
    {};
  assert(
    deadPush.prState === "ready",
    `wave-arm dead-push: publish's own rule still reads the PR ready — only the wave arm's undecided rule can refuse it (${String(deadPush.prState)})`,
  );
  assert(
    deadPush.cap === "review-incomplete" && deadPush.reviewComplete === false,
    `wave-arm dead-push: an outcome-less publish after a fixed review whose wave head matches the published head fails closed (got ${String(deadPush.cap)} / ${String(deadPush.reviewComplete)})`,
  );
}

console.log(`\nexit ${String(failures())}`);
process.exit(failures());

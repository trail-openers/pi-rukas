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
 */

import { leanResultDocument } from "../src/headless/work-lean-result.ts";
import { leanReviewIncompleteCapEnabled } from "../src/lean/review-incomplete-cap-switch.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { driveLean } from "./lib/lean-result-fixture.ts";
import {
  GOLDEN_GATES_OFF,
  GOLDEN_GATES_ON,
  goldenLog,
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

console.log(`\nexit ${String(failures())}`);
process.exit(failures());

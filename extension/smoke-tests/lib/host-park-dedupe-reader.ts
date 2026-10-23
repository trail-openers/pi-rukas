/**
 * smoke-tests/lib/host-park-dedupe-reader.ts — the READER's dedupe, asked of the
 * pure function with no writer and no file in sight. Split out of
 * `lib/host-park-prune.ts` for the §12 file-size cap; that file owns the cases
 * where the ceiling is the judgement, and this one owns the two where it is not.
 *
 * These are the cases the prune cases cannot substitute for. A prune case runs
 * the whole write/read pair, so a collapse it observes could have been produced
 * by the writer's own bookkeeping; asked here, `dedupeHostRows` is the only thing
 * in the room, and a failure names the collapse rather than the pipeline around
 * it. Both are checked because the identity is what a refusal is keyed on:
 *
 *   - one (cap, reason, fingerprint) appearing twice is ONE park — max count,
 *     oldest `firstAt`, newest `lastAt` — while a genuinely different park (same
 *     reason, other fingerprint) stays two rows, or the dedupe would be merging
 *     parks the operator was told about separately;
 *   - and the key cannot be shifted by a NUL inside a field. `reason` is
 *     free-text `parkReason` with no character filter by design, and a
 *     NUL-joined key let one field's own delimiter read as the boundary between
 *     two fields, so two genuinely different parks collapsed into a row whose
 *     count belonged to neither — the exact defect the dedupe exists to stop. The
 *     key is `JSON.stringify` of the triple, which quotes and escapes each field.
 *     The NUL is built from a code point, never a literal, so this fixture stays
 *     valid UTF-8.
 */
import { createHash } from "node:crypto";
import { dedupeHostRows } from "../../src/work-driver-park-memory-host.ts";
import { CAP } from "./host-park-harness.ts";

type Assert = (cond: boolean, msg: string) => void;

const hash = (b: string) => createHash("sha256").update(b).digest("hex");

const NUL = String.fromCharCode(0);
/** `"a" + NUL + "b"` — the field whose own delimiter used to break the key. */
const NUL_A_B = `a${NUL}b`;

export async function hostParkDedupeReader(assert: Assert): Promise<void> {
  const base = Date.now() - 10 * 60_000;

  // ── 1. The reader collapses one identity, and leaves a different park alone.
  const merged = dedupeHostRows([
    {
      cap: CAP,
      reason: "same",
      fingerprint: "f",
      deliveredCount: 1,
      firstAt: base,
      lastAt: base + 9_000,
      lastCycleId: 1,
    },
    {
      cap: CAP,
      reason: "same",
      fingerprint: "f",
      deliveredCount: 3,
      firstAt: base - 40_000,
      lastAt: base + 8_000,
      lastCycleId: 2,
    },
    {
      cap: CAP,
      reason: "same",
      fingerprint: "f",
      deliveredCount: 2,
      firstAt: base - 50_000,
      lastAt: base + 12_000,
      lastCycleId: 3,
    },
    {
      cap: CAP,
      reason: "other",
      fingerprint: "f",
      deliveredCount: 1,
      firstAt: base,
      lastAt: base + 1_000,
      lastCycleId: 4,
    },
  ]);
  const same = merged.filter((r) => r.reason === "same");
  assert(
    merged.length === 2 &&
      same.length === 1 &&
      same[0]?.deliveredCount === 3 &&
      same[0]?.firstAt === base - 50_000 &&
      same[0]?.lastAt === base + 12_000,
    `the reader collapses one identity to max count / oldest firstAt / newest lastAt (${JSON.stringify(same)})`,
  );
  assert(
    dedupeHostRows([
      {
        cap: CAP,
        reason: "k",
        fingerprint: "a",
        deliveredCount: 1,
        firstAt: base,
        lastAt: base,
        lastCycleId: 1,
      },
      {
        cap: CAP,
        reason: "k",
        fingerprint: "b",
        deliveredCount: 1,
        firstAt: base,
        lastAt: base,
        lastCycleId: 2,
      },
    ]).length === 2,
    "…and two rows with one reason but different fingerprints stay TWO parks — the identity is the key",
  );

  // ── 2. …and the key cannot be shifted by a NUL inside a field (see header).
  const nulFp = (t: string) => hash(`nul ${t}`);
  const nul = dedupeHostRows([
    {
      cap: CAP,
      reason: NUL_A_B,
      fingerprint: nulFp("x"),
      deliveredCount: 1,
      firstAt: base,
      lastAt: base,
      lastCycleId: 1,
    },
    {
      cap: CAP,
      reason: "a",
      fingerprint: nulFp(`b${NUL}${NUL}x`),
      deliveredCount: 1,
      firstAt: base,
      lastAt: base,
      lastCycleId: 2,
    },
    // The control: a genuine duplicate of the first row, which must still fold.
    {
      cap: CAP,
      reason: NUL_A_B,
      fingerprint: nulFp("x"),
      deliveredCount: 3,
      firstAt: base - 5_000,
      lastAt: base + 5_000,
      lastCycleId: 3,
    },
  ]);
  const nulFirst = nul.filter((r) => r.reason === NUL_A_B);
  assert(
    nul.length === 2 && nulFirst.length === 1 && nulFirst[0]?.deliveredCount === 3,
    `a NUL inside a field keeps two different parks apart, while a real duplicate still folds (${JSON.stringify(nul.map((r) => [r.reason, r.deliveredCount]))})`,
  );
}

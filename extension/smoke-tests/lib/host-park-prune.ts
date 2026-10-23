/**
 * smoke-tests/lib/host-park-prune.ts — what #1696's host signal does when the
 * file is FULL, split out of `test-host-park-signal.ts` for the §12 file-size
 * cap (that file states which behaviours the suite pins).
 *
 * Three rules the ceiling has to honour, none of which recency alone can give:
 *
 *   - an ARMED row (the one the guard refuses on) survives a prune, whatever its
 *     age. Recency-first eviction dropped the oldest row regardless, so on a
 *     file at the ceiling a park the operator had already been handed twice
 *     stopped being refused for the unrelated reason that fifty other parks had
 *     been published since;
 *   - a row ONE publish from arming survives too, or the publish that would
 *     have armed it arrives to find its own history gone and the count restarts
 *     at one;
 *   - and two rows sharing one (cap, reason, fingerprint) — a hand edit, a crash
 *     between the tmp write and the rename — are ONE park: one publish
 *     increments it by one, not by whichever of the twins the reader landed on.
 *
 * The last one is checked through the writer AND through the reader, because the
 * file on disk is what the next writer reads and what an operator inspects, and
 * a reader-only dedupe would leave a file that says two while meaning one.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  HOST_PARK_MAX_ROWS,
  dedupeHostRows,
  hostParkVerdict,
} from "../../src/work-driver-park-memory-host.ts";
import {
  CAP,
  ISSUE,
  type World,
  park,
  refused,
  signalOf,
  signalPath,
  start,
  world,
} from "./host-park-harness.ts";

type Assert = (cond: boolean, msg: string) => void;

const hash = (b: string) => createHash("sha256").update(b).digest("hex");

/**
 * `lastAt` values for the fixture rows, all of them in the PAST.
 *
 * The reader's bar is absolute on both ends: a row is dropped unless `lastAt`
 * sits inside the 2020-to-`now` window, so a timestamp ahead of the clock reads
 * as an implausible row and is discarded before any prune runs.
 *
 * `minAgo` counts minutes BEFORE NOW, so it orders the file the way the reader
 * will: the row under test sits at `minAgo` and is the oldest thing in it, while
 * the fillers are spread over the twelve minutes beneath it. Spread, not one
 * stamp: the ceiling evicts the oldest FRESH row, and 49 rows sharing one
 * timestamp would leave that eviction decided by an ordering no cycle produces.
 */
const ago = (minAgo: number) => Date.now() - minAgo * 60_000;
/** The aged row under test: 45 minutes old, so it is the file's oldest row. */
const AGED_MIN = 45;
/** The twelve minutes below it the 49 filler rows are spread across. */
const FILL_SPREAD_MIN = 12;

/**
 * `lastCycleId` for a fixture row. The id is `state.startedAt` and the bar for
 * believing it is `Number.isSafeInteger` and non-negative — so a fixture id
 * needs no epoch at all, only a value NO cycle can reach. The harness stamps
 * cycles by counting up from a fixed epoch, so an id BELOW that epoch is
 * unreachable by construction: a filler that collided with a cycle's own id
 * read as that cycle re-entering its handoff, and the writer refused the write
 * — which emptied the file out from under the very assertion being made.
 */
const FIXTURE_BASE = 1_000_000;
const fixtureId = (n: number) => FIXTURE_BASE + n;

/**
 * The fingerprint for a fixture row: the hash of a text of its own.
 *
 * It must NOT be this world's own issue body. `recordHostPark` decides whether
 * to increment a row by matching (cap, reason, fingerprint) against the hash of
 * the body it just fetched, so a filler that shared the world's fingerprint
 * would be a row the writer could match and arm by accident — and a case about
 * the ceiling would be measuring an increment nobody published. Distinct
 * fingerprints per filler keep every row a separate park, which is what a
 * ceiling judgement needs: 50 parks in, 50 parks of room.
 */
const fpOf = (reason: string) => hash(`fixture body for ${reason}`);

/** The cap for every fixture row — `CAP`, the reader believes only known caps. */
const fixtureCap = CAP;

/** A row the writer could have produced, for an arbitrary cause and issue text. */
function row(reason: string, count: number, minAgo: number, cycle: number) {
  return {
    cap: fixtureCap,
    reason,
    fingerprint: fpOf(reason),
    deliveredCount: count,
    firstAt: ago(minAgo) - 1000,
    lastAt: ago(minAgo),
    lastCycleId: cycle,
  };
}

/** Fill the file to exactly the ceiling. `oldest` is the file's OLDEST row. */
function fillToCeiling(w: World, oldest: ReturnType<typeof row>) {
  const fillers = Array.from({ length: HOST_PARK_MAX_ROWS - 1 }, (_, i) =>
    // `i + 1` minutes past the aged row, so no filler is the oldest — that seat
    // belongs to `oldest`, which is the whole point of the case.
    // Fillers sit in the twelve minutes BELOW the aged row under test, newest
    // filler first, so the armed row is unambiguously the oldest thing the prune
    // sees and any eviction that follows is the writer's, not the fixture's.
    row(
      `filler-${String(i).padStart(3, "0")}`,
      1,
      AGED_MIN - 1 - (i * FILL_SPREAD_MIN) / HOST_PARK_MAX_ROWS,
      fixtureId(i),
    ),
  );
  mkdirSync(path.dirname(signalPath(w)), { recursive: true });
  writeFileSync(signalPath(w), JSON.stringify([oldest, ...fillers], null, 2), "utf8");
}

/**
 * Arm every row against THIS world's issue text, in bulk rather than one
 * `tamperSignal` per row: what is under test is which rows the file still holds,
 * and the fingerprint only has to be the one the guard computes.
 */
function armAgainstBody(w: World) {
  const rows = signalOf(w).map((r, i) => ({
    ...row(r.reason, r.deliveredCount, 30, fixtureId(500 + i)),
    fingerprint: hash(w.body),
  }));
  writeFileSync(signalPath(w), JSON.stringify(rows, null, 2), "utf8");
}

/**
 * Arm every row in place — same rows, same `lastAt`, only the fingerprint made
 * this world's — for a case that keeps PUBLISHING after arming. `armAgainstBody`
 * stamps every row with one fresh `lastAt` and a cycle id of its own, which
 * would both hand the ceiling's protected row to a filler and let the next
 * `park()` read as a cycle re-entering its own handoff. This keeps the fixture's
 * own clock and its unreachable cycle ids, so the only new row is the one a real
 * publish writes.
 */
function armAgainstBodyInPlace(w: World) {
  const rows = JSON.parse(readFileSync(signalPath(w), "utf8")) as Array<Record<string, unknown>>;
  for (const r of rows) r.fingerprint = hash(w.body);
  writeFileSync(signalPath(w), JSON.stringify(rows), "utf8");
}

/** The guard asked directly, on the host channel — a `start()` rebuilds state. */
async function guardArms(w: World): Promise<boolean> {
  process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
  try {
    const verdict = await hostParkVerdict(
      {
        repoRoot: w.repo,
        issue: ISSUE,
        issues: [ISSUE],
        issueBodyFetcherFn: async () => ({ stdout: w.body }),
      } as never,
      [ISSUE],
    );
    return verdict !== undefined;
  } finally {
    delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
  }
}

export async function hostParkPrune(assert: Assert): Promise<void> {
  // ── 1. The ceiling keeps an ARMED row that is also the OLDEST one, and the
  //        guard still refuses on it afterwards.
  const w: World = world("prune-armed");
  try {
    fillToCeiling(w, row("armed-oldest", 2, AGED_MIN, fixtureId(0)));
    assert(
      signalOf(w).length === HOST_PARK_MAX_ROWS &&
        signalOf(w).some((r) => r.reason === "armed-oldest"),
      "a file at the ceiling whose OLDEST row is armed holds that row",
    );
    // 49 publishes of causes the file has never seen: every one of them is a
    // row the writer produced, so nothing here is hand-stamped except the aged
    // armed row that started the file. Any row the ceiling evicts is evicted by
    // the writer's own rule, not by a fixture's arithmetic.
    // (The single publish below is the case that also checks the OTHER direction
    // — that a fresh count-1 row is not evicted by the same cut — and case 6
    // pins that for a file whose every row is armed.)
    // An unrelated publish: a different cause, so it cannot touch the armed row.
    // Filler rows carry a fingerprint no issue has, which is fine for a prune
    // judgement (the prune orders on the clock, not the hash) and is why the
    // guard is only asked after `armAgainstBody` has aligned every row.
    await park(w, { host: true, parkReason: "a-new-cause" });
    const rows = signalOf(w);
    assert(
      rows.length === HOST_PARK_MAX_ROWS &&
        rows.some((r) => r.reason === "armed-oldest" && r.deliveredCount === 2) &&
        rows.some((r) => r.reason === "a-new-cause") &&
        // FRESH rows are the ones the ceiling evicts when the armed row is
        // pinned: 50 rows in, one armed row held back, so one of the publishes
        // that filled the file has to go. Asserting an EARLY filler survived
        // would assert the opposite of the rule — recency still decides inside
        // each band, and the oldest fresh row is the first to leave.
        rows.some((r) => r.reason === "filler-048") &&
        !rows.some((r) => r.reason === "filler-000"),
      `an unrelated publish onto a full file keeps the armed row, admits its own, and evicts the OLDEST fresh row, not the armed one (${rows.length} rows, armed at ${rows.find((r) => r.reason === "armed-oldest")?.deliveredCount ?? "gone"})`,
    );
    armAgainstBody(w);
    assert(
      await guardArms(w),
      "…and the guard still refuses on the row the prune kept: eviction would let this start run",
    );
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }

  // ── 2. Two rows of ONE identity, AT THE CEILING, are one park before the
  //     increment: a hand-edited or crash-duplicated file cannot make one
  //     publish count against one twin while the reader answers from the other.
  const seed: World = world("prune-dedupe-at-ceiling");
  try {
    const fp = hash(seed.body);
    const pair = { cap: CAP, reason: "twins", fingerprint: fp };
    mkdirSync(path.dirname(signalPath(seed)), { recursive: true });
    writeFileSync(
      signalPath(seed),
      JSON.stringify(
        [
          // The duplicate pair is the OLDEST thing in the file, so the ceiling
          // would evict it first under a recency-only prune.
          { ...pair, deliveredCount: 1, firstAt: ago(AGED_MIN), lastAt: ago(AGED_MIN), lastCycleId: fixtureId(1) },
          { ...pair, deliveredCount: 1, firstAt: ago(AGED_MIN - 1), lastAt: ago(AGED_MIN - 1), lastCycleId: fixtureId(2) },
          ...Array.from({ length: HOST_PARK_MAX_ROWS - 2 }, (_, i) =>
            row(`filler-${String(i).padStart(3, "0")}`, 1, AGED_MIN - 2 - (i * FILL_SPREAD_MIN) / HOST_PARK_MAX_ROWS, fixtureId(300 + i)),
          ),
        ],
        null,
        2,
      ),
      "utf8",
    );
    assert(
      signalOf(seed).length === HOST_PARK_MAX_ROWS,
      `the file is at the ceiling and holds two count-1 rows of ONE identity (${signalOf(seed).length})`,
    );
    await park(seed, { host: true, parkReason: "twins" });
    const rows = signalOf(seed);
    const twins = rows.filter((r) => r.reason === "twins");
    // The row COUNT this asserts is the count of THIS identity's rows, not of
    // the whole file: the fixture seeded the file to the ceiling with 48 filler
    // rows beside the pair, and the prune is free to evict any of them for the
    // row this publish admits. Which filler leaves says nothing about the rule
    // under test — that the two twins are ONE park — and the ceiling itself is
    // pinned by the case above. What this one pins is the collapse: exactly one
    // row of that identity, counted 2 (not two rows at 1, and not the pair
    // evicted with the publish landing as a fresh count-1 row elsewhere).
    assert(
      twins.length === 1 && twins[0]?.deliveredCount === 2,
      `one publish onto that file leaves ONE row at count 2, not two rows at 1 and not a lost park (${JSON.stringify(twins)})`,
    );
  } finally {
    rmSync(seed.repo, { recursive: true, force: true });
  }

  // ── 3. Two rows of ONE identity, nowhere near the ceiling: still one row at
  //     count 2 after one publish, with the pair's oldest `firstAt` and newest
  //     `lastAt`. Alone, so a failure names the collapse rather than the prune.
  const dup: World = world("prune-dedupe");
  try {
    // The cause the handoff step itself publishes (`park()` with no
    // `parkReason`), so the writer matches one of the twins and increments it
    // rather than appending a third row nobody asked for.
    const fp = hash(dup.body);
    const twin = { cap: CAP, reason: "twin", fingerprint: fp };
    mkdirSync(path.dirname(signalPath(dup)), { recursive: true });
    writeFileSync(
      signalPath(dup),
      JSON.stringify(
        [
          { ...twin, deliveredCount: 1, firstAt: ago(9), lastAt: ago(3), lastCycleId: fixtureId(1) },
          { ...twin, deliveredCount: 1, firstAt: ago(3), lastAt: ago(1), lastCycleId: fixtureId(2) },
        ],
        null,
        2,
      ),
      "utf8",
    );
    assert(
      signalOf(dup).length === 2,
      "the file really holds two rows of one (cap, reason, fingerprint)",
    );
    await park(dup, { host: true, parkReason: "twin" });
    const after = signalOf(dup);
    const only = after.filter((r) => r.reason === "twin");
    assert(
      after.length === 1 && only.length === 1 && only[0]?.deliveredCount === 2,
      `two duplicate rows at count 1 plus one publish is ONE row at count 2 (${JSON.stringify(after)})`,
    );
  } finally {
    rmSync(dup.repo, { recursive: true, force: true });
  }

  // ── 5. The row ONE publish from arming survives a file that is OVER the
  //     ceiling, so the publish that arms it lands on its own history rather
  //     than a blank slate. This is the header's second rule: the row one
  //     publish from arming sits at count 1, BELOW the armed band, and a cut that
  //     reached it would make the next start count from one instead of arming.
  const near: World = world("prune-near-arming");
  try {
    const fp = hash(near.body);
    const NEAR = "near-arming";
    mkdirSync(path.dirname(signalPath(near)), { recursive: true });
    writeFileSync(
      signalPath(near),
      JSON.stringify([
        // The row under test: count 1, so it sits BELOW the armed band, and the
        // oldest thing in the file, so a recency cut takes it first.
        {
          cap: CAP,
          reason: NEAR,
          fingerprint: fp,
          deliveredCount: 1,
          firstAt: ago(AGED_MIN),
          lastAt: ago(AGED_MIN),
          lastCycleId: fixtureId(1),
        },
        // 49 ARMED foreign rows — a file whose every other row the guard could
        // refuse on, so the band the cut fills is entirely armed rows.
        ...Array.from({ length: HOST_PARK_MAX_ROWS - 1 }, (_, i) => ({
          ...row(`armed-${String(i).padStart(3, "0")}`, 2, AGED_MIN - 1 - i, fixtureId(100 + i)),
          fingerprint: fp,
        })),
        // Two fresh rows to push the file PAST the ceiling before the publish:
        // the cut chooses 50 rows from 51+, and NEAR is the one it must not drop.
        ...Array.from({ length: 2 }, (_, i) =>
          row(`extra-${i}`, 1, AGED_MIN - 2 - i, fixtureId(200 + i)),
        ),
      ]),
      "utf8",
    );
    await park(near, { host: true, parkReason: NEAR });
    const rows = signalOf(near);
    const nearRows = rows.filter((r) => r.reason === NEAR);
    assert(
      rows.length <= HOST_PARK_MAX_ROWS &&
        nearRows.length === 1 &&
        nearRows[0]?.deliveredCount === 2,
      `a full file keeps the row one publish from arming: it is the row the next start refuses on, not an eviction candidate (${JSON.stringify(nearRows)}, ${rows.length} rows)`,
    );
  } finally {
    rmSync(near.repo, { recursive: true, force: true });
  }

  // ── 6. The row a publish writes ALWAYS survives, even when every row already
  //     in the file is armed and the file sits AT the ceiling. Three publishes of
  //     one brand-new park: the row is there after each, and the third start is
  //     refused. Pruning the WHOLE file to `ceiling - 1` before inserting the new
  //     row dropped exactly that row, so on a busy issue the count never left 1
  //     and the guard never armed at all.
  const mine: World = world("prune-publishing-row");
  try {
    // Every foreign row is ARMED and carries this issue's own fingerprint: the
    // worst possible shape for a cut that can reach the publishing row. They do
    // NOT arm the guard on their own — `hostParkVerdict` refuses on the row whose
    // fingerprint equals the body it hashes AND whose (cap, reason) the cycle
    // parks for, and no foreign reason is a cause any cycle here parks for.
    // `start()` cannot judge the intermediate counts for this reason: its refusal
    // would also fire on the fixture's 50 armed rows, so the case reads the row
    // this cycle writes straight out of the file instead.
    const fp = hash(mine.body);
    const MINE = "mine";
    const ownRows = () => signalOf(mine).filter((r) => r.reason === MINE);
    mkdirSync(path.dirname(signalPath(mine)), { recursive: true });
    writeFileSync(
      signalPath(mine),
      JSON.stringify(
        Array.from({ length: HOST_PARK_MAX_ROWS }, (_, i) => ({
          ...row(`foreign-${String(i).padStart(3, "0")}`, 2, AGED_MIN - i, fixtureId(400 + i)),
          fingerprint: fp,
        })),
      ),
      "utf8",
    );
    assert(
      signalOf(mine).length === HOST_PARK_MAX_ROWS,
      `the file starts FULL of armed rows that all share this issue's fingerprint (${signalOf(mine).length})`,
    );
    assert(
      ownRows().length === 0,
      `nothing of THIS park is in the file before the first publish (${JSON.stringify(ownRows())})`,
    );
    for (let publish = 1; publish <= 3; publish++) {
      await park(mine, { host: true, parkReason: MINE });
      const rows = signalOf(mine);
      const own = ownRows();
      assert(
        rows.length <= HOST_PARK_MAX_ROWS &&
          own.length === 1 &&
          own[0]?.deliveredCount === publish,
        `publish ${publish} of a brand-new park onto a FULL file of armed rows keeps its own row at count ${publish} (${JSON.stringify(own)}, ${rows.length} rows)`,
      );
      if (publish === 2) {
        assert(
          own.length === 1 && own[0]?.deliveredCount === 2,
          `…two publishes reach the refusal count rather than restarting at 1 (${JSON.stringify(own)})`,
        );
      }
    }
    assert(
      refused(await start(mine, true)),
      "the third start is refused: had the prune dropped the publishing row, the count would have stayed at 1 and the guard would never have armed",
    );
  } finally {
    rmSync(mine.repo, { recursive: true, force: true });
  }

  // ── 4. The reader agrees, without any writer: the pure function collapses one
  //        identity to max count / oldest firstAt / newest lastAt, and leaves a
  //        genuinely different park alone.
  const base = ago(10);
  const merged = dedupeHostRows([
    { cap: CAP, reason: "same", fingerprint: "f", deliveredCount: 1, firstAt: base, lastAt: base + 9_000, lastCycleId: 1 },
    { cap: CAP, reason: "same", fingerprint: "f", deliveredCount: 3, firstAt: base - 40_000, lastAt: base + 8_000, lastCycleId: 2 },
    { cap: CAP, reason: "same", fingerprint: "f", deliveredCount: 2, firstAt: base - 50_000, lastAt: base + 12_000, lastCycleId: 3 },
    { cap: CAP, reason: "other", fingerprint: "f", deliveredCount: 1, firstAt: base, lastAt: base + 1_000, lastCycleId: 4 },
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
      { cap: CAP, reason: "k", fingerprint: "a", deliveredCount: 1, firstAt: base, lastAt: base, lastCycleId: 1 },
      { cap: CAP, reason: "k", fingerprint: "b", deliveredCount: 1, firstAt: base, lastAt: base, lastCycleId: 2 },
    ]).length === 2,
    "…and two rows with one reason but different fingerprints stay TWO parks — the identity is the key",
  );

  // ── 5. …and the key cannot be shifted by a NUL inside a field. `reason` is
  //     free-text `parkReason` with no character filter by design, and a
  //     NUL-joined key let `reason:"a\u0000b"` with one fingerprint and
  //     `reason:"a"` with a fingerprint starting with that same tail hash to ONE
  //     identity: two genuinely different parks collapsing into a row whose count
  //     belonged to neither, which is the exact defect the dedupe exists to stop.
  //     The key is `JSON.stringify` of the triple, which quotes and escapes each
  //     field so the boundary between them is not a character a field can hold.
  const nulFp = (t: string) => hash(`nul ${t}`);
  const nul = dedupeHostRows([
    { cap: CAP, reason: "a\u0000b", fingerprint: nulFp("x"), deliveredCount: 1, firstAt: base, lastAt: base, lastCycleId: 1 },
    { cap: CAP, reason: "a", fingerprint: nulFp("b\u0000\u0000x"), deliveredCount: 1, firstAt: base, lastAt: base, lastCycleId: 2 },
    // The control: a genuine duplicate of the first row, which must still fold.
    { cap: CAP, reason: "a\u0000b", fingerprint: nulFp("x"), deliveredCount: 3, firstAt: base - 5_000, lastAt: base + 5_000, lastCycleId: 3 },
  ]);
  const nulFirst = nul.filter((r) => r.reason === "a\u0000b");
  assert(
    nul.length === 2 && nulFirst.length === 1 && nulFirst[0]?.deliveredCount === 3,
    `a NUL inside a field keeps two different parks apart, while a real duplicate still folds (${JSON.stringify(nul.map((r) => [r.reason, r.deliveredCount]))})`,
  );
}

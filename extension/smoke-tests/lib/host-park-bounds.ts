/**
 * smoke-tests/lib/host-park-bounds.ts — what #1696's host signal does when the
 * file, a row, or an artifact path is BIGGER than the driver will accept; split
 * out of `test-host-park-signal.ts` for the §12 file-size cap (that file states
 * which behaviours the suite pins).
 *
 * Three bounds, all of them the reader's, none of them optional:
 *
 *   - the signal FILE is refused past `HOST_PARK_FILE_MAX_BYTES` before its bytes
 *     are buffered — it lives in the repository's working tree, so a corrupted or
 *     hand-edited file cannot decide how much memory a cycle start allocates;
 *   - a row's `reason` is clipped to `HOST_PARK_REASON_MAX` by the READER and by
 *     the WRITER with the same constant, because it is half of the identity a
 *     publish is counted against as well as text a refusal echoes;
 *   - a cached issue-body artifact naming one of the driver's own capability files
 *     is refused CASE-INSENSITIVELY — on a case-insensitive checkout a capitalised
 *     `.pi` IS this cycle's verify-command directory, and the guard must not hash
 *     a file whose contents gate the cycle because a state file capitalised it.
 *
 * Each case also pins which way the reader's doubt FALLS, because the two readers
 * answer the same unreadable file differently and both answers are the rule: the
 * guard fails OPEN (a start wrongly refused is a start nothing gets back) and the
 * sweep HOLDS (a stale directory costs bytes; a wrong delete costs the evidence a
 * refusal quotes).
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  HOST_PARK_FILE_MAX_BYTES,
  HOST_PARK_MAX_ROWS,
  HOST_PARK_REASON_MAX,
  holdsLiveHostParkSignal,
  isProtectedArtifactPathForTest,
  readHostParkSignalsImpl as readHostParkSignals,
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

/** Two host cycles that publish an identical uncovered park. */
async function twice(w: World) {
  await park(w, { host: true });
  await park(w, { host: true });
}

export async function hostParkBounds(assert: Assert): Promise<void> {
  // ── 1. The signal is READ under two bounds: the FILE cannot be buffered past
  //        its byte ceiling, and a row's `reason` cannot be longer than the
  //        reader will echo. Both are the reader's, and the file is in the working
  //        tree, so an edit — or a corruption — decides how much the driver reads
  //        into memory and how much of a file-sourced string a refusal prints.
  {
    const w = world("file-ceiling");
    try {
      await twice(w);
      const before = signalOf(w);
      assert(before.length === 1, "the two publishes left one row to be refused on");
      // Past the ceiling: an oversized file is neither absent nor believable. The
      // guard's rule for "could not read it" is unchanged by the ceiling — it
      // fails OPEN, because a start the signal wrongly refuses is a start nothing
      // gets back — and the sweep's rule for the same read is the opposite one.
      const huge = JSON.stringify(
        before.map((r) => ({ ...r, reason: "x".repeat(HOST_PARK_FILE_MAX_BYTES) })),
      );
      writeFileSync(signalPath(w), huge, "utf8");
      assert(
        (await readHostParkSignals(w.repo, ISSUE, "test")).length === 0,
        "a file past the byte ceiling reads as NO rows — the guard does not buffer it",
      );
      assert(
        !refused(await start(w, true)),
        "…and the start proceeds: an unreadable signal is the fail-open case it already was",
      );
      // The sweep's answer to the SAME file, which must be the other one: keeping
      // a stale directory costs bytes, deleting the evidence behind a refusal the
      // operator was handed costs a wrong delete, so doubt holds.
      assert(
        await holdsLiveHostParkSignal(w.repo, ISSUE, Date.now()),
        "…while the sweep HOLDS the directory on doubt — the ceiling is a read error, not an absence",
      );
      // Just under the ceiling is the normal case, and must stay it: 50 rows at
      // the reason ceiling is what a full real file looks like, and the file
      // ceiling exists to refuse a corrupted file, never to clip a legitimate one.
      const full = Array.from({ length: HOST_PARK_MAX_ROWS }, (_, i) => ({
        cap: CAP,
        reason: `r-${String(i).padStart(3, "0")}-${"y".repeat(HOST_PARK_REASON_MAX)}`,
        fingerprint: createHash("sha256").update(`ceiling body ${i}`).digest("hex"),
        deliveredCount: 1,
        firstAt: Date.now() - 2_000,
        lastAt: Date.now() - 1_000,
        lastCycleId: 1_700_000_000_000 + i,
      }));
      writeFileSync(signalPath(w), JSON.stringify(full), "utf8");
      const readBack = await readHostParkSignals(w.repo, ISSUE, "test");
      assert(
        readBack.length === HOST_PARK_MAX_ROWS &&
          readBack.every((r) => r.reason.length === HOST_PARK_REASON_MAX),
        `a full legitimate file (50 rows at the reason ceiling, ${JSON.stringify(full).length} bytes) reads in full — the file ceiling sits well above what the row ceilings need (${readBack.length})`,
      );
    } finally {
      rmSync(w.repo, { recursive: true, force: true });
    }
  }

  // ── 2. A row's `reason` is CLIPPED, by the reader and by the writer with the
  //        SAME constant. It is free text (`cap-hit.parkReason`) that a refusal
  //        echoes, and it is half of the identity a publish is counted against: if
  //        only one side clipped, the stored row and the row the next publish
  //        builds would be two parks, and the count the operator quotes would be
  //        the number of one of them.
  {
    const long = `${"a".repeat(HOST_PARK_REASON_MAX)}${"b".repeat(500)}`;
    const w = world("reason-clip");
    try {
      await park(w, { host: true, parkReason: long });
      const rows = signalOf(w);
      assert(
        rows.length === 1 && rows[0]?.reason.length === HOST_PARK_REASON_MAX,
        `the writer stores the reason at the ceiling, not at its raw ${long.length} characters (${rows[0]?.reason.length})`,
      );
      assert(
        rows[0]?.reason === "a".repeat(HOST_PARK_REASON_MAX),
        "…the CLIP, not a redaction or a reordering: the first 300 characters, kept",
      );
      // The dedupe consequence, which is the reason the writer clips at all: a
      // second publish of the same long cause must fold into the row the first
      // wrote, not stand beside it as a second park.
      await park(w, { host: true, parkReason: long });
      const after = signalOf(w);
      assert(
        after.length === 1 && after[0]?.deliveredCount === 2,
        `…and the NEXT publish of the same long cause folds into that row — one park, counted twice (${JSON.stringify(after.map((r) => [r.reason.length, r.deliveredCount]))})`,
      );
      // A hand-edited row whose reason runs long is the SAME row as the one the
      // writer clipped: the reader clips it too, so the identity cannot split.
      writeFileSync(
        signalPath(w),
        JSON.stringify([
          {
            cap: CAP,
            reason: long,
            fingerprint: rows[0]?.fingerprint,
            deliveredCount: 2,
            firstAt: Date.now() - 2_000,
            lastAt: Date.now() - 1_000,
            lastCycleId: w.cycle,
          },
        ]),
        "utf8",
      );
      const reread = await readHostParkSignals(w.repo, ISSUE, "test");
      assert(
        reread.length === 1 &&
          reread[0]?.reason === "a".repeat(HOST_PARK_REASON_MAX) &&
          reread[0]?.deliveredCount === 2,
        "a hand-edited long reason reads as the clipped row the writer wrote, not as a second park",
      );
    } finally {
      rmSync(w.repo, { recursive: true, force: true });
    }
  }
  for (const spelling of [".pi/verify-cmd", ".PI/verify-cmd", ".Github/workflows/ci.yml"]) {
    const w = world(`artifact-${spelling.replace(/[^a-z]/gi, "")}`);
    try {
      // The control: an artifact under a NON-sensitive name is NOT refused by the
      // path gate, so a failure below is about the SPELLING and not about some
      // other check firing. Deliberately not the REAL artifact path
      // (`.pi/work-state/<N>/cached-body.md`): that has a `.pi` segment, which
      // `isProtectedPath` has always refused on its own, and a control that fails
      // for the pre-existing reason would prove nothing about the case-folded
      // form this case is about.
      const rel = path.join("artifacts", String(ISSUE), "cached-body.md");
      mkdirSync(path.dirname(path.join(w.repo, rel)), { recursive: true });
      writeFileSync(path.join(w.repo, rel), `title:\tmock #${ISSUE}\n\nbody`, "utf8");
      assert(
        isProtectedArtifactPathForTest(rel) === false,
        `(${spelling}) a plain artifact path is NOT refused by the path gate — the case below is about the spelling, not the location`,
      );
      assert(
        isProtectedArtifactPathForTest(spelling),
        `(${spelling}) a protected path is refused however it is spelled — the raw check alone misses the capitalised form`,
      );
    } finally {
      rmSync(w.repo, { recursive: true, force: true });
    }
  }
}

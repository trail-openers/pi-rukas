/**
 * smoke-tests/lib/lost-park-count.ts — what #1696's host park signal does with
 * the counts it already holds, split out of `test-host-park-signal.ts` for the
 * §12 file-size cap.
 *
 * Two rules are pinned here, both about a number an operator is quoting when a
 * cycle parks:
 *
 *   - a cycle that publishes twice does not count the same park twice (two
 *     handoffs of one cycle are one refusal, counted 2 for the two REPORTS), and
 *   - a stale row the writer did not produce cannot inflate a fresh row — the
 *     handoff writes its own count from its own delivery, not the largest number
 *     it happened to see on disk.
 *
 * What this file deliberately does NOT claim: the max-before-increment branch —
 * a writer whose first reading held this cycle's row and whose re-read no longer
 * does — is not exercised, because it cannot be reached through the handoff step.
 * `park()` drives `runHandoff`, which renders the body, consolidates worktrees
 * and terminalises the cycle BEFORE its one call to the writer, so any reading a
 * test queues at that point describes a world the step already changed. An
 * earlier version of this case queued a row with the current time and a fake
 * reader to hand the writer a stale reading; the step read the signal as LIVE,
 * aborted, the write never ran, and the assertion still reported whatever the
 * disk happened to hold — a green that judged nothing. A queue installed outside
 * the step is no better: the write has already happened by then. That branch is
 * therefore left unverified by simulation. What IS pinned here is what the
 * re-read is FOR: rows another cycle wrote while this one was in flight survive
 * the write instead of being overwritten by the one row this cycle cares about.
 */
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { park, signalOf, signalPath, world } from "./host-park-harness.ts";

type Assert = (cond: boolean, msg: string) => void;

type Row = ReturnType<typeof signalOf>[number];
type TestWorld = Parameters<typeof signalOf>[0];

const LOST = "lost";

export async function lostParkCount(assert: Assert): Promise<void> {
  const w = world("lost-update");
  try {
    const first = await park(w, { host: true });
    const second = await park(w, { host: true });
    assert(
      signalOf(w)[0]?.deliveredCount === 2 && signalOf(w).length === 1,
      "two publishes are counted 2, the shape both cases below start from",
    );
    // A sibling's row for a cause no case below uses, counted 1 and stamped with
    // the FIRST cycle's id, so nothing in this cycle's own history explains it.
    // The fingerprints DIFFER, as two sibling rows must: the row identity is
    // (cap, reason, fingerprint) and the writer now dedupes on it, so two rows
    // that shared one fingerprint would be collapsed to one and this case would
    // be asserting a survival the file cannot hold. Distinct fingerprints are two
    // parks (two issue texts), which is the shape this write models.
    const rolled: Row = { ...signalOf(w)[0]!, reason: LOST, deliveredCount: 1 };
    const sib = (n: number): Row => ({
      ...rolled,
      fingerprint: createHash("sha256").update(`sibling body ${n}`).digest("hex"),
    });
    writeFileSync(
      signalPath(w),
      JSON.stringify(
        [
          { ...sib(1), lastCycleId: first.startedAt },
          { ...sib(2), lastCycleId: second.startedAt },
        ],
        null,
        2,
      ),
      "utf8",
    );
    assert(
      signalOf(w).length === 2 &&
        signalOf(w).every((r) => r.reason === LOST && r.deliveredCount === 1),
      `the file holds two stale rows of two DISTINCT issue texts and no row of this cycle (${JSON.stringify(signalOf(w))})`,
    );
    // The handoff re-runs for a NEW cycle while that stale file is in place. Its
    // own row must carry the count ITS delivery produced — 1, this cycle having
    // reported once — and the sibling's rows must survive the write rather than be
    // replaced by it. Were the writer to trust the largest count it read, this row
    // would come out at 2 off a file that says nothing about this cycle.
    await park(w, { host: true });
    const rows = signalOf(w);
    const mine = rows.find((r) => r.reason !== LOST);
    assert(
      rows.length === 3 && mine?.deliveredCount === 1,
      `…and the new cycle counts 1 rather than inheriting a stale sibling's count (${JSON.stringify(rows)})`,
    );
    // …and the rows it read are still there for the next reader: the write adds,
    // it does not overwrite the file with the one row it cares about.
    const readBack = await readRows(w);
    assert(
      readBack.filter((r) => r.reason === LOST).length === 2,
      `…and the sibling's rows survive the write (${JSON.stringify(readBack)})`,
    );
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}

async function readRows(w: TestWorld): Promise<Row[]> {
  const { readHostParkSignalsImpl } = await import("../../src/work-driver-park-memory-host.ts");
  return readHostParkSignalsImpl(w.repo, 930, "lost-update-test");
}

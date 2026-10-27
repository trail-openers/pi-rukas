#!/usr/bin/env bun
/**
 * #1852 review round 2 — a lens-fix stray revert the DRIVER performed is
 * recorded, and recorded BEFORE the landing arm can push.
 *
 * The lens-fix fence (`lensFixFenceCheck`) reverts one out-of-fence set per
 * round and hands the `fix-pass-strays-reverted` event back on its verdict. On
 * base (d1f73c90) the ONLY consumer of that event was the refusal path — the
 * `lens-fix-scope` cap-hit's `restoredToRef`/`restoredToPath`. On the `ok: true`
 * path, where the revert succeeded and the re-judged delta is clean, the event
 * was dropped, and the round landed with a driver commit that had deleted the
 * fixer's files. Two consequences:
 *
 *   (a) the operator never saw the preserved ref or the patch;
 *   (b) `lensFixRevertAlreadyUsed` counts those events off the event log, so a
 *       retried adversarial step (the RETRY_ONCE router, or the transient retry
 *       ladder) read "this round reverted nothing" and reverted a SECOND time in
 *       the same round.
 *
 * This file tests the recording itself — its shape, its ordering against the
 * persist, and the two `undefined` arms. The step-level assertions (an approved
 * round whose revert really happened, driven through `runAdversarial` over a
 * real repo, and the same state run a second time) live in
 * `test-lens-fix-fence-landing.ts`, which is also the file that carries the
 * base-vs-head non-vacuity proof.
 */

import {
  type LensFixRevertRecord,
  recordLensFixRevert,
} from "../src/work-driver-lens-fix-revert-record.ts";
import type { FixPassStraysRevertedEvent } from "../src/workflow-state-events-fix-pass-strays.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function revert(over: Partial<FixPassStraysRevertedEvent> = {}): FixPassStraysRevertedEvent {
  return {
    kind: "fix-pass-strays-reverted",
    at: 1_500_000,
    workstreamId: "default",
    paths: ["scratch-notes.md", "helper.ts"],
    preservedRef: "refs/pi-rukas/fix-pass-strays/1852-default-1",
    patchPath: "/repo/tmp/issue-1852/fix-pass-strays-1852-default-1.patch",
    ...over,
  };
}

const st: WorkState = { ...initialState(1852, 1_000_000) };
const record: LensFixRevertRecord = { round: 3, workstreamId: "default", revert: revert() };

console.log("# a reverted-and-allowed round records the revert and persists it first");
{
  const writes: WorkState[] = [];
  const out = await recordLensFixRevert(
    st,
    record,
    async (s) => {
      writes.push(s);
    },
    2_000_000,
  );

  const evs = out.eventLog.filter((e) => e.kind === "fix-pass-strays-reverted");
  assert(evs.length === 1, `exactly one revert event on the state (${evs.length})`);
  const ev = evs[0];
  assert(
    ev !== undefined && ev.source === "lens-fix" && ev.round === 3,
    `source "lens-fix" and the round are on it (${ev?.source} / round ${ev?.round}) — the two fields the round's counter reads`,
  );
  assert(
    writes.length === 1,
    `the state was persisted exactly once by the record (${writes.length}) — the record does not wait for the step boundary`,
  );
  assert(
    writes[0]?.eventLog.some((e) => e.kind === "fix-pass-strays-reverted") === true,
    "the PERSISTED snapshot is the one carrying the event, not an earlier copy",
  );
  assert(
    ev !== undefined && ev.preservedRef === record.revert?.preservedRef,
    "the preserved ref survives onto the event the operator reads",
  );
  assert(
    ev !== undefined && ev.patchPath === record.revert?.patchPath,
    "and so does the patch path (the only record of an untracked stray)",
  );
  const note = out.pipelineState.plumbReports.find((r) => r.step === "lens-fix");
  assert(note !== undefined, "a plumb report stamped step lens-fix was added on this path");
  assert(
    (note?.body ?? "").includes("scratch-notes.md") && (note?.body ?? "").includes("helper.ts"),
    "the note names the reverted paths",
  );
  assert(
    (note?.body ?? "").includes("refs/pi-rukas/fix-pass-strays/1852-default-1") &&
      (note?.body ?? "").includes("fix-pass-strays-1852-default-1.patch"),
    "the note names both recovery locations, so the deleted content is findable",
  );
}

console.log("# the persist is awaited before the record returns");
{
  // The ordering is the fix: `appendEvent` is pure, so a caller that forgot the
  // await would land the arm with the record only in memory — the crash window
  // this closes. The persist resolves on a microtask here, so an un-awaited
  // call leaves `seen` false at the moment the caller proceeds.
  let seen = false;
  const out = await recordLensFixRevert(
    st,
    record,
    async () => {
      await Promise.resolve();
      seen = true;
    },
    2_000_000,
  );
  assert(seen, "the write had already completed when the record returned to the landing arm");
  assert(
    out.eventLog.some((e) => e.kind === "fix-pass-strays-reverted"),
    "and the returned state carries the event",
  );
}

console.log("# a round with nothing to record pays no write");
{
  let writes = 0;
  const persist = async () => {
    writes++;
  };
  const noRevert = await recordLensFixRevert(st, { ...record, revert: undefined }, persist, 2);
  assert(noRevert === st, "no revert event, no new state — an in-fence round is untouched");
  const noId = await recordLensFixRevert(st, { ...record, workstreamId: undefined }, persist, 2);
  assert(noId === st, "a fence that could not attribute the round to a workstream records nothing");
  assert(writes === 0, `neither arm wrote the state file (${writes} writes)`);
}

console.log("# a caller that forgets to stamp the event still gets a countable record");
{
  // `revertLensFixStrays` stamps source + round AND the workstream (from
  // `postPassFault`'s own `straysFor`, which is what the destructive path acted
  // on). A caller wired straight to `revertStraysOnce` gets those three fields
  // re-stamped from the record — the original bug was an event the round's
  // counter could not read, and the counter keys on all three.
  const out = await recordLensFixRevert(
    st,
    {
      round: 2,
      workstreamId: "ws-7",
      revert: revert({ source: undefined, round: undefined, workstreamId: "stale-id" }),
    },
    async () => undefined,
    2,
  );
  const ev = out.eventLog.find((e) => e.kind === "fix-pass-strays-reverted");
  assert(
    ev !== undefined && ev.source === "lens-fix" && ev.round === 2 && ev.workstreamId === "ws-7",
    `source, round and workstream are stamped from the record (${ev?.source} / round ${ev?.round} / ${ev?.workstreamId})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

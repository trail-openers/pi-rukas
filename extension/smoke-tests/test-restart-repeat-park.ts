#!/usr/bin/env bun
/**
 * A park is remembered, and a repeat links the first one instead of posting a
 * near-identical second comment (#1743, forge channel + intent parks).
 *
 * Measured (janit/tehas#85, janit/tehas#88, 12 Oct): the first cycle parked
 * `intent-park (contradicted-by-code)`; a second cycle 21-36 min later ran
 * with `--restart`, which starts from `initialState` — so nothing remembered
 * the park. It reached the same verdict and posted a second near-identical
 * "Cap hit" comment on the issue, presented as a first report.
 *
 * The host channel never had that memory at all: the record was written only
 * when a comment URL came back, and a host handoff posts nothing — so a
 * factory passing `--restart` on every cycle re-reported the same park
 * forever. The host-channel cases are in test-park-memory-caps.ts, and the
 * third-identical-start refusal in test-repeat-park-guard.ts.
 *
 * Each "restart" below is what `runWorkDriverInner` does on `--restart`:
 * `initialState(issue)`, same repoRoot.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { explainCap } from "../src/work-driver-explain.ts";
import { workStateDir } from "../src/workflow-state.ts";
import {
  ISSUE,
  PARK_REPLY,
  PROCEED_REPLY,
  URL,
  URL2,
  assert,
  capOf,
  cycle,
  emittedOf,
  exitCode,
  parkedWorld,
  readRecord,
  recordFile,
  world,
} from "./lib/park-harness.ts";

process.env.PI_ENSEMBLE_INTENT = "1";
// No forge: the label leg is out of scope here, and the comment URL comes
// from the ops reply (a posted park) or the park record (a repeat).
process.env.PI_ENSEMBLE_FORGE = "none";

// 1. The first cycle is untouched: it resolves, parks, and posts once.
{
  const w = world("first");
  try {
    const s = await cycle(w);
    assert(w.explores === 1, "first cycle: explore is dispatched");
    assert(w.opsPosts === 1, "first cycle: the park comment is posted");
    assert(capOf(s)?.cap === "intent-park", "first cycle: parks at the intent gate");
    assert(emittedOf(s)?.repeatOf === undefined, "first cycle: is not marked as a repeat");
    assert(emittedOf(s)?.commentUrl === URL, "first cycle: records the comment it posted");
    assert(emittedOf(s)?.repeat === undefined, "first cycle: publishes no repeat count");
    assert(!/REPEAT/.test(explainCap("intent-park", s)), "first cycle: is not explained as one");
    assert(readRecord(w, "intent-park").count === 1, "the first park is recorded with count 1");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 2. CANARY — restart, nothing changed: explore runs again, no second comment.
{
  const w = await parkedWorld("repeat");
  try {
    const s = await cycle(w);
    assert(w.explores === 1, "restart, unchanged issue: explore IS dispatched again");
    assert(w.opsPosts === 0, "restart, same verdict: NO second park comment / ops dispatch");
    const emitted = emittedOf(s);
    assert(
      emitted?.commentUrl === URL && emitted.repeatOf?.commentUrl === URL,
      "…the handoff reuses the earlier comment and names it as the park it repeats",
    );
    assert(
      emitted?.delivery === undefined,
      "…and claims no delivery for a comment it did not post",
    );
    assert(
      emitted?.repeat?.count === 2 && emitted.repeat.firstAt === emitted.repeatOf?.at,
      "…and publishes the repeat count beside the first report's time",
    );
    assert(s.pipelineState.status === "handoff", "…and the cycle still terminates as a handoff");
    assert(readRecord(w, "intent-park").count === 2, "…which is what the record now says");
    const why = explainCap("intent-park", s);
    assert(
      /REPEAT #2 of the park first reported \d+ min ago/.test(why) && why.includes(URL),
      "the operator is told it is the second report of the park from N min ago, with its link",
    );
    assert(/same gate again/.test(why), "…and that the same gate ran again on the same text");
    // A third cycle repeats the ORIGINAL park, not the repeat.
    const s3 = await cycle(w);
    assert(
      w.explores === 2 &&
        w.opsPosts === 0 &&
        emittedOf(s3)?.repeatOf?.at === emitted?.repeatOf?.at,
      "a third unchanged cycle re-resolves again and still points at the original park",
    );
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 3. The human revised the issue → a re-park is a new report.
{
  const w = await parkedWorld("edited");
  try {
    w.body = `title:\tmock #${ISSUE}\n\nrevised: the budget is shared in the QUEUE path`;
    const s = await cycle(w);
    assert(w.explores === 1 && w.opsPosts === 1, "edited issue, same verdict: posts normally");
    assert(
      emittedOf(s)?.commentUrl === URL2 && emittedOf(s)?.repeatOf === undefined,
      "…with its own comment, not marked as a repeat",
    );
    assert(readRecord(w, "intent-park").count === 1, "…and the record starts again at count 1");
    w.exploreReply = PROCEED_REPLY;
    const p = await cycle(w);
    assert(capOf(p) === undefined, "a fresh verdict that proceeds is honoured");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 4. The code moved but the issue text did not: the fingerprint is the ISSUE,
// so this is still the same park. (It used to include HEAD, which made every
// merge on the base branch look like a fresh verdict.)
{
  const w = await parkedWorld("moved");
  try {
    const s = await cycle(w);
    assert(w.opsPosts === 0, "same issue text: still the same park, still no second comment");
    assert(emittedOf(s)?.repeat?.count === 2, "…counted as the second report of one park");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 5. A different park reason is a different verdict.
{
  const w = await parkedWorld("reason");
  try {
    w.exploreReply = PARK_REPLY.replace("contradicted-by-code", "premise-unsound");
    const s = await cycle(w);
    assert(
      capOf(s)?.parkReason === "premise-unsound" && w.opsPosts === 1,
      "same inputs, different park reason: posts normally",
    );
    assert(emittedOf(s)?.commentUrl === URL2, "…and reports the new comment");
    assert(readRecord(w, "intent-park").count === 1, "…the record describes the newer park");
    w.opsPosts = 0;
    const again = await cycle(w);
    assert(
      w.opsPosts === 0 && emittedOf(again)?.repeatOf?.commentUrl === URL2,
      "…which is what a further unchanged cycle then repeats",
    );
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 6. Unreadable inputs are never a repeat, and neither is a broken record.
{
  const w = await parkedWorld("unreadable-body");
  try {
    w.bodyReadable = false;
    await cycle(w);
    assert(w.opsPosts === 1, "issue body unreadable: posts rather than guessing 'unchanged'");
    assert(
      readRecord(w, "intent-park").count === 1,
      "…and the record is untouched — no count on a comparison that never happened",
    );
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}
{
  const w = await parkedWorld("corrupt");
  try {
    writeFileSync(recordFile(w, "intent-park"), '{"fingerprint": ', "utf8");
    await cycle(w);
    assert(w.opsPosts === 1, "malformed park record: posts normally");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}
{
  const w = await parkedWorld("missing");
  try {
    rmSync(recordFile(w, "intent-park"));
    await cycle(w);
    assert(w.opsPosts === 1, "record missing: posts normally");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 7. The record exists whether or not a comment URL came back — but a forge
// repeat with no URL to point at must still POST, or the park goes unreported.
{
  const w = world("unposted");
  try {
    w.opsReply = "I could not post the comment";
    await cycle(w);
    assert(
      existsSync(recordFile(w, "intent-park")),
      "a park whose comment was not posted still leaves a record (#1743's host-channel bug)",
    );
    assert(
      readRecord(w, "intent-park").commentUrl === undefined,
      "…recording that no comment URL was ever captured",
    );
    w.opsPosts = 0;
    await cycle(w);
    assert(w.opsPosts === 1, "…so the next cycle still gets to report the park");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 8. A handoff for another cap in between leaves the record alone: it describes
// that park, not this one, and dropping it used to lose the memory outright.
{
  const w = await parkedWorld("othercap");
  try {
    w.exploreReply = "I looked around and have nothing structured to say.";
    const s = await cycle(w);
    assert(
      capOf(s)?.cap === "explore-needs-clarification" && w.opsPosts === 1,
      "a different cap on restart: posts normally",
    );
    assert(
      existsSync(recordFile(w, "intent-park")),
      "…and the intent-park record survives it (only its own cap overwrites it)",
    );
    assert(readRecord(w, "intent-park").count === 1, "…unchanged: the other park did not count");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 9. The legacy `.txt` record is not read and is unlinked by the next write.
{
  const w = world("legacy");
  try {
    const dir = path.join(workStateDir(w.dir), String(ISSUE));
    mkdirSync(dir, { recursive: true });
    const legacy = path.join(dir, "intent-park.txt");
    writeFileSync(
      legacy,
      JSON.stringify({ parkedAt: 1, commentUrl: URL, parkReason: "x" }),
      "utf8",
    );
    await cycle(w);
    assert(!existsSync(legacy), "the pre-#1743 `.txt` record is unlinked on the next write");
    assert(readRecord(w, "intent-park").count === 1, "…and the new record took its place");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 10. PI_ENSEMBLE_REPEAT_PARK=0 — the guard is off, and so is the counting:
// every cycle posts, and no record is touched either way.
{
  const w = await parkedWorld("disabled");
  process.env.PI_ENSEMBLE_REPEAT_PARK = "0";
  try {
    const before = readFileSync(recordFile(w, "intent-park"), "utf8");
    const s = await cycle(w);
    assert(w.opsPosts === 1, "feature off: the park is reported again, as before #1743");
    assert(emittedOf(s)?.repeatOf === undefined, "…and is not marked as a repeat");
    assert(readFileSync(recordFile(w, "intent-park"), "utf8") === before, "…with the record left exactly as it was");
  } finally {
    delete process.env.PI_ENSEMBLE_REPEAT_PARK;
    rmSync(w.dir, { recursive: true, force: true });
  }
}

process.exit(exitCode());

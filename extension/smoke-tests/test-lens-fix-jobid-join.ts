#!/usr/bin/env bun
/**
 * The jobId join a bound-killed lens-fix relies on (#1789 round 2).
 *
 * The conversion refuses a `dispatch-failed` tail that is not THIS round's
 * dispatch, and it can only do that if the completion event's `jobId` is the
 * id `beginDispatch` minted. That id reaches the event by one route: the seam
 * hands it to the child as its `runId`, `transcriptPathFor` names the
 * transcript with it, and `runIdOfTranscript` strips the documented
 * `-(<role>|<tag>)[-<seq>]` suffix back off. Every assumption in that chain is
 * asserted here against the real `transcriptPathFor`, over the seq/tag
 * combinations spawn actually uses, because the driver's jobId is not a plain
 * token — it is `<step>:<label>:<pid>:<ms>` and the label itself contains
 * dashes (`developer:lens-fix-1`), which is exactly what a last-dash rule eats.
 */
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import { transcriptPathFor } from "../src/spawn-support.ts";
import {
  driverJobIdOfTranscript,
  runIdOfTranscript,
} from "../src/work-driver-completion-event.ts";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    failed = 1;
  }
}

/** The shape of a driver jobId: a colon-bearing label with dashes inside. */
const JOB_ID = "lens-fix:developer:lens-fix-1:4242:1700000000000";

function resultWith(transcriptPath: string): DispatchResult {
  return {
    role: "developer",
    ok: false,
    text: "",
    toolUses: [],
    ms: 1,
    exitCode: null,
    transcriptPath,
    dispatchJobId: JOB_ID,
  };
}

// ── 1. the join round-trips over every seq/tag shape spawn uses ─────────────
// `spawnSpecialist` names the transcript `transcriptPathFor(role, runId, seq,
// tag)`; a driver single-dispatch passes neither, a `dispatch_parallel` member
// passes both. The recovery must return the run id in every case.
for (const [role, seq, tag, what] of [
  ["developer", undefined, undefined, "a driver single-dispatch (no seq, no tag)"],
  ["developer", 0, undefined, "a batch member with seq 0 and no tag"],
  ["developer", 2, undefined, "a batch member with a seq and no tag"],
  ["developer", 1, "fix #1", "a batch member with a PM label as tag"],
  ["developer", 1, "#2", "a batch member with the index tag"],
  ["ops", undefined, undefined, "an ops child of the same driver"],
] as const) {
  const p = transcriptPathFor(role, JOB_ID, seq, tag);
  const back = runIdOfTranscript(resultWith(p), role);
  assert(
    back === JOB_ID,
    `runIdOfTranscript(${what}) returns the driver jobId (${path.basename(p)})`,
  );
  // The join the conversion depends on: the proven id is the claimed id.
  assert(
    driverJobIdOfTranscript(resultWith(p), role) === JOB_ID,
    `...and the completion event keeps the driver's jobId for ${what}`,
  );
}

// ── 2. a transcript the claim does not fit is REFUSED, not guessed ──────────
// A fake or PM-shaped result cannot assert an identity the child never encoded;
// the event falls back to the basename it always reported.
{
  const foreign = transcriptPathFor("developer", "somebody-elses-run");
  assert(
    driverJobIdOfTranscript(resultWith(foreign), "developer") === undefined,
    "a transcript whose run id is not the claimed jobId is refused (no id is asserted)",
  );
  assert(
    runIdOfTranscript(resultWith(foreign), "developer") === "somebody-elses-run",
    "...the run id still reads back correctly, so the basename fallback stays sane",
  );

  // Wrong role: the suffix does not match, so nothing is stripped and the claim
  // cannot be proven.
  assert(
    driverJobIdOfTranscript(resultWith(transcriptPathFor("ops", JOB_ID)), "developer") ===
      undefined,
    "a transcript named for another role does not prove the claim",
  );

  // No transcript at all.
  assert(
    runIdOfTranscript({ ...resultWith("x"), transcriptPath: undefined }, "developer") ===
      undefined,
    "a result with no transcript path yields no run id rather than a guess",
  );

  // A tag that happens to end in digits must not be eaten as a seq when the
  // role itself matches: the documented suffix is `-(role|tag)[-seq]`.
  const tagged = transcriptPathFor("developer", JOB_ID, 3, "lens-fix");
  assert(
    runIdOfTranscript(resultWith(tagged), "developer") === JOB_ID,
    "a member whose tag repeats part of the label still round-trips",
  );
}

// ── 3. the join is not a prefix match ───────────────────────────────────────
// `clearDispatch`/`beginDispatch` key on exact ids; a prefix match would let one
// dispatch's kill clear another's in-flight marker.
{
  const prefix = `${JOB_ID}-extra`;
  const p = transcriptPathFor("developer", prefix);
  assert(
    driverJobIdOfTranscript(resultWith(p), "developer") === undefined,
    "a transcript that merely STARTS with the jobId does not prove the claim",
  );
  assert(
    runIdOfTranscript(resultWith(p), "developer") === prefix,
    "...and the recovered id is the full run id, not a truncated one",
  );
}

console.log(`\nexit ${failed}`);
process.exit(failed);

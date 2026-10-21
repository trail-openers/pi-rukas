#!/usr/bin/env bun
/**
 * Parks are remembered on the HOST channel too, for every cap that can fire
 * twice (#1743).
 *
 * The park record used to be written only when a comment URL came back. A
 * host-owned cycle (`PI_ENSEMBLE_HANDOFF_CHANNEL=host`) posts no comment, so
 * it left no memory: a factory that passes `--restart` on every cycle
 * re-reported the same park indefinitely, and the count the operator was told
 * about never existed anywhere. Now the record is written whichever channel
 * ran, for all three parks a cycle can reach twice — `intent-park`,
 * `plan-spec-mismatch`, `existing-pr-detected` — and the headless result
 * carries `handoff.repeat {count, firstAt, marker}` in place of the comment
 * URL a forge run would have linked.
 *
 * The forge-channel halves of these cases are in test-restart-repeat-park.ts;
 * the third-identical-start refusal is in test-repeat-park-guard.ts.
 */

import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { projectIssue } from "../src/headless/result.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { renderTerminalStatus } from "../src/work-status.ts";
import { clearParkRecords, repeatParkVerdict } from "../src/work-driver-park-memory.ts";
import {
  ISSUE,
  assert,
  ctxOf,
  cycle,
  emittedOf,
  exitCode,
  parkHandoff,
  readRecord,
  recordFile,
  world,
} from "./lib/park-harness.ts";

process.env.PI_ENSEMBLE_INTENT = "1";
process.env.PI_ENSEMBLE_FORGE = "none";

// 1. Host channel: a repeat has no comment to point at, and says so — while
// the body still reaches the result from memory, marker first, with the count.
{
  const w = world("host-repeat");
  process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
  try {
    await cycle(w);
    w.opsPosts = 0;
    const s = await cycle(w);
    const emitted = emittedOf(s);
    assert(w.opsPosts === 0, "host + repeat: no ops dispatch");
    assert(emitted?.delivery === "host" && emitted.commentUrl === undefined, "…delivery host");
    assert(
      emitted.repeatOf !== undefined && emitted.repeatOf.commentUrl === undefined,
      "…the earlier park is named, and carries no URL (there never was one)",
    );
    assert(emitted.repeat?.count === 2, "…with the repeat count");
    assert(readRecord(w, "intent-park").count === 2, "…which the record agrees with");
    const r = projectIssue(s, "state.json");
    assert(
      r.handoff?.channel === "host" &&
        r.handoff.commentUrl === undefined &&
        r.handoff.body?.startsWith("<!-- pi-rukas:handoff issue=85 cap=intent-park -->") === true,
      "host + repeat: the result carries the body and no comment URL",
    );
    assert(
      r.handoff?.repeat?.count === 2 && typeof r.handoff.repeat.firstAt === "number",
      "host + repeat: handoff.repeat {count, firstAt, marker} is in the result (#1743)",
    );
    assert(
      r.handoff?.repeat?.marker === "<!-- pi-rukas:handoff issue=85 cap=intent-park -->",
      "…and the marker the park published",
    );
    assert(r.parkReason === "contradicted-by-code", "host + repeat: the park reason is in it too");
    const why = explainCap("intent-park", s);
    assert(
      /REPEAT #2/.test(why) && !why.includes("undefined"),
      "the no-URL repeat line renders, and never prints 'undefined'",
    );
    assert(
      !renderTerminalStatus(s, w.dir).includes("undefined"),
      "…and /work-status prints no 'undefined' either",
    );
  } finally {
    delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 2. The plan gate's park is remembered on the host channel too, and its
// verdict is published as `parkReason` beside the repeat count.
{
  const w = world("host-plan");
  process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
  try {
    await parkHandoff(w, "plan-spec-mismatch", {}, { planVerdict: "no-calls" });
    assert(readRecord(w, "plan-spec-mismatch").count === 1, "plan park: the first is recorded");
    const again = await parkHandoff(w, "plan-spec-mismatch", {}, { planVerdict: "no-calls" });
    assert(readRecord(w, "plan-spec-mismatch").count === 2, "…the identical verdict increments");
    const r = projectIssue(again, "state.json");
    assert(
      r.cap === "plan-spec-mismatch" && r.parkReason === "no-calls",
      "the plan verdict is published as parkReason",
    );
    assert(r.handoff?.repeat?.count === 2, "…and the repeat count is published with it");
    assert(
      /REPEAT #2/.test(explainCap("plan-spec-mismatch", again)) &&
        !explainCap("plan-spec-mismatch", again).includes("undefined"),
      "the plan handoff says it repeats, with no 'undefined' in it",
    );
    // A different verdict is a different park: the count starts again.
    const other = await parkHandoff(w, "plan-spec-mismatch", {}, { planVerdict: "all-refused" });
    assert(
      readRecord(w, "plan-spec-mismatch").count === 1,
      "a different verdict restarts the count",
    );
    assert(emittedOf(other)?.repeat === undefined, "…and is not published as a repeat");
  } finally {
    delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 3. The branch step's open-PR park: remembered on the host channel, keyed on
// the PR number, and the no-URL repeat line renders everywhere.
{
  const w = world("host-pr");
  process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
  const prState = {
    existingPr: { number: 77, headRefName: "feature/issue-85-x", matchedBy: "body" as const },
  };
  try {
    await parkHandoff(w, "existing-pr-detected", prState);
    assert(readRecord(w, "existing-pr-detected").count === 1, "open-PR park: the first is recorded");
    assert(readRecord(w, "existing-pr-detected").reason === "77", "…keyed on the PR it found open");
    const again = await parkHandoff(w, "existing-pr-detected", prState);
    assert(readRecord(w, "existing-pr-detected").count === 2, "…the same PR increments");
    assert(projectIssue(again, "state.json").handoff?.repeat?.count === 2, "…and is published");
    const why = explainCap("existing-pr-detected", again);
    assert(
      /REPEAT #2/.test(why) && why.includes("PR #77") && !why.includes("undefined"),
      "the open-PR handoff says it repeats, names the PR, prints no 'undefined'",
    );
    const otherPr = await parkHandoff(w, "existing-pr-detected", {
      existingPr: { number: 78, headRefName: "feature/issue-85-y", matchedBy: "branch" as const },
    });
    assert(
      readRecord(w, "existing-pr-detected").reason === "78" && emittedOf(otherPr)?.repeat === undefined,
      "a different open PR is a different park, counted from 1",
    );
  } finally {
    delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 4. `deliveredCount` counts REPORTED parks, and is what the guard refuses on
// (#1743's fix round). The host channel hands the body to the host, so its
// parks are reported even though nothing was posted; a forge cycle whose post
// failed is not.
{
  const w = world("host-delivered");
  process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
  try {
    await cycle(w);
    await cycle(w);
    const rec = readRecord(w, "intent-park");
    assert(
      rec.count === 2 && rec.deliveredCount === 2,
      "host: both parks handed the body to the host → both counted as reported",
    );
  } finally {
    delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
    rmSync(w.dir, { recursive: true, force: true });
  }
}
{
  const w = world("forge-post-failed");
  try {
    w.opsReply = "I could not post the comment — gh returned a 502";
    await cycle(w);
    await cycle(w);
    const rec = readRecord(w, "intent-park");
    assert(rec.count === 2, "forge + failed posts: both cycles parked");
    assert(
      rec.deliveredCount === 0,
      `…and NEITHER reported it (deliveredCount ${rec.deliveredCount}) — the guard will not silence a park nobody has read`,
    );
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 5. The plan gate is counted but never refused, and its count still reaches
// the handoff — which is the whole point of recording it.
{
  const w = world("plan-counted-not-refused");
  try {
    await parkHandoff(w, "plan-spec-mismatch", {}, { planVerdict: "no-calls" });
    const again = await parkHandoff(w, "plan-spec-mismatch", {}, { planVerdict: "no-calls" });
    assert(
      (await repeatParkVerdict(ctxOf(w), [ISSUE])) === undefined,
      "plan-spec-mismatch at the threshold: recorded, NOT refused — the planner may well answer differently",
    );
    assert(
      projectIssue(again, "state.json").handoff?.repeat?.count === 2,
      "…and the count still publishes in handoff.repeat, which is why it is recorded at all",
    );
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 6. A merge forgets the issue's parks. The work landed, so a record that
// refuses a later start describes a world that no longer exists.
{
  const w = world("merged-clears");
  try {
    await cycle(w);
    assert(existsSync(recordFile(w, "intent-park")), "a park was recorded");
    await clearParkRecords(w.dir, [ISSUE]);
    assert(
      !existsSync(recordFile(w, "intent-park")),
      "the merge clears this issue's park records — landed work is not a reason to refuse a start",
    );
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 7. An intent park with NO stated reason records nothing. Inventing
// "underspecified" would make every unstated park look identical to every other
// unstated park, and #404's lesson is that a reason the driver made up is a
// guess wearing a diagnosis.
{
  const w = world("no-stated-reason");
  try {
    w.exploreReply = w.exploreReply
      .split("\n")
      .filter((l) => !l.startsWith("PARK-REASON:"))
      .join("\n");
    await cycle(w);
    assert(
      !existsSync(recordFile(w, "intent-park")),
      "an intent-park with no stated park reason leaves no record — there is nothing to tell two such parks apart",
    );
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 8. The fingerprint prefers the cycle's OWN cached issue body, so a park is
// judged against the text explore actually read — and a body fetched fresh at
// guard time still matches it, byte for byte.
{
  const w = world("fingerprint-artifact");
  try {
    const s = await cycle(w);
    const rec = readRecord(w, "intent-park");
    const artifact = (s.pipelineState as { issueBodyArtifact?: string }).issueBodyArtifact;
    assert(typeof artifact === "string" && artifact.length > 0, "the cycle cached its issue body");
    assert(
      rec.fingerprint === createHash("sha256").update(w.body).digest("hex"),
      "the record's fingerprint is the hash of that body — the artifact and the gh fetch agree byte for byte",
    );
    assert(
      (await repeatParkVerdict(ctxOf(w), [ISSUE])) === undefined,
      "…and the guard, which has no artifact to read, reaches the same hash through the fetch: one park is not a repeat",
    );
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

process.exit(exitCode());

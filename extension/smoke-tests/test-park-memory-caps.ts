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

import { rmSync } from "node:fs";
import { projectIssue } from "../src/headless/result.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { renderTerminalStatus } from "../src/work-status.ts";
import {
  assert,
  cycle,
  emittedOf,
  exitCode,
  parkHandoff,
  readRecord,
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

process.exit(exitCode());

#!/usr/bin/env bun
/**
 * `/work N --restart` on an issue that just parked at the intent gate must
 * re-resolve it — and must NOT post a second park comment when the fresh
 * resolution reaches the same verdict against the same issue text and commit.
 *
 * Measured (example-owner/orchard#85, example-owner/orchard#88, 12 Oct): the first cycle parked
 * `intent-park (contradicted-by-code)`; a second cycle 21-36 min later ran
 * with `--restart`, which starts from `initialState` — so nothing remembered
 * the park. It reached the same verdict and posted a second near-identical
 * "Cap hit" comment on the issue, presented as a first report.
 *
 * The canary is section 2: a restarted cycle with unchanged inputs DOES
 * dispatch explore again (the verdict is a model's judgement; `--restart`
 * means "look again"), but dispatches no ops handoff, reuses the earlier
 * comment, and says it is a repeat. Sections 3+ pin the other direction:
 * any difference — issue text, commit, park reason, an unreadable input, an
 * earlier comment that never posted — reports exactly as before.
 *
 * Each "restart" below is what `runWorkDriverInner` does on `--restart`:
 * `initialState(issue)`, same repoRoot.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectIssue } from "../src/headless/result.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { runExplore } from "../src/work-driver-explore.ts";
import { runHandoff } from "../src/work-driver-handoff.ts";
import type { DriverHost } from "../src/work-driver-host.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_INTENT = "1";
// No forge: the label leg is out of scope here, and the comment URL comes
// from the ops reply (a posted park) or the park record (a repeat).
process.env.PI_ENSEMBLE_FORGE = "none";

const ISSUE = 85;
const URL = `https://github.com/o/r/issues/${ISSUE}#issuecomment-111`;
// What a second ops dispatch would post — a repeat must never surface it.
const URL2 = `https://github.com/o/r/issues/${ISSUE}#issuecomment-222`;
const PARK_REPLY = [
  "INTENT-VERDICT: park",
  "PARK-REASON: contradicted-by-code",
  "",
  "## Spec",
  "",
  "### Intent",
  "Reported: the retry budget is shared between infra and semantic failures.",
  "",
  "### Evidence",
  "- the counters are separate — src/step-router.ts:192 — contradicted",
  "",
  "## Rationale",
  "The issue describes behaviour that was already changed. It is stale.",
  "",
].join("\n");
const PROCEED_REPLY = [
  "INTENT-VERDICT: proceed",
  "",
  "## Spec",
  "",
  "### Intent",
  "Add the widget renderer.",
  "",
  "### Deliverables",
  "- D1: add the widget renderer [paths: src/widget.ts]",
  "",
  "### Acceptance criteria",
  "- the widget renders",
  "",
].join("\n");

function result(role: string, text: string): DispatchResult {
  return {
    role,
    ok: true,
    text,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
  } as DispatchResult;
}

interface World {
  dir: string;
  body: string;
  /** `undefined` → `git rev-parse HEAD` fails. */
  head: string | undefined;
  exploreReply: string;
  opsReply: string;
  explores: number;
  opsPosts: number;
}

function world(label: string): World {
  const dir = mkdtempSync(path.join(tmpdir(), `repeat-park-${label}-`));
  mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  return {
    dir,
    body: `title:\tmock #${ISSUE}\n\nthe retry budget is shared`,
    head: "a".repeat(40),
    exploreReply: PARK_REPLY,
    opsReply: `posted ${URL} and labelled`,
    explores: 0,
    opsPosts: 0,
  };
}

/** One whole cycle as far as a park takes it: explore, then handoff on a cap. */
async function cycle(w: World): Promise<WorkState> {
  const ctx: DriverContext = {
    host: { sendUserMessage: () => undefined } as unknown as DriverHost,
    repoRoot: w.dir,
    issue: ISSUE,
    issueBodyFetcherFn: async () => ({ stdout: w.body }),
    verifyExecFn: async (cmd) => {
      if (cmd === "git rev-parse HEAD") {
        if (w.head === undefined) throw new Error("fatal: not a git repository");
        return { stdout: `${w.head}\n` };
      }
      return { stdout: "" };
    },
    dispatchFn: async (_pi, spec) => {
      if (spec.role === "explore") {
        w.explores++;
        return result("explore", w.exploreReply);
      }
      w.opsPosts++;
      return result("ops", w.opsReply);
    },
  };
  // What `--restart` yields: a fresh state, the same repoRoot.
  let state = await runExplore(ctx, initialState(ISSUE, Date.now()), Date.now());
  if (state.eventLog.at(-1)?.kind === "cap-hit") {
    state = await runHandoff(ctx, state, Date.now());
  }
  return state;
}

const recordFile = (w: World) =>
  path.join(w.dir, ".pi", "work-state", String(ISSUE), "intent-park.txt");
const capOf = (s: WorkState) =>
  [...s.eventLog]
    .reverse()
    .find((e): e is Extract<typeof e, { kind: "cap-hit" }> => e.kind === "cap-hit");
const emittedOf = (s: WorkState) =>
  [...s.eventLog]
    .reverse()
    .find((e): e is Extract<typeof e, { kind: "handoff-emitted" }> => e.kind === "handoff-emitted");

/** A world whose first cycle has already parked and posted its comment. */
async function parkedWorld(label: string): Promise<World> {
  const w = world(label);
  await cycle(w);
  w.explores = 0;
  w.opsPosts = 0;
  w.opsReply = `posted ${URL2} and labelled`;
  return w;
}

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
    assert(!/REPEAT/.test(explainCap("intent-park", s)), "first cycle: is not explained as one");
    assert(existsSync(recordFile(w)), "a posted intent park leaves a record beside the artifacts");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 2. CANARY — restart, nothing changed: explore runs again, no second comment.
{
  const w = await parkedWorld("repeat");
  try {
    const s = await cycle(w);
    assert(w.explores === 1, "restart, unchanged issue + commit: explore IS dispatched again");
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
    assert(s.pipelineState.status === "handoff", "…and the cycle still terminates as a handoff");
    const why = explainCap("intent-park", s);
    assert(
      /REPEAT of the park reported \d+ min ago/.test(why) && why.includes(URL),
      "the operator is told it repeats the park from N min ago, with that comment's link",
    );
    assert(/re-resolved/.test(why), "…and that the verdict was freshly re-resolved");
    // A third cycle repeats the ORIGINAL park, not the repeat.
    const s3 = await cycle(w);
    assert(
      w.explores === 2 && w.opsPosts === 0 && emittedOf(s3)?.repeatOf?.at === emitted?.repeatOf?.at,
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
    w.exploreReply = PROCEED_REPLY;
    const p = await cycle(w);
    assert(capOf(p) === undefined, "a fresh verdict that proceeds is honoured");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 4. The code moved → the earlier comment's evidence is about other code.
{
  const w = await parkedWorld("moved");
  try {
    w.head = "b".repeat(40);
    const s = await cycle(w);
    assert(w.opsPosts === 1, "new HEAD, same issue text and verdict: posts normally");
    assert(emittedOf(s)?.repeatOf === undefined, "…not marked as a repeat");
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
    // The record now describes the newer park.
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

// 6. Unreadable inputs are never a repeat.
{
  const w = await parkedWorld("nohead");
  try {
    w.head = undefined;
    await cycle(w);
    assert(w.opsPosts === 1, "HEAD unreadable: posts rather than guessing 'unchanged'");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}
{
  const w = await parkedWorld("corrupt");
  try {
    writeFileSync(recordFile(w), '{"fingerprint": ', "utf8");
    await cycle(w);
    assert(w.opsPosts === 1, "malformed park record: posts normally");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}
{
  const w = await parkedWorld("missing");
  try {
    rmSync(recordFile(w));
    await cycle(w);
    assert(w.opsPosts === 1, "record missing: posts normally");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 7. No comment to point at → no record → the retry posts one.
{
  const w = world("unposted");
  try {
    w.opsReply = "I could not post the comment";
    await cycle(w);
    assert(!existsSync(recordFile(w)), "a park whose comment was not posted leaves no record");
    w.opsPosts = 0;
    await cycle(w);
    assert(w.opsPosts === 1, "…so the next cycle gets to report it");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// 8. The record describes the issue's LATEST handoff only: a handoff for any
// other cap in between drops it, so a later park is reported afresh.
{
  const w = await parkedWorld("othercap");
  try {
    w.exploreReply = "I looked around and have nothing structured to say.";
    const s = await cycle(w);
    assert(
      capOf(s)?.cap === "explore-needs-clarification" && w.opsPosts === 1,
      "a different cap on restart: posts normally",
    );
    assert(!existsSync(recordFile(w)), "…and the intent-park record is dropped");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

// #1327 — host channel + a repeat park: no ops dispatch, the earlier comment is
// named, and the body still reaches the result (from memory, marker first).
{
  const w = await parkedWorld("host-repeat");
  process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
  try {
    const s = await cycle(w);
    const emitted = emittedOf(s);
    assert(w.opsPosts === 0, "host + repeat: no ops dispatch");
    assert(
      emitted?.delivery === "host" && emitted.repeatOf?.commentUrl === URL,
      "host + repeat: delivery host, the earlier park named",
    );
    const r = projectIssue(s, "state.json");
    assert(
      r.handoff?.channel === "host" &&
        r.handoff.commentUrl === URL &&
        r.handoff.body?.startsWith("<!-- pi-rukas:handoff issue=85 cap=intent-park -->") === true,
      "host + repeat: the result carries the body and the earlier comment",
    );
    assert(
      r.parkReason === "contradicted-by-code",
      "host + repeat: the park reason is in the result",
    );
  } finally {
    delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
    rmSync(w.dir, { recursive: true, force: true });
  }
}

process.exit(exit);

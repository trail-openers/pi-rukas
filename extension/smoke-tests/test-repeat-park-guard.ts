#!/usr/bin/env bun
/**
 * The #1743 pre-loop guard: a third identical park is refused before any step
 * is dispatched.
 *
 * Two cycles have parked this issue for this reason against this exact issue
 * text (test-restart-repeat-park.ts pins the record that says so). A third
 * start would re-run explore or plan, reach the same verdict, and hand the
 * operator another report of the same fact — so `refuseRepeatPark`
 * (work-driver-state-guards.ts) ends the invocation at entry instead.
 *
 * What the cases below pin, in order:
 *   1. the refusal on both channels: exit 40, cap `repeat-park`, NO `handoff`
 *      field, and nothing else about this issue's record touched;
 *   2. `--restart` does NOT bypass it (with the state file wiped, which is
 *      exactly what a factory does on every cycle);
 *   3. the previous cycle's fields do not leak into the refused run's result;
 *   4. a real difference lets the run through: an edited issue body, the
 *      feature off, an unreadable body (fail open);
 *   5. the two other covered caps refuse the same way, from their own record;
 *   6. no dispatch, no sweep, no state file written by the refused start.
 *
 * Offline: no Pi session, no network (`PI_ENSEMBLE_FORGE=none`, the issue-body
 * fetch is stubbed).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHeadless } from "../src/headless/run.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { parkRecordPath } from "../src/work-driver-park-memory.ts";
import { humanActionFor } from "../src/work-queue-cap.ts";
import {
  REPEAT_PARK_REFUSAL_PREFIX,
  isRepeatParkRefusal,
  refuseRepeatPark,
} from "../src/work-driver-state-guards.ts";
import type { DriverHost } from "../src/work-driver-host.ts";

process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
process.env.PI_ENSEMBLE_VERIFY = "0";
process.env.PI_ENSEMBLE_INTENT = "1";
process.env.PI_ENSEMBLE_FORGE = "none";
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ISSUE = 85;
const COMMENT = `https://github.com/o/r/issues/${ISSUE}#issuecomment-111`;
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

interface World {
  repo: string;
  body: string;
  bodyReadable: boolean;
  /** What the ops stub answers. No URL in it → nothing was posted. */
  opsReply: string;
  dispatches: number;
}

function world(label: string): World {
  const repo = mkdtempSync(path.join(tmpdir(), `repeat-guard-${label}-`));
  mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  return {
    repo,
    body: `title:\tmock #${ISSUE}\n\nthe retry budget is shared`,
    bodyReadable: true,
    opsReply: `posted ${COMMENT} and labelled`,
    dispatches: 0,
  };
}

function seams(w: World) {
  return {
    issueBodyFetcherFn: async () => {
      if (!w.bodyReadable) throw new Error("gh: connection reset");
      return { stdout: w.body };
    },
    dispatchFn: async (_pi: string, spec: { role: string }): Promise<DispatchResult> => {
      w.dispatches++;
      return {
        role: spec.role,
        ok: true,
        text: spec.role === "explore" ? PARK_REPLY : w.opsReply,
        toolUses: [],
        ms: 5,
        exitCode: 0,
        transcriptPath: "/tmp/stub-transcript.json",
      } as DispatchResult;
    },
  };
}

const stateFile = (w: World) => path.join(w.repo, ".pi", "work-state", `${ISSUE}.json`);

/** Run the cycle to its park `n` times (each a factory-style `--restart`). */
async function parkNTimes(w: World, n: number, host = false) {
  let last: Awaited<ReturnType<typeof runHeadless>> | undefined;
  for (let i = 0; i < n; i++) {
    if (host) process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
    last = await runHeadless({
      repoRoot: w.repo,
      issues: [ISSUE],
      restart: true,
      driverSeams: seams(w) as never,
      write: () => {},
    });
    delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
  }
  return last;
}

function refusedResult(run: Awaited<ReturnType<typeof runHeadless>>) {
  const r = run.results[0];
  return {
    exit: run.exitCode,
    code: r.exitCode,
    status: r.status,
    cap: r.cap,
    handoff: r.handoff,
    branch: r.branch,
    prNumber: r.prNumber,
    usage: r.usage,
    failure: r.failure,
    failedStep: r.failedStep,
    parkReason: r.parkReason,
    causeClass: r.causeClass,
    causeReason: r.causeReason,
    userAction: r.userAction,
    resumable: r.resumable,
  };
}

// ── 1. Two parks recorded → the third start is refused, on both channels.
for (const host of [false, true]) {
  const label = host ? "host" : "forge";
  const w = world(label);
  try {
    await parkNTimes(w, 2, host);
    const before = readFileSync(stateFile(w), "utf8");
    w.dispatches = 0;
    const run = await runHeadless({
      repoRoot: w.repo,
      issues: [ISSUE],
      restart: true,
      driverSeams: seams(w) as never,
      write: () => {},
    });
    const r = refusedResult(run);
    assert(r.exit === 40 && r.code === 40, `${label}: a third identical park exits EXIT.refused`);
    assert(r.cap === "repeat-park", `…and the result's cap is ${label} \`repeat-park\``);
    assert(r.status === "not-started", `…with status ${label} not-started`);
    assert(r.handoff === undefined, `…and NO handoff field (${label}): this start delivered nothing`);
    assert(r.branch === undefined && r.prNumber === undefined, "…no branch or PR from the earlier cycle");
    assert(r.usage === undefined, "…no usage summed from the earlier cycle's dispatches");
    assert(r.failedStep === undefined, "…no failed step from the earlier cycle");
    assert(r.parkReason === undefined, "…no stale park reason");
    assert(r.resumable === false, "…and it is not resumable");
    assert(r.causeClass === "issue", "…classified as the issue's problem, not the driver's");
    assert(
      /two earlier cycles already parked/.test(r.causeReason ?? ""),
      "…with a cause sentence that says why",
    );
    assert(
      /PI_ENSEMBLE_REPEAT_PARK=0/.test(String(r.userAction)),
      "…and names both ways out (revise the body, or the env escape)",
    );
    assert(
      /already parked 2 times/.test(r.failure?.message ?? "") && r.failure?.kind === "cap",
      "…the failure carries the guard's own verdict",
    );
    assert(w.dispatches === 0, "…and no step was dispatched");
    assert(readFileSync(stateFile(w), "utf8") === before, "…the refused start persisted no state");
  } finally {
    delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
    rmSync(w.repo, { recursive: true, force: true });
  }
}

// ── 2. `--restart` does not bypass it — including with the state file gone.
{
  const w = world("restart-wiped");
  try {
    await parkNTimes(w, 2);
    rmSync(stateFile(w), { force: true });
    const run = await runHeadless({
      repoRoot: w.repo,
      issues: [ISSUE],
      restart: true,
      driverSeams: seams(w) as never,
      write: () => {},
    });
    const r = refusedResult(run);
    assert(
      r.code === 40 && r.cap === "repeat-park",
      "--restart with the state file wiped: still refused — the record, not the state file, is the memory",
    );
    assert(w.dispatches === 3, "…and the two parked cycles (explore + ops, then explore alone — the repeat posted nothing) are all the dispatches that ever ran");
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}

// ── 3. A difference in what the guard compares lets the run through.
{
  const w = world("edited");
  try {
    await parkNTimes(w, 2);
    w.body = `title:\tmock #${ISSUE}\n\nREVISED: the budget is shared only in the queue path`;
    const run = await runHeadless({
      repoRoot: w.repo,
      issues: [ISSUE],
      restart: true,
      driverSeams: seams(w) as never,
      write: () => {},
    });
    const r = refusedResult(run);
    assert(
      r.code !== 40 && r.cap === "intent-park",
      "an edited issue body: the run proceeds and parks afresh",
    );
    assert(r.handoff?.repeat === undefined, "…reported as a first park, not a repeat");
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}
{
  const w = world("disabled");
  await parkNTimes(w, 2);
  process.env.PI_ENSEMBLE_REPEAT_PARK = "0";
  try {
    const run = await runHeadless({
      repoRoot: w.repo,
      issues: [ISSUE],
      restart: true,
      driverSeams: seams(w) as never,
      write: () => {},
    });
    assert(
      refusedResult(run).code === 11,
      "PI_ENSEMBLE_REPEAT_PARK=0: the third park is reported, as before #1743",
    );
    assert(
      JSON.parse(readFileSync(parkRecordPath(w.repo, ISSUE, "intent-park"), "utf8")).count === 2,
      "…and the records survive the disable — they are not deleted on the way out",
    );
  } finally {
    delete process.env.PI_ENSEMBLE_REPEAT_PARK;
    rmSync(w.repo, { recursive: true, force: true });
  }
}
{
  const w = world("unreadable");
  try {
    await parkNTimes(w, 2);
    w.bodyReadable = false;
    const run = await runHeadless({
      repoRoot: w.repo,
      issues: [ISSUE],
      restart: true,
      driverSeams: seams(w) as never,
      write: () => {},
    });
    assert(
      refusedResult(run).code !== 40,
      "issue body unreadable: the guard fails OPEN — it never refuses on a comparison it could not make",
    );
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}

// ── 3d. Two cycles whose forge post BOTH failed have told nobody anything. The
// third start must run — the refusal threshold counts REPORTED parks, so
// silencing the first report that ever lands is the worst thing the guard could
// do. (`PI_ENSEMBLE_FORGE=none` + an ops reply with no URL is exactly that
// world: nothing was posted and no label was verified.)
{
  const w = world("posts-failed");
  try {
    w.opsReply = "I could not post the comment — gh returned a 502";
    await parkNTimes(w, 2);
    const rec = JSON.parse(readFileSync(parkRecordPath(w.repo, ISSUE, "intent-park"), "utf8"));
    assert(rec.count === 2, "two cycles parked the same park");
    assert(
      rec.deliveredCount === 0,
      `…and neither reported it (deliveredCount ${rec.deliveredCount}, not ${rec.count})`,
    );
    const run = await runHeadless({
      repoRoot: w.repo,
      issues: [ISSUE],
      restart: true,
      driverSeams: seams(w) as never,
      write: () => {},
    });
    assert(
      refusedResult(run).code !== 40,
      "a third start RUNS: two failed posts are not two reports the operator has seen",
    );
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}

// ── 6. The guard's own shape: a prefix the runner recognises, and no refusal
// when nothing is recorded.
{
  const w = world("nothing");
  try {
    const ctx = {
      host: { sendUserMessage: () => undefined } as unknown as DriverHost,
      repoRoot: w.repo,
      issue: ISSUE,
      issueBodyFetcherFn: async () => ({ stdout: w.body }),
    } as unknown as DriverContext;
    assert((await refuseRepeatPark(ctx)) === undefined, "no record: the guard does not refuse");
    assert(!isRepeatParkRefusal("another live process (pid 7) owns this cycle"), "…and a live-owner refusal is not mistaken for one");
    assert(
      isRepeatParkRefusal(`${REPEAT_PARK_REFUSAL_PREFIX}intent-park (underspecified) already parked 2 times`),
      "…recognising its own reason, which is how headless/run.ts skips the stale state file",
    );
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}

// ── 7. What the QUEUE tells the operator about a refusal. A repeat-park of an
// open PR is a PR problem, not an issue-body problem: a person who has already
// closed the PR is told to rewrite the issue, which cannot end the park. The
// repeat-park rule used to sit ABOVE the open-PR rule and shadow it — both
// tokens are in the same reason string.
{
  const pr = humanActionFor(
    `repeat-park: #${ISSUE} existing-pr-detected (77) already parked 2 times`,
    ISSUE,
  );
  assert(
    /resume, retarget or close the open PR/.test(pr) && /--continue-pr/.test(pr),
    "an existing-pr-detected refusal gets the PR advice (and names --continue-pr), not 'revise the body'",
  );
  const intent = humanActionFor(
    `repeat-park: #${ISSUE} intent-park (underspecified) already parked 2 times`,
    ISSUE,
  );
  assert(
    /revise the body/.test(intent) && !/open PR/.test(intent),
    "an intent-park refusal still gets the issue-body advice — the two are not the same park",
  );
}

process.exit(exit);

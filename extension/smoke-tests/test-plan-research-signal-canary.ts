#!/usr/bin/env bun
/**
 * #1541 — the two background tools must thread the JOB's AbortSignal into the
 * pipeline they launch, asserted at the source rather than through a run.
 *
 * Both `start_plan_driver` and `start_research_driver` launch a minutes-long
 * job and return a launch notice. The only thing that stops such a run is the
 * job's own `AbortSignal` — `killJob(jobId)` / `killAllJobs()` (dispatch_kill
 * and session_shutdown) abort that controller, and `runPlanPipeline` /
 * `runResearchPipeline` check the signal at their phase boundaries.
 *
 * The regression this canary prevents is the one #1541 review found in both
 * tools at once: `execute()` receives a signal from Pi and the pipeline call
 * threading *that* signal instead of the job's reads correct at a glance and
 * is silently dead, because Pi drops the exec signal the moment `execute()`
 * returns while the job outlives the call by minutes. A run that cannot be
 * killed is a 30-minute lock on the operator, which is what #1044's background
 * launch was meant to remove.
 *
 * Why source-level rather than behavioural: a dead signal is invisible at
 * runtime. The job settles, delivers its report, and the test passes — the
 * only observable difference is that nothing happened when something called
 * `killJob`, and a behavioural test cannot wait for a kill that never lands.
 * `test-dispatch-cwd-audit.ts` made the same call for the same reason (a
 * missing `cwd` is invisible until a workstream happens to lack an entry).
 *
 * The shape required: `startJob({ work: (signal) => ... })` — the job's
 * controller's signal — reaches the pipeline call as `{ signal }`. A call
 * passing anything else (an outer-scope `_signal`/`signal` from `execute`)
 * fails the "the threaded value is the callback parameter" check below.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) exit = 1;
}

const SRC = path.resolve(import.meta.dirname, "..", "src");
// Comments stripped, as in test-dispatch-cwd-audit.ts: this asserts on CODE,
// and both tools carry long `#1541 review` comments between the two lines the
// pattern has to span.
const read = (f: string) =>
  readFileSync(path.join(SRC, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

interface Site {
  file: string;
  /** The tool's `startJob({ work: (signal) => ... })` callback. */
  work: RegExp;
  /** The pipeline call that must receive the threaded signal. */
  pipeline: RegExp;
  /** `runXPipeline(..., { signal })` — the object position it must land in. */
  signalArg: RegExp;
  /** Human name for the failure messages. */
  label: string;
}

const SITES: Site[] = [
  {
    file: "plan-tool.ts",
    work: /work:\s*\(signal\)\s*=>\s*runPlanJob\(signal\)/,
    pipeline: /const runPlanJob = async \(signal: AbortSignal\) =>[\s\S]{0,200}?runPlanPipeline\(/,
    signalArg: /runPlanPipeline\([\s\S]{0,200}?\{\s*signal\s*\}\s*\)/,
    label: "/plan → runPlanPipeline",
  },
  {
    file: "research-tool.ts",
    work: /work:\s*\(signal\)\s*=>\s*runResearchJob\(signal\)/,
    pipeline:
      /const runResearchJob = async \(signal: AbortSignal\) =>[\s\S]{0,200}?runResearchPipeline\(/,
    signalArg: /runResearchPipeline\([\s\S]{0,400}?\{\s*signal\s*[,]?\s*\}\s*,?\s*\)/,
    label: "/research → runResearchPipeline",
  },
];

for (const site of SITES) {
  const src = read(site.file);

  // 1. The job hands its OWN signal to the tool's work callback. `startJob`
  //    owns the AbortController and calls `work(abort.signal)` — this is the
  //    only route by which `killJob` reaches the pipeline.
  assert(
    site.work.test(src),
    `${site.file}: startJob's work callback TAKES the job's signal and forwards it (${site.label}) — without it killJob has nothing to abort`,
  );

  // 2. The signal-carrying wrapper is the one that calls the pipeline, so a
  //    refactor that launches the pipeline outside it fails here.
  assert(
    site.pipeline.test(src),
    `${site.file}: the signal-taking wrapper is what calls ${site.label}`,
  );

  // 3. The signal reaches the pipeline call as `{ signal }` — the shorthand,
  //    which can only resolve to the wrapper's own `signal` parameter (an
  //    outer-scope exec signal would have to be named, and `execute`'s is
  //    `_signal`, deliberately unused).
  assert(
    site.signalArg.test(src),
    `${site.file}: ${site.label} receives the job signal as { signal } so a kill stops it at a phase boundary`,
  );

  // 4. The tool's exec signal must NOT be threaded. Pi drops it when
  //    execute() returns, so threading it would leave a run nobody can kill
  //    while looking like a run that can.
  assert(
    !/_signal[,)]/.test(src.replace(/execute\([^)]*_signal[^)]*\)/g, "")),
    `${site.file}: the tool's exec _signal is not threaded anywhere but execute()'s own signature`,
  );

  // 5. The pipeline call is not made outside the job — a direct call would
  //    block the tool's return and reintroduce the lock #1044 removed.
  const pipelineCalls = [...src.matchAll(new RegExp(site.pipeline.source, "g"))].length;
  assert(
    pipelineCalls === 1,
    `${site.file}: exactly one ${site.label} call site, inside the job wrapper (found ${pipelineCalls})`,
  );
}

// ------------------------------------------------------------------ shared seam
// #1541 review: the two tools must not couple to EACH OTHER for shared
// helpers. `noticeSubject` (the 80-char clamp on the caller's descriptor /
// topic) lived in plan-tool.ts and the research tool imported it from there —
// a tool-to-tool edge that turns one tool's refactor into the other's build
// break. It belongs to the report/notice layer both share.
{
  const planSrc = read("plan-tool.ts");
  const researchSrc = read("research-tool.ts");
  assert(
    !/from "\.\/plan-tool\.ts"/.test(researchSrc),
    "research-tool.ts imports NOTHING from plan-tool.ts — the two tools share helpers through the report layer, not each other",
  );
  assert(
    /from "\.\/async-jobs-report\.ts"/.test(planSrc) &&
      /noticeSubject/.test(planSrc) &&
      /from "\.\/async-jobs-report\.ts"/.test(researchSrc) &&
      /noticeSubject/.test(researchSrc),
    "noticeSubject lives in async-jobs-report.ts and BOTH tools import it from there",
  );
}

// The one `killedBy` — the two cancellation modules used to carry byte-identical
// copies, which drift apart the first time one is edited.
{
  const planCancel = read("plan-driver-cancel.ts");
  const researchCancel = read("research-cancel.ts");
  const definers = [planCancel, researchCancel].filter((s) => /export function killedBy\(/.test(s));
  assert(
    definers.length === 0,
    `killedBy has ONE definition, in session-shutdown.ts (local definitions found in the cancel modules: ${definers.length})`,
  );
  assert(
    /export function killedBy\(/.test(read("session-shutdown.ts")),
    "session-shutdown.ts owns killedBy — beside the shutdown flag it reads",
  );
}

console.log(exit === 0 ? "\n#1541 signal-threading canary: PASS" : "\nFAILED");
process.exit(exit);

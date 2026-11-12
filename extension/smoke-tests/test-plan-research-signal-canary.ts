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
  /** `runXPipeline(..., { signal })` — the object position it must land in. The
   *  object is written multi-line by the formatter, so whitespace is optional. */
  signalArg: RegExp;
  /** Human name for the failure messages. */
  label: string;
}

const SITES: Site[] = [
  {
    file: "plan-tool.ts",
    work: /work:\s*\(signal\)\s*=>\s*runPlanJob\(signal\)/,
    pipeline: /const runPlanJob = async \(signal: AbortSignal\) =>[\s\S]{0,200}?runPlanPipeline\(/,
    // The options object may carry `target` alongside the signal (#1854), so the
    // assertion is that the shorthand is the object's FIRST property and the object
    // still closes right after it — not that the object has exactly one property.
    signalArg: /runPlanPipeline\([\s\S]{0,200}?\{\s*signal\s*,\s*target\s*,?\s*\}\s*\)/,
    label: "/plan → runPlanPipeline",
  },
  {
    file: "research-tool.ts",
    // #2188 ticket A: the callback also takes the job's hooks, whose `jobId`
    // is the deck's parent link. Both patterns accept the extra parameter and
    // still require the SIGNAL to be the first thing forwarded — dropping it
    // reddens these three assertions as before, and dropping the hooks
    // parameter reddens the hooks.jobId block below. The signal intent is
    // unchanged.
    work: /work:\s*\(signal(?:,\s*hooks)?\)\s*=>\s*runResearchJob\(signal(?:,\s*hooks\.jobId)?\)/,
    pipeline:
      /const runResearchJob = async \(signal: AbortSignal(?:,\s*parentKey: string)?\) =>[\s\S]{0,200}?runResearchPipeline\(/,
    // `{ signal }` — the shorthand, which can only resolve to the wrapper's
    // own `signal` parameter. UNCHANGED by #2188: the optional separator is
    // there because the object now has a second entry, and without it a
    // `{ signal, parentKey }` object would fail this check — which would mean
    // the ticket's own change had loosened the #1541 signal assertion. The
    // parentKey demand lives in the hooks block below, never here.
    signalArg: /runResearchPipeline\([\s\S]{0,400}?\{\s*signal\s*[,:]?[^{}]*\}\s*,?\s*\)/,
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

// ------------------------------------------------------------------ deck parent link
// #2188 ticket A — the research tool must also hand the job's OWN id to the
// pipeline, so every child the pipeline dispatches records which job spawned
// it (DeckEntry.parentKey). Same route as the signal above: `startJob` mints
// the id and passes it to the work callback as `hooks.jobId` (the
// adversarial_tool precedent). Without the hooks parameter the deck has no
// parent link at all and the agent list stays flat — and, like a dead signal,
// a dropped hooks argument is invisible at runtime: the run completes and its
// report reads the same. So this too is asserted at the source.
{
  const src = read("research-tool.ts");
  assert(
    /work:\s*\(signal,\s*hooks\)\s*=>\s*runResearchJob\(signal,\s*hooks\.jobId\)/.test(src),
    "research-tool.ts: startJob's work callback TAKES the hooks and forwards hooks.jobId to the wrapper — the deck's only route to a parent link",
  );
  assert(
    /const runResearchJob = async \(signal: AbortSignal,\s*parentKey: string\)\s*=>[\s\S]{0,200}?runResearchPipeline\(/.test(
      src,
    ),
    "research-tool.ts: the wrapper that carries the parent id is the one that calls runResearchPipeline",
  );
  // The value must be the WRAPPER'S OWN `parentKey` parameter, not merely a
  // member named parentKey: `{ parentKey: undefined }` — or any other literal
  // — satisfies a name-only match while putting no link on any child row, so
  // the shorthand form is demanded here as it is for `signal` above. Deleting
  // the thread-out reddens this assertion, which is AC7's named mutant for the
  // canary.
  assert(
    /runResearchPipeline\([\s\S]{0,400}?\{[\s\S]{0,80}?parentKey(?!\s*:)[\s\S]{0,80}?\}\s*,?\s*\)/.test(
      src,
    ),
    "research-tool.ts: runResearchPipeline receives parentKey in its opts — the route to every research child's deck row",
  );
  // The parent id must arrive from the caller's hooks and reach the pipeline
  // in ONE hop: a re-mint or a rename inside the tool would put an id on the
  // child rows that matches no job, which is worse than no link at all — a
  // nesting projection would group children under a parent that does not exist.
  assert(
    !/newJobId|randomUUID|makeRunId/.test(src),
    "research-tool.ts: the parent id is the job's own (hooks.jobId), never a locally minted or invented one",
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

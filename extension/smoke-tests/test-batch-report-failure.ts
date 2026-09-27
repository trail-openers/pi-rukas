#!/usr/bin/env bun
/**
 * A batch report must say why a child died.
 *
 * Measured from a real `/research` run: four parallel `explore` children, three
 * killed by `Server requested 59s retry delay (max: 10s). 429 status code`.
 * Between them they had made 85 tool calls and gathered ~305k characters of
 * fetched research. The batch report said:
 *
 *     === explore[daphne-arch] — fail (exit 0) · 1 turns · 1m53s === (no output)
 *
 * The PM read that, concluded *"a dispatch failure, not a research failure"*,
 * and re-dispatched all three with tighter briefs — a rate limit misdiagnosed
 * as a prompting problem, and the gathered work discarded.
 *
 * The single-job report had handled `errorStop` all along, including a
 * 429-specific branch. Only the batch path was blind. `describeOutcome` is now
 * shared, so the two cannot drift again.
 */

import { GATE_LINE, formatBatchReport, formatSingleReport } from "../src/async-jobs-report.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const RATE_LIMIT = "Server requested 59s retry delay (max: 10s). 429 status code (no body)";

/** The real shape: exit 0, no text, an errorStop carrying the 429. */
const killed = (label: string): DispatchResult =>
  ({
    role: "explore",
    ok: false,
    exitCode: 0,
    ms: 113_000,
    text: "",
    toolUses: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    errorStop: { reason: "error", message: RATE_LIMIT },
    transcriptPath: `/runs/${label}.json`,
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
  }) as any as DispatchResult;

const succeeded: DispatchResult = {
  role: "explore",
  ok: true,
  exitCode: 0,
  ms: 241_000,
  text: "Rust Slack ecosystem findings…",
  toolUses: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 29 },
  // biome-ignore lint/suspicious/noExplicitAny: partial fixture
} as any as DispatchResult;

// ------------------------------------------------------------ the batch report

{
  const report = formatBatchReport({
    batchId: "mspr5ylf-vubrtu",
    members: [
      { jobId: "j1", label: "explore[daphne-arch]", result: killed("daphne-arch") },
      { jobId: "j2", label: "explore[rust-slack]", result: succeeded },
    ],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any);

  assert(
    report.includes(RATE_LIMIT),
    "the batch report names the 429 and the delay the provider asked for",
  );
  assert(
    /rate-limited/.test(report),
    "...and classifies it as rate limiting, not a generic failure",
  );
  // Scoped to the killed child's own section: the surviving child's section
  // must not be able to satisfy this. Sections are separated by the `===` rule.
  const daphneSection = report.split("=== ").find((s) => s.startsWith("explore[daphne-arch]"));
  assert(
    daphneSection !== undefined && !daphneSection.includes("(no output)"),
    "canary: the killed child's section does NOT read '(no output)' — the exact line that caused the misdiagnosis",
  );
  assert(
    report.includes("Rust Slack ecosystem findings"),
    "the surviving child's work is still reported (the fix is not vacuous)",
  );
}

// --------------------------------- the two report shapes agree on the cause

{
  const single = formatSingleReport("j1", "explore[daphne-arch]", killed("daphne-arch"));
  const batch = formatBatchReport({
    batchId: "b",
    members: [{ jobId: "j1", label: "explore[daphne-arch]", result: killed("daphne-arch") }],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any);

  assert(
    single.includes(RATE_LIMIT) && batch.includes(RATE_LIMIT),
    "both report shapes surface the provider message — they shared no logic before",
  );
  assert(
    /rate-limited/.test(single) && /rate-limited/.test(batch),
    "...and reach the same classification",
  );
  // The single report used to assert "retrying cannot help", written when a 10s
  // client ceiling made every 429 terminal. It told the reader the opposite of
  // the truth: the provider asked us to wait a stated delay and come back.
  assert(
    !/cannot help/i.test(single) && !/cannot help/i.test(batch),
    "canary: neither report claims retrying cannot help — with the ceiling raised, waiting is exactly what works",
  );
}

// ------------- the child's real activity survives the segmentation loss

{
  // `agent_end.messages` holds only the messages since the previous
  // `agent_end`, and Pi emits one per in-process retry boundary. Measured on
  // the real transcripts: `rust-slack` recovered from five 429s and its final
  // segment was exactly 29 messages — the "29 turns" reported, against 57
  // assistant turns on disk. A child that DIES ends on the error, so its
  // segment is the lone error stub: `1 turns`, for 41 tool calls of work.
  //
  // spawn.ts now reconciles against `runningState`, which counts every
  // `message_end` across every segment. The report must show it.
  const worked = {
    ...killed("daphne-arch"),
    observedToolCalls: 41,
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any as DispatchResult;
  const report = formatBatchReport({
    batchId: "b",
    members: [{ jobId: "j", label: "explore[daphne-arch]", result: worked }],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any);
  assert(
    /41 tool calls/.test(report),
    "canary: a killed child's 41 tool calls are reported — not implied to be zero work",
  );
  assert(
    /41 tool calls/.test(formatSingleReport("j", "explore[daphne-arch]", worked)),
    "...in the single report too",
  );

  // Not noise on a healthy child: its output already shows what it did.
  const fine = {
    ...succeeded,
    observedToolCalls: 51,
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any as DispatchResult;
  assert(
    !/tool calls before it died/.test(formatSingleReport("j", "explore[rust-slack]", fine)),
    "a successful child does not carry the badge",
  );
}

// ------------------- a quota window is NOT a burst, and still says so

{
  // The converse guard. Correcting "cannot help" must not flatten the other
  // way: a 24h quota exhaustion arrives as the same 429 and waiting really
  // does not help there. #366 drew this line in the taxonomy; the report now
  // shares that judgment instead of keeping a blanket one of its own.
  const quota = {
    ...killed("quota"),
    errorStop: {
      reason: "error",
      message: "Server requested 86399s retry delay (max: 60s). 429 status code (no body)",
    },
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any as DispatchResult;
  const report = formatBatchReport({
    batchId: "b",
    members: [{ jobId: "j", label: "explore[quota]", result: quota }],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any);
  assert(
    /cannot help/i.test(report),
    "a ~24h quota window DOES say retrying cannot help — the burst fix did not flatten the distinction",
  );
  assert(
    /quota window/i.test(report) && !/asked for a \d+s wait/.test(report),
    "...and is named a quota window, not a short wait",
  );
}

// ------------------------------------------ a genuinely silent child still says so

{
  const quiet = {
    role: "explore",
    ok: true,
    exitCode: 0,
    ms: 1000,
    text: "",
    toolUses: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any as DispatchResult;
  const report = formatBatchReport({
    batchId: "b",
    members: [{ jobId: "j", label: "explore[quiet]", result: quiet }],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any);
  assert(
    report.includes("(no output)"),
    "a child that really produced nothing, with no error, still reads '(no output)'",
  );
}

// ------------------------------------------------ #911 — the batch gate line

{
  const devDone: DispatchResult = {
    role: "developer",
    ok: true,
    exitCode: 0,
    ms: 300_000,
    text: "Task complete: gate line fixture",
    toolUses: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 8 },
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any as DispatchResult;
  const devKilled429: DispatchResult = {
    role: "developer",
    ok: false,
    exitCode: 0,
    ms: 100_000,
    text: "",
    toolUses: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    errorStop: { reason: "error", message: RATE_LIMIT },
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any as DispatchResult;

  // Split on the imported constant (via its opening phrase): the count must
  // track whatever the module defines, not a re-typed literal that can drift.
  const gateOpening = GATE_LINE.slice(0, GATE_LINE.indexOf(":"));
  const countGateLines = (r: string): number => r.split(gateOpening).length - 1;

  // Mixed batch (one finished developer + one 429-killed developer + one
  // explore): the gate line appears exactly once, in the shared footer — not
  // per-member.
  const mixed = formatBatchReport({
    batchId: "b911a",
    members: [
      { jobId: "j1", label: "developer[task-A]", result: devDone },
      { jobId: "j2", label: "developer[task-B]", result: devKilled429 },
      { jobId: "j3", label: "explore[context]", result: succeeded },
    ],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any);
  assert(
    countGateLines(mixed) === 1,
    "a mixed batch (finished developer + 429-killed developer + explore) shows the gate line exactly once",
  );
  assert(
    /adversarial_loop\` AND \`dispatch_lens_review|adversarial_loop.*dispatch_lens_review/s.test(mixed),
    "...and it names both gates",
  );

  // Two finished developers: still exactly once (dedup in the shared footer).
  const twoDevs = formatBatchReport({
    batchId: "b911b",
    members: [
      { jobId: "j1", label: "developer[task-A]", result: devDone },
      { jobId: "j2", label: "developer[task-B]", result: devDone },
    ],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any);
  assert(
    countGateLines(twoDevs) === 1,
    "two finished developers still show the gate line exactly once (deduped, not per-member)",
  );

  // No finished developer (429-killed developer + explore success): never.
  const none = formatBatchReport({
    batchId: "b911c",
    members: [
      { jobId: "j1", label: "developer[task-B]", result: devKilled429 },
      { jobId: "j2", label: "explore[context]", result: succeeded },
    ],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any);
  assert(
    countGateLines(none) === 0,
    "a batch with no finished developer (429-killed developer + explore) shows NO gate line",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

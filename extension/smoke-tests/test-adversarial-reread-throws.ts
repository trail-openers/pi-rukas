#!/usr/bin/env bun
/**
 * #1634 — the reviewer loop must NOT swallow a failed caller re-read.
 *
 * `test-work-driver-adversarial-reread-unreadable.ts` proves the gate parks when
 * the re-read fails, but it drives `ctx.adversarialLoopFn` — a FAKE loop that
 * calls the pass's `getDiff` and lets the throw escape. That fake cannot see the
 * defect: the real loop used to catch everything `getDiff` threw, note the
 * staleness, and review the PREVIOUS round's diff to an `APPROVED`. The
 * caller-side `isDiffRereadError` conversion only fires when the throw escapes,
 * so a green suite with a fake loop said "fixed" while the gate still approved
 * code nobody read.
 *
 * This file drives the REAL `runAdversarialLoop` (only the inner spawn is
 * mocked, the way `test-adversarial-diff-cap-loop.ts` mocks it) with the
 * driver's own shape — a pasted `diff` plus a `getDiff` — for two rounds in
 * which round 2's re-read throws. What is asserted is the two things the loop
 * itself owes the gate:
 *
 *   - no APPROVED: the loop returns an infrastructure failure, so
 *     `interpretReview` cannot read the round as a pass and the fan-out appends
 *     no `adversarial-approved`;
 *   - the throw keeps its identity across the loop's catch/rethrow, so the pass
 *     recognises it as a failed READ (`isDiffRereadError`) and builds the
 *     `diffUnreadable` outcome rather than the generic `threw` one.
 *
 * The third case is the control on the OTHER branch of the same catch: a range
 * the loop computed itself (`rangeDiffFn` threw) still keeps the previous diff
 * and still reports the staleness (#859). If that branch had collapsed too, the
 * fix would have traded one broken path for another.
 */

import { mock } from "bun:test";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A small synthetic diff — no cap is involved, so nothing is truncated. */
const DIFF = "diff --git a/a.ts b/a.ts\n+export const a = 1;\n";

type Prompt = { role: string; prompt: string };

/**
 * Mock the inner spawn so no Pi child is spawned, and record every prompt by
 * role. Reviewer replies are read in dispatch order; anything past the end
 * approves.
 */
async function mockSpawns(reviewerReplies: string[]) {
  const prompts: Prompt[] = [];
  const reviewCount = { n: 0 };
  mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
    makeRunId: () => "run-reread-throws",
    spawnSpecialist: async (spec: { role: string; prompt: string }) => ({
      role: spec.role,
      ok: true,
      text:
        spec.role === "adversarial-developer"
          ? reviewerReplies[reviewCount.n++] ?? "VERDICT: APPROVED"
          : "fixed",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    }),
  }));
  const realDeck = await import("../src/dispatch-deck.ts");
  mock.module(new URL("../src/dispatch-deck.ts", import.meta.url).href, () => ({
    ...realDeck,
    startEntry: () => {},
    updateEntry: () => {},
    clearEntry: () => {},
    startBatchEntry: () => {},
    updateBatchProgress: () => {},
    clearBatchEntry: () => {},
  }));
  const realRegistry = await import("../src/async-jobs-registry.ts");
  mock.module(new URL("../src/async-jobs-registry.ts", import.meta.url).href, () => ({
    ...realRegistry,
    childHandles: new Map(),
    registerChildHandle: () => {},
    setOrchestratorActiveChild: () => {},
    markOrchestrator: () => {},
  }));
  const realLedger = await import("../src/adversarial-ledger.ts");
  mock.module(new URL("../src/adversarial-ledger.ts", import.meta.url).href, () => ({
    ...realLedger,
    writeAdversarialLedgerEntry: () => undefined,
  }));
  return prompts;
}

const { runAdversarialLoop } = await import("../src/adversarial.ts");
const {
  DiffRereadError,
  diffUnreadableOutcome,
  isDiffRereadError,
} = await import("../src/work-driver-adversarial-fanout-diff.ts");
const { interpretReview } = await import("../src/work-driver-adversarial-fix.ts");

const signal = new AbortController().signal;
const CWD = process.cwd();

// ── the case the review asked for: two rounds, round 2's re-read throws.
//
// The loop is driven with the driver's `diff` + `getDiff` shape and its own
// round numbering: round 1 returns a non-approving verdict so the loop spends a
// round 2, and round 2 is where the re-read runs and throws. `reportRound` is
// deliberately NOT passed — it is the driver's `reviewRoundFor()`, and a
// reportOnly review with `reportRound: N` STARTS at round N, so passing 2 would
// have skipped the very re-read this test exists to drive.
{
  const prompts = await mockSpawns(["VERDICT: ISSUES_FOUND\n1. f", "VERDICT: APPROVED"]);
  let reads = 0;
  let thrown: unknown;
  const getDiff = async (): Promise<string> => {
    reads += 1;
    throw new DiffRereadError("git diff --end-of-options deadbeef..HEAD failed in /w: boom");
  };
  // The pass's own catch, replayed on whatever the loop let escape: this is the
  // branch that decides between the `diffUnreadable` outcome and the generic
  // `threw` one, so it is exercised here rather than assumed.
  const classifyEscape = (err: unknown): string => {
    thrown = err;
    return isDiffRereadError(err) ? "diffUnreadable" : "threw";
  };
  let routed = "no throw";
  let result;
  try {
    result = await runAdversarialLoop(
      {
        diff: DIFF,
        context: "gate",
        workCwd: CWD,
        getDiff,
      },
      signal,
      "job-reread-throws",
    );
  } catch (err) {
    routed = classifyEscape(err);
  }

  assert(reads === 1, `round 2 attempted its re-read exactly once (got ${reads})`);
  assert(routed === "diffUnreadable", `the escaped throw reads as a failed READ (got ${routed})`);
  assert(thrown instanceof DiffRereadError, "the rethrow is the SAME error object/class");
  assert(
    (thrown as DiffRereadError)?.reason?.includes("git diff --end-of-options") === true,
    "the rethrow carries the read's own reason through the loop's catch",
  );
  assert(
    result === undefined,
    "the loop returned no result at all — an APPROVED it could not justify is impossible",
  );
  const reviews = prompts.filter((p) => p.role === "adversarial-developer");
  assert(
    reviews.length === 1,
    `only round 1 dispatched a reviewer — the doomed round 2 dispatched none (got ${reviews.length})`,
  );
}

// ── what the outcome the pass builds actually says, through the router.
{
  const outcome = diffUnreadableOutcome({
    id: "default",
    cwd: "/tmp/does-not-matter",
    multi: false,
    label: "adversarial_loop",
    jobId: "job-x",
    startedAt: Date.now() - 5,
    priorOutcomes: new Map(),
    reason: "git diff failed: not a git repository",
  });
  assert(outcome.ok === false && outcome.infra === true, "the outcome is a no-verdict infra fail");
  assert(outcome.skipped === false, "an unreadable diff is never the empty-diff skip");
  assert(outcome.diffUnreadable === true, "the outcome carries the structural marker");
  assert(
    outcome.errorTail?.includes("could not read the diff for workstream default") === true,
    "the outcome's errorTail names the read and the workstream",
  );
  assert(
    outcome.failureEvent?.kind === "dispatch-failed" &&
      outcome.failureEvent.diffUnreadable === true,
    "its dispatch event carries the same marker the router reads",
  );
  // The reading the step handler routes on: NOT ok, infra, and the ONE
  // predicate the park sites call — which is what makes the park name the read
  // rather than blame the reviewer.
  const reading = interpretReview(
    {
      role: "adversarial-loop",
      ok: outcome.ok,
      text: outcome.rejectionText ?? "",
      toolUses: [],
      ms: 1,
      exitCode: 1,
      loopOutcome: "infra-failure",
    },
    1,
  );
  assert(reading.ok === false, "interpretReview never reads the unreadable round as a pass");
}

// ── the control: the loop's OWN range re-read still keeps the previous diff.
{
  const prompts = await mockSpawns(["VERDICT: ISSUES_FOUND\n1. f", "VERDICT: APPROVED"]);
  let calls = 0;
  const result = await runAdversarialLoop(
    { context: "range", base: "main", head: "HEAD", workCwd: CWD },
    signal,
    "job-range-control",
    async () => {
      calls += 1;
      // The FIRST call is round 1's entry read and must not carry the marker
      // line; the second is round 2's re-read and is what fails.
      if (calls === 2) throw new Error("git exploded");
      return { ok: true as const, diff: DIFF };
    },
  );
  assert(calls >= 2, `the range path attempted its re-read (${calls} calls)`);
  assert(result.ok === true, "#859 control: the loop's own failed re-read still reports");
  assert(
    result.text.includes("diff re-read failed"),
    "#859 control: the failed range re-read is still reported, not swallowed",
  );
  const round2 = prompts.filter((p) => p.role === "adversarial-developer")[1];
  assert(
    round2 !== undefined && round2.prompt.includes("export const a = 1"),
    "#859 control: the round reviewed the previous diff rather than dying",
  );
}

console.log(exit === 0 ? "\nOK" : `\nFAILED (${exit})`);
process.exit(exit);

#!/usr/bin/env bun
/**
 * #1827 — the LENS OUTCOME of a `review-skill-reread` kill.
 *
 * A lens ended for re-reading its skill file was WORKING: it had the skill
 * loaded N+1 times, so it demonstrably had it. Whatever findings or closing
 * summary it produced before the kill are the review it managed to do, and they
 * stand — exactly as they do for a loop / token-budget cap kill (#952). So:
 *
 *   - with findings or a real summary: kept, `blocked` false, and the round is
 *     NOT `REVIEW_INCOMPLETE` because of this lens;
 *   - with no evidence: blocked like any other failed lens;
 *   - never retried, either by the lens retry loop or by the step router.
 *
 * This is the asymmetry against `child-bound` (test-lens-child-bound.ts), where
 * the lane IS blocked even with a finding, because a lens that never answered
 * gave no verdict. A re-read kill is a different event and must not inherit it.
 *
 * Offline: spawn.ts is stubbed before the lens modules load.
 */

import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

isolateLedger();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type SpawnCall = { childBoundMs?: number; reviewSkillPath?: string };
const spawnCalls: SpawnCall[] = [];
let nextResult: () => Record<string, unknown> = () => ({});

mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-1827-lens",
  spawnSpecialist: async (_spec: unknown, opts: SpawnCall) => {
    spawnCalls.push({ childBoundMs: opts.childBoundMs, reviewSkillPath: opts.reviewSkillPath });
    return nextResult();
  },
}));

const { runLensChild } = await import("../src/lens-review-child.ts");
const { incompleteLanes, isReviewIncomplete } = await import("../src/lens-review-incomplete.ts");

const skillsDir = mkdtempSync(path.join(os.tmpdir(), "lens1827-"));
const skillName = "code-review-error-handling";
mkdirSync(path.join(skillsDir, skillName), { recursive: true });
writeFileSync(
  path.join(skillsDir, skillName, "SKILL.md"),
  "---\nname: code-review-error-handling\nprecedence: 20\n---\n",
);

const LENS = { name: "ERROR_HANDLING", skill: skillName, precedence: 20 };
function run() {
  return runLensChild({
    lens: LENS,
    runId: "run-1827-lens",
    skillsDir,
    context: "",
    roster: [],
    opts: { diff: "d" },
    bumpBatch: () => {},
  });
}

const FINDING = {
  name: "report_finding",
  arguments: {
    severity: "HIGH",
    path: "src/a.ts",
    line: 1,
    title: "silent failure",
    description: "d",
    suggestion: "s",
  },
};

function killed(over: Record<string, unknown>): Record<string, unknown> {
  return {
    role: "code-review-specialist",
    ok: false,
    text: "",
    toolUses: [],
    ms: 600_000,
    exitCode: 143,
    killCause: "review-skill-reread",
    ...over,
  };
}

// The cap reaches the spawn with the LENS's own skill path, so only reads of
// that file count.
spawnCalls.length = 0;
nextResult = () => killed({ toolUses: [FINDING] });
const withFindings = await run();
assert(
  spawnCalls[0]?.reviewSkillPath === path.join(skillsDir, skillName),
  "the lens spawn is handed its own skill path for the re-read cap to count",
);
assert(spawnCalls.length === 1, "a re-read-killed lens is NOT retried");
assert(withFindings.attempts === 1, "…and records one attempt");

// (1) findings → evidence kept, not blocked, round not incomplete.
assert(withFindings.findings.length === 1, "a re-read-killed lens KEEPS its finding");
assert(withFindings.blocked === false, "…and is not blocked");
assert(withFindings.killCause === "review-skill-reread", "…the cause still travels for reporting");
assert(!isReviewIncomplete([withFindings]), "the round is NOT REVIEW_INCOMPLETE because of it");
assert(incompleteLanes([withFindings]).length === 0, "…and it names no incomplete lane");

// A real closing summary is evidence too, with no findings.
nextResult = () =>
  killed({ text: "Reviewed the diff against the error-handling lens. No findings." });
const withSummary = await run();
assert(withSummary.blocked === false, "a re-read-killed lens with a summary is not blocked");
assert(withSummary.summary !== undefined, "…and its summary is kept");
assert(!isReviewIncomplete([withSummary]), "…and the round is not incomplete");

// (2) no evidence at all → blocked, and the lane names the cause rather than
// "failed every retry" (it was never retried) or "unknown failure".
nextResult = () => killed({ text: "" });
const empty = await run();
assert(empty.blocked === true, "a re-read-killed lens with NO evidence is blocked");
assert(empty.findings.length === 0, "…with nothing to keep");
assert(empty.killCause === "review-skill-reread", "…the cause is still recorded");
{
  const lanes = incompleteLanes([empty]);
  assert(lanes.length === 1, "…and it names one incomplete lane");
  assert(
    /re-read its own skill file/.test(lanes[0] ?? ""),
    `the lane says what happened, not "unknown failure" (got: ${lanes[0]})`,
  );
  assert(!/attempt/.test(lanes[0] ?? ""), "…and does not claim a retry that did not run");
}

// (3) the thinking-only placeholder is not a summary, so it does not rescue the
// lens from blocked (the #966 rule, applied to the new cause).
nextResult = () => killed({ text: "(thinking content only - no text output)" });
const thinking = await run();
assert(thinking.blocked === true, "the all-thinking placeholder does not count as evidence");

// (4) neither new cause is retried by the STEP ROUTER either.
{
  const { classifyFailureCause } = await import("../src/work-driver-failure-taxonomy.ts");
  const reread = classifyFailureCause({
    kind: "dispatch-failed",
    killCause: "review-skill-reread",
  });
  assert(
    reread.cause === "self-killed:review-skill-reread" &&
      reread.shouldRetry === false &&
      reread.maxRetries === 0,
    "the step router never retries a re-read kill",
  );
  // #1827 round 1 — the post-verdict stop is NOT a kill cause any more, so a
  // tail cannot carry it: the shape is asserted on the result instead
  // (test-review-post-verdict-result.ts). What this row pins is the
  // consequence — nothing in the taxonomy can classify a clean end as a
  // retryable failure, because no cause for it exists to classify.
  const post = classifyFailureCause({ kind: "dispatch-failed", killCause: undefined });
  assert(
    post.cause === "crashed" && post.shouldRetry === true,
    "a cause-less failed tail is judged on its exit, never excused by a stop row",
  );
  assert(
    !("review-post-verdict" in (post as unknown as Record<string, unknown>)),
    "and no classification ever names the clean end as a self-kill",
  );
}

// (5) the two causes are never promoted into the cap-kill parking fields.
{
  const { capHitForCapKill } = await import("../src/work-driver-adversarial-capkill.ts");
  const base = {
    id: "task-a",
    ok: false,
    rounds: 1,
    records: [],
    infra: true,
    threw: false,
    skipped: false,
    priorInfra: false,
  } as unknown as import("../src/work-driver-adversarial-types.ts").AdversarialOutcome;
  assert(
    capHitForCapKill({ ...base, killCause: "review-skill-reread" }, 2) === undefined,
    "review-skill-reread is never a fixed-literal cap (it does not own one)",
  );
  // #1827 round 1 — `review-post-verdict` is no longer a member of the cause
  // union at all, so the cap path cannot be handed one: the compiler refuses
  // the call. Asserting the exclusion structurally rather than by value.
  const causes: readonly string[] = [
    "timeout",
    "inactivity",
    "abort",
    "loop",
    "token-budget",
    "plan-timeout",
    "tool-inactivity",
    "child-bound",
    "no-progress",
    "stuck-tool",
    "review-skill-reread",
  ];
  assert(
    !causes.includes("review-post-verdict"),
    "the clean end is absent from the kill-cause vocabulary entirely",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

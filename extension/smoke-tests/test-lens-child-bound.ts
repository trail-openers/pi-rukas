#!/usr/bin/env bun
/**
 * #1564 — a lens that never answers is ended at its own run bound, its lane is
 * recorded not-reviewed, and the cap says so instead of "failed every retry".
 *
 *   1. runLensChild passes the lens bound (PI_ENSEMBLE_LENS_BOUND_MS, 30 min)
 *      to the spawn as `childBoundMs`.
 *   2. A `child-bound`-killed lens is spawned ONCE (never retried), blocked
 *      even when it reported a finding first (kept), and named not-reviewed.
 *   3. The REVIEW_INCOMPLETE cap-hit carries per-lane evidence, and its
 *      explanation names the lanes and never claims a retry that did not run.
 *
 * Offline: spawn.ts is stubbed before the lens modules load.
 */

import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const spawnCalls: Array<{ childBoundMs?: number }> = [];
mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-1564",
  spawnSpecialist: async (_spec: unknown, opts: { childBoundMs?: number }) => {
    spawnCalls.push({ childBoundMs: opts.childBoundMs });
    return {
      role: "code-review-specialist",
      ok: false,
      text: "[pi-rukas] ended at its run bound",
      toolUses: [
        {
          name: "report_finding",
          arguments: {
            severity: "LOW",
            path: "src/a.ts",
            line: 1,
            title: "early note",
            description: "d",
            suggestion: "s",
          },
        },
      ],
      ms: 2_400_000,
      exitCode: 143,
      killCause: "child-bound" as const,
    };
  },
}));

const { runLensChild } = await import("../src/lens-review-child.ts");
const { incompleteLanes } = await import("../src/lens-review-incomplete.ts");
const { applyLensVerdict } = await import("../src/work-driver-lens-verdicts.ts");
const { explainCap } = await import("../src/work-driver-explain.ts");
const { initialState } = await import("../src/workflow-state-update.ts");
const { renderSummary } = await import("../src/lens-review-render.ts");

const skillsDir = path.join(mkdtempSync(path.join(os.tmpdir(), "lens1564-")), "skills");
mkdirSync(path.join(skillsDir, "code-review-error-handling"), { recursive: true });
writeFileSync(
  path.join(skillsDir, "code-review-error-handling", "SKILL.md"),
  "---\nname: code-review-error-handling\nprecedence: 20\n---\n",
);

// (1) + (2)
delete process.env.PI_ENSEMBLE_LENS_BOUND_MS;
const bounded = await runLensChild({
  lens: { name: "ERROR_HANDLING", skill: "code-review-error-handling", precedence: 20 },
  runId: "run-1564",
  skillsDir,
  context: "",
  roster: [],
  opts: { diff: "d" },
  bumpBatch: () => {},
});
assert(spawnCalls[0]?.childBoundMs === 30 * 60_000, "the lens spawn carries the 30-min bound");
assert(spawnCalls.length === 1, "a child-bound-killed lens is not retried");
assert(bounded.attempts === 1, "...and records one attempt");
assert(bounded.blocked === true, "a lens ended at its bound is blocked (not reviewed)");
assert(bounded.findings.length === 1, "...its early finding is kept");
assert(/not reviewed/.test(bounded.parseError ?? ""), "...and its lane says not reviewed");
assert(bounded.killCause === "child-bound", "...with the child-bound kill cause");

// (4) #1242 — a round's lens bound never runs past the review-loop budget.
await runLensChild({
  lens: { name: "ERROR_HANDLING", skill: "code-review-error-handling", precedence: 20 },
  runId: "run-1564",
  skillsDir,
  context: "",
  roster: [],
  opts: { diff: "d", childBoundMs: 5 * 60_000 },
  bumpBatch: () => {},
});
assert(spawnCalls[1]?.childBoundMs === 5 * 60_000, "the round's lens bound reaches the spawn");
{
  const { lensRoundChildBoundMs } = await import("../src/work-driver-lens-round-budget.ts");
  delete process.env.PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS;
  delete process.env.PI_ENSEMBLE_CHILD_BOUND_GRACE_MS;
  const MIN = 60_000;
  const now = 1_000 * MIN;
  const at = (startedMinAgo?: number) => {
    const s = initialState(1242);
    return startedMinAgo === undefined
      ? s
      : {
          ...s,
          pipelineState: { ...s.pipelineState, reviewCapStartedAt: now - startedMinAgo * MIN },
        };
  };
  assert(lensRoundChildBoundMs(at(), now) === 30 * MIN, "no review clock: the lens's own 30 min");
  assert(lensRoundChildBoundMs(at(0), now) === 30 * MIN, "first round: the lens's own 30 min");
  assert(
    lensRoundChildBoundMs(at(75), now) === 5 * MIN,
    "15 min of the 90-min loop left: wrap up at 5 min, killed at the cap",
  );
  assert(lensRoundChildBoundMs(at(95), now) === MIN, "past the cap: a 1-min floor");
}

// (3)
const failed = {
  lens: "SECURITY" as const,
  ok: false,
  ms: 1,
  findings: [],
  attempts: 4,
  blocked: true,
  parseError: "attempt 4/4: exit 1",
};
const silent = {
  lens: "PERFORMANCE" as const,
  ok: true,
  ms: 1,
  findings: [],
  attempts: 1,
  blocked: false,
};
const lanes = incompleteLanes([bounded, failed, silent]);
assert(lanes.length === 3, "every incomplete lane is named");
assert(lanes[0]?.startsWith("ERROR_HANDLING: not reviewed"), "the bounded lane is not-reviewed");
assert(
  lanes[1] === "SECURITY: attempt 4/4: exit 1 (4 attempts)",
  "the failed lane names its tries",
);
assert(/PERFORMANCE: not reviewed/.test(lanes[2] ?? ""), "the silent lane is not-reviewed");

const summary = {
  verdict: "REVIEW_INCOMPLETE" as const,
  totalFindings: 1,
  bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 1 },
  lenses: [bounded],
  findings: bounded.findings,
};
const next = await applyLensVerdict(
  summary,
  "job-1",
  1,
  {} as never,
  initialState(1564),
  // #1774 — required: the head THIS round read. REVIEW_INCOMPLETE records none.
  undefined,
);
const cap = next.eventLog.find((e) => e.kind === "cap-hit");
assert(
  cap?.kind === "cap-hit" && cap.cap === "review-incomplete",
  "the round caps review-incomplete",
);
assert(
  cap?.kind === "cap-hit" && /ERROR_HANDLING: not reviewed/.test(cap.evidence ?? ""),
  "the cap-hit evidence names the not-reviewed lane",
);
const why = explainCap("review-incomplete", next);
assert(/ERROR_HANDLING: not reviewed/.test(why), "the handoff explanation names the lane");
assert(!/every retry/.test(why), "the explanation does not claim a retry that never ran");
assert(
  !/every retry/.test(explainCap("review-incomplete", initialState(1))),
  "nor does the no-evidence fallback",
);
const rendered = renderSummary({ ...summary, lenses: [bounded] }, 4);
assert(
  rendered.includes("returned no verdict within the lens bound (not reviewed, not retried)"),
  "the review banner says the lane was not reviewed, not that it failed all attempts",
);

rmSync(path.dirname(skillsDir), { recursive: true, force: true });
process.exit(exit);

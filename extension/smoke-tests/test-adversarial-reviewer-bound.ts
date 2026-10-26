#!/usr/bin/env bun
/**
 * #1827 — the adversarial reviewer carries a per-child bound; the fix-pass
 * developer child does not.
 *
 * Before this, `makeRunPhase` passed the inner spawn only
 * runId/tag/onProgress/onRawEvent/onStdin: no `childBoundMs`, no `onSteer`, so
 * the only thing that ended a runaway reviewer was the 2-h spawn backstop
 * (measured: 476 turns / 80M tokens on one round). Both halves matter —
 * `armChildBound` writes its wrap-up steer to raw `stdin` when no `onSteer` is
 * supplied, so a bound without the steer seam is a silent kill.
 *
 * Offline: spawn.ts is stubbed before `adversarial.ts` loads, so no child runs.
 * The two roles are driven through the REAL loop (one ISSUES_FOUND round, which
 * provokes both a review dispatch and a fix dispatch) so role is the only
 * discriminator — exactly the shape the acceptance criterion is written against.
 */

import { mock } from "bun:test";
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

type SpawnCall = {
  role: string;
  tag?: string;
  childBoundMs?: number;
  onSteer?: unknown;
  reviewSkillPath?: string;
};

const spawnCalls: SpawnCall[] = [];

mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-1827-bound",
  spawnSpecialist: async (
    spec: { role: string },
    opts: { tag?: string; childBoundMs?: number; onSteer?: unknown; reviewSkillPath?: string },
  ) => {
    spawnCalls.push({
      role: spec.role,
      tag: opts.tag,
      childBoundMs: opts.childBoundMs,
      onSteer: opts.onSteer,
      reviewSkillPath: opts.reviewSkillPath,
    });
    return {
      role: spec.role,
      ok: true,
      text:
        spec.role === "adversarial-developer"
          ? "VERDICT: ISSUES_FOUND\n1. silent failure on the bound path"
          : "fixed",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    };
  },
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

const { runAdversarialLoop } = await import("../src/adversarial.ts");
const { adversarialChildBoundMs } = await import("../src/review-bounds.ts");
const { adversarialSkillPath, skillFileOf } = await import("../src/adversarial-skill-path.ts");

const signal = new AbortController().signal;

await runAdversarialLoop(
  { diff: "diff --git a/a.ts b/a.ts\n+hello", context: "bound", workCwd: process.cwd() },
  signal,
  "job-1827-bound",
);

const reviewer = spawnCalls.find((c) => c.role === "adversarial-developer");
const fix = spawnCalls.find((c) => c.role === "developer");

// Every review dispatch in the run carries the bound; every fix dispatch lacks
// it. One round each is what the shape below asserts, and the loop ran both
// because the reviewer returned ISSUES_FOUND.
assert(
  spawnCalls.filter((c) => c.role === "adversarial-developer").every((c) => !!c.childBoundMs),
  "every reviewer dispatch in the run carries a bound",
);
assert(
  spawnCalls.filter((c) => c.role === "developer").every((c) => c.childBoundMs === undefined),
  "no fix-pass dispatch carries a bound",
);

assert(reviewer !== undefined, "loop dispatched the adversarial reviewer");
assert(
  reviewer?.childBoundMs === adversarialChildBoundMs(),
  `reviewer carries its own per-child bound (${adversarialChildBoundMs()}ms)`,
);
assert(
  typeof reviewer?.onSteer === "function",
  "reviewer carries an onSteer seam (a bound without it kills silently)",
);
assert(
  reviewer?.reviewSkillPath === adversarialSkillPath(),
  "reviewer is handed the driver-computed path to its own skill",
);
assert(
  typeof reviewer?.reviewSkillPath === "string" &&
    reviewer.reviewSkillPath.length > 0 &&
    reviewer.reviewSkillPath.endsWith("adversarial-developer"),
  "the reviewer skill path is a skill DIRECTORY (its SKILL.md is what the cap counts)",
);
assert(
  skillFileOf(adversarialSkillPath()).endsWith("adversarial-developer/SKILL.md"),
  "the counted file is <skillDir>/SKILL.md",
);
assert(
  adversarialChildBoundMs() > 0 && adversarialChildBoundMs() <= 30 * 60_000,
  "the default bound is 30 minutes like a lens child's, so it fires before the 2-h backstop",
);

// The knob is an operator override, and it must be the one the bound reads.
{
  const saved = process.env.PI_ENSEMBLE_ADVERSARIAL_BOUND_MS;
  process.env.PI_ENSEMBLE_ADVERSARIAL_BOUND_MS = "60000";
  assert(adversarialChildBoundMs() === 60_000, "PI_ENSEMBLE_ADVERSARIAL_BOUND_MS overrides");
  process.env.PI_ENSEMBLE_ADVERSARIAL_BOUND_MS = "0";
  assert(
    adversarialChildBoundMs() === 30 * 60_000,
    "a non-positive override falls back to the 30-min default (never unbounded)",
  );
  if (saved === undefined) delete process.env.PI_ENSEMBLE_ADVERSARIAL_BOUND_MS;
  else process.env.PI_ENSEMBLE_ADVERSARIAL_BOUND_MS = saved;
}

// The fix pass: neither bound, and no skill path to count against.
assert(fix !== undefined, "loop dispatched the fix-pass developer");
assert(fix?.childBoundMs === undefined, "the fix-pass developer gets NO per-child bound");
assert(fix?.onSteer === undefined, "the fix-pass developer gets NO bound steer seam");
assert(fix?.reviewSkillPath === undefined, "the fix-pass developer gets NO review skill path");

console.log(`\nexit ${exit}`);
process.exit(exit);

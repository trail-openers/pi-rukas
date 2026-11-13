#!/usr/bin/env bun
/**
 * The lean review seam hands the loop a PAIR, and the pair is one decision.
 *
 * `reviewDeps().adversarial` is the only caller that renders a criteria section,
 * and it does so by threading the loop two things at once: `issueBody` with its
 * `pi-spec v1` block stripped, and `reviewCriteria` with the block's criteria as
 * their own section. Getting either half wrong is invisible from the step's own
 * assertions — the reviewer's prompt is assembled two frames deeper, inside
 * `runAdversarialLoop`:
 *
 *   - strip without a section → the child loses the criteria;
 *   - a section without the strip → the block reaches the child twice, as JSON and
 *     as rendered rows;
 *   - the switch off → neither, and the loop re-derives from the RAW body exactly
 *     as it did before the split existed.
 *
 * Each case asserts on what the CHILD received — `spawnSpecialist`'s prompt and
 * `SpawnOptions`, the convention `test-adversarial-reviewer-budget.ts` and
 * `test-lens-turn-ceiling-lean.ts` use — so an implementation that dropped the
 * arguments on the floor inside the loop cannot pass.
 *
 * Offline: the child is a mocked spawn, no model, no token.
 */

import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { LEAN_REVIEW_CRITERIA_HEADING } from "../src/lean/review-criteria.ts";
import { reviewDeps } from "../src/lean/review-deps.ts";
import type { ReviewDeps } from "../src/lean/review.ts";
import type { DispatchResult } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

isolateLedger();

const G = (cwd: string, ...args: string[]) =>
  execp(`git ${args.map((a) => `'${a}'`).join(" ")}`, { cwd, maxBuffer: 64 * 1024 * 1024 });

const { assert, failures } = makeAssert();

/** What the reviewer child was actually dispatched with. */
interface Spawned {
  role: string;
  prompt: string;
  cwd?: string;
}

const spawned: Spawned[] = [];

mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-review-deps-criteria",
  spawnSpecialist: async (spec: Spawned): Promise<DispatchResult> => {
    spawned.push({ role: spec.role, prompt: spec.prompt, cwd: spec.cwd });
    return {
      role: spec.role,
      ok: true,
      text: "VERDICT: APPROVED",
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
  clearBatchEntry: () => {},
  clearEntry: () => {},
  startBatchEntry: () => {},
  updateBatchProgress: () => {},
}));
const realRegistry = await import("../src/async-jobs-registry.ts");
mock.module(new URL("../src/async-jobs-registry.ts", import.meta.url).href, () => ({
  ...realRegistry,
  childHandles: new Map(),
  registerChildHandle: () => {},
  setOrchestratorActiveChild: () => {},
  markOrchestrator: () => {},
}));

const SPEC_BODY = `Add a quota check to the meter.

The check runs before any state is written.

\`\`\`pi-spec v1
${JSON.stringify(
  {
    problem: "The meter must refuse the draw once the quota is spent.",
    criteria: [
      { id: "AC1", text: "The meter refuses the draw once the quota is spent.", verify: "test" },
      {
        id: "AC2",
        text: "The refusal names the quota that was exceeded.",
        verify: "command",
        command: "bun test meter",
      },
    ],
    size: "M",
  },
  null,
  2,
)}
\`\`\`
`;

const repoRoot = mkdtempSync(path.join(os.tmpdir(), "lean-review-deps-criteria-"));

/** A two-commit repo: the loop computes `git diff <base>...<head>`, so the seam
 * needs refs that exist — a stubbed diff would skip the loop's own diff path. */
async function mkRunRepo(): Promise<{ cwd: string; base: string; head: string }> {
  gitTestEnv();
  const dir = path.join(repoRoot, "repo");
  mkdirSync(dir, { recursive: true });
  await G(dir, "init", "-q", "-b", "main");
  await G(dir, "config", "user.email", "t@t");
  await G(dir, "config", "user.name", "T");
  writeFileSync(path.join(dir, "meter.ts"), "export const draw = () => 1;\n");
  await G(dir, "add", "-A");
  await G(dir, "commit", "-q", "-m", "base");
  await G(dir, "checkout", "-qb", "lean/issue-7");
  writeFileSync(path.join(dir, "meter.ts"), "export const draw = () => (spent ? 0 : 1);\n");
  await G(dir, "add", "-A");
  await G(dir, "commit", "-q", "-m", "feat: refuse the draw once the quota is spent");
  return {
    cwd: dir,
    base: (await G(dir, "rev-parse", "HEAD~1")).stdout.trim(),
    head: (await G(dir, "rev-parse", "HEAD")).stdout.trim(),
  };
}

const repo = await mkRunRepo();

/** Drive the production `adversarial` seam and return the reviewer's brief. */
async function reviewerBrief(): Promise<string> {
  spawned.length = 0;
  const deps: ReviewDeps = reviewDeps(false);
  await deps.adversarial({
    issue: 7,
    wave: "full",
    base: repo.base,
    head: repo.head,
    cwd: repo.cwd,
    branch: "lean/issue-7",
    issueBody: SPEC_BODY,
    headless: false,
    blockingFindings: "- [HIGH] SECURITY src/meter.ts:12: the draw is unguarded",
    budget: { opts: {}, fired: () => undefined },
  } as never);
  const reviewer = spawned.filter(
    (s) =>
      s.role === "adversarial-developer" && s.prompt.includes("You are reviewing the diff below"),
  );
  assert(
    reviewer.length === 1,
    `the seam dispatched exactly one reviewer (saw ${String(reviewer.length)})`,
  );
  return reviewer[0]?.prompt ?? "";
}

try {
  await withEnv({ PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT: undefined }, async () => {
    const brief = await reviewerBrief();
    // Non-vacuity: the body really carries the block's JSON, so the absence of that
    // JSON below is a fact about the seam's strip and not about a body that never
    // had a block to print.
    assert(
      SPEC_BODY.includes('"problem"') && SPEC_BODY.includes("pi-spec v1"),
      "on: the fixture body carries a parsable spec block with JSON keys to look for",
    );
    assert(
      brief.length > 500 && brief.includes("diff"),
      `on: the reviewer's brief is a real prompt (${String(brief.length)} chars)`,
    );
    assert(
      brief.includes(LEAN_REVIEW_CRITERIA_HEADING),
      "on: the reviewer's prompt carries the criteria section the seam rendered",
    );
    assert(
      brief.includes("- **AC1** [test]") && brief.includes("- **AC2** [command]"),
      "on: every criterion arrives as a rendered row, with its verify kind",
    );
    assert(
      brief.includes("bun test meter"),
      "on: and a command criterion keeps the command the spec states",
    );
    const outsideSection = brief
      .split(brief.slice(brief.indexOf(LEAN_REVIEW_CRITERIA_HEADING)))
      .join("");
    assert(
      !outsideSection.includes('"problem"') && !outsideSection.includes("pi-spec v1"),
      "on: the block's JSON reaches the child nowhere outside the criteria section — the seam stripped the prose it handed the loop",
    );
    assert(
      brief.includes("quota check to the meter"),
      "on: the issue's own prose is still there — a strip that took the body too is the other way this fails",
    );
    assert(
      brief.includes("the draw is unguarded"),
      "on: the carried blocking finding still reaches the reviewer beside the criteria",
    );
  });

  await withEnv({ PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT: "0" }, async () => {
    const brief = await reviewerBrief();
    assert(
      !brief.includes(LEAN_REVIEW_CRITERIA_HEADING),
      "off: the seam renders no criteria section",
    );
    assert(
      brief.includes('"problem"') && brief.includes("pi-spec v1"),
      "off: the reviewer reads the RAW block again — the seam handed the loop the body unstripped, which is what makes the off arm today's prompt",
    );
    assert(
      !brief.includes("- **AC1** [test]"),
      "off: and no rendered criteria rows appear, so nothing was half-split",
    );
  });
} finally {
  rmSync(repoRoot, { recursive: true, force: true });
}

console.log(
  `\n${failures() === 0 ? "seam pair green" : "seam pair RED"} (${String(failures())} failing)`,
);
process.exit(failures());

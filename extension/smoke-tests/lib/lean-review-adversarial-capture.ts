/**
 * lib/lean-review-adversarial-capture — the adversarial seat's prompt, captured
 * where it is actually assembled.
 *
 * `lib/lean-review-ticket-fixture.ts` proves what the STEP hands its gates; it
 * stubs `deps.adversarial`, so it cannot see inside `runAdversarialLoop`, where
 * the reviewer's prompt is built two frames deeper. An assertion on the args the
 * seam received would pass on a loop that dropped them on the floor. So this
 * harness installs a `spawnSpecialist` mock — the shape
 * `lib/adversarial-reviewer-harness.ts` uses — and every adversarial assertion
 * below runs on the string the child was ACTUALLY dispatched with.
 *
 * The step is run for real over a real temp repo, with the lens gate stubbed
 * clean, so the review reaches both adversarial passes (the pre-fix gate never
 * runs when neither gate blocks — the lenses block once to buy the wave).
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

import { mock } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import { reviewDeps } from "../../src/lean/review-deps.ts";
import type { ReviewDeps } from "../../src/lean/review.ts";
import { FIXER_ROLE } from "../../src/lean/step-budget.ts";
import { DEFAULT_REVIEW_THRESHOLD } from "../../src/review-severity-default.ts";
import type { DispatchResult } from "../../src/types.ts";
import {
  BRANCH,
  blockingFinding,
  cleanupRoots,
  ctxFor,
  lensRoundFor,
  makeRepo,
  result,
  setup,
} from "./lean-review-fixtures.ts";
import { stepGitEnv } from "./lean-review-fixtures.ts";
import { isolateLedger } from "./review-ledger-test-helpers.ts";

isolateLedger();

/** Every prompt a child was dispatched with, by role. */
const prompts: { role: string; prompt: string }[] = [];

mock.module(new URL("../../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-lean-review-spec-split",
  spawnSpecialist: async (
    spec: { role: string; prompt: string },
    _opts: Record<string, unknown>,
  ): Promise<DispatchResult> => {
    prompts.push({ role: spec.role, prompt: spec.prompt });
    return {
      role: spec.role,
      ok: true,
      // The reviewer prints a verdict the loop can parse, so the pass reaches its
      // report-only return rather than an infrastructure refusal.
      text: spec.role === "adversarial-developer" ? "VERDICT: APPROVED" : "fixed",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    };
  },
}));

const realRegistry = await import("../../src/async-jobs-registry.ts");
mock.module(new URL("../../src/async-jobs-registry.ts", import.meta.url).href, () => ({
  ...realRegistry,
  childHandles: new Map(),
  registerChildHandle: () => {},
  setOrchestratorActiveChild: () => {},
  markOrchestrator: () => {},
}));

const { reviewOutcome } = await import("../../src/lean/review.ts");

/** What every review seat was dispatched with. */
export interface CapturedBriefs {
  /** The `context` of every lens round, in call order. */
  contexts: string[];
  /** The prompt of every fixer dispatch, in call order. */
  fixBriefs: string[];
  /** The prompt the ADVERSARIAL reviewer child was actually dispatched with —
   * captured at the spawn, not at the seam. */
  adversarialBriefs: string[];
  /** The step's outcome kind, or the error it threw. */
  verdict: string;
}

/**
 * Run one review step over `issueBody` and return what its seats received.
 *
 * The lens gate blocks once and clears on the re-review, which is the shape that
 * reaches all three seats: the adversarial gate, the fixer and both lens passes.
 */
export async function runReviewStepCapturingAll(issueBody: string): Promise<CapturedBriefs> {
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const q = 1;\n" });
  prompts.length = 0;
  const contexts: string[] = [];
  let lensCalls = 0;
  let fixCounter = 0;
  const env = stepGitEnv();
  const deps: ReviewDeps = reviewDeps(false);
  deps.fetchIssueBody = async () => issueBody;
  deps.loadConfig = async () => defaultConfig();
  deps.reviewThreshold = async () => DEFAULT_REVIEW_THRESHOLD;
  deps.prComment = undefined;
  deps.lens = async (a) => {
    contexts.push(a.context);
    lensCalls++;
    if (lensCalls === 1) {
      return lensRoundFor({ wave: "full", head: a.head }, "ISSUES_FOUND", [blockingFinding()]);
    }
    return lensRoundFor({ wave: "fix", since: a.since, head: a.head }, "APPROVED", []);
  };
  // The FIXER is dispatched through this seam with the rendered brief; the lens
  // children and the reviewer come through the mocked `spawnSpecialist`. Both are
  // captured, because the brief is built at the print site in one case and inside
  // the loop in the other.
  const fixBriefs: string[] = [];
  deps.dispatch = async (spec) => {
    fixBriefs.push(spec.prompt);
    const wt = spec.cwd ?? "";
    if (existsSync(wt)) {
      fixCounter++;
      const name = `split-fix-${String(fixCounter)}.ts`;
      writeFileSync(path.join(wt, name), `export const x = ${String(fixCounter)};\n`);
      await execp("git", { argv: ["add", "-A"], cwd: wt, env });
      await execp("git", {
        argv: ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `fix: ${name}`],
        cwd: wt,
        env,
      });
    }
    return result({ role: FIXER_ROLE });
  };

  let verdict = "";
  try {
    const outcome = await reviewOutcome(ctxFor(repoRoot, baseSha, BRANCH), deps);
    verdict = String((outcome as { kind?: string }).kind ?? "unknown");
  } catch (err) {
    verdict = `threw: ${(err as Error).message.slice(0, 120)}`;
  } finally {
    cleanupRoots();
  }
  return {
    contexts,
    fixBriefs,
    adversarialBriefs: prompts
      .filter((p) => p.role === "adversarial-developer")
      .map((p) => p.prompt),
    verdict,
  };
}

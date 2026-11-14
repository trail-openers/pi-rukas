/**
 * lib/lean-review-problem-capture — one review step's briefs, for the statement
 * of the problem.
 *
 * `lib/lean-review-adversarial-capture.ts` installs its `spawnSpecialist` mock
 * at module load, and `mock.module` is process-wide: a second file in the same
 * `bun test` process cannot install a competing mock of the same specifier. So
 * the problem-section cases run their own step in their own module, with the
 * same shape — the lens gate blocks once to buy the wave, the fixer commits, the
 * re-review clears — and capture every brief the step dispatched.
 *
 * The env pin belongs to the CALLER and is applied around this call: the step
 * reads the two review switches at call time, so a `withEnv` here would have to
 * be opened by whoever wants to measure an arm.
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
  makeRunId: () => "run-lean-review-problem",
  spawnSpecialist: async (
    spec: { role: string; prompt: string },
    _opts: Record<string, unknown>,
  ): Promise<DispatchResult> => {
    prompts.push({ role: spec.role, prompt: spec.prompt });
    return {
      role: spec.role,
      ok: true,
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

/** What the three review seats were dispatched with. */
export interface ProblemCaptured {
  contexts: string[];
  fixBriefs: string[];
  adversarialBriefs: string[];
  verdict: string;
}

/** Run one review step over `issueBody` and return what its seats received. */
export async function runReviewStepCapturingProblem(
  issueBody: string,
): Promise<ProblemCaptured> {
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const q = 1;\n" });
  prompts.length = 0;
  const contexts: string[] = [];
  let lensCalls = 0;
  let fixCounter = 0;
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
  const fixBriefs: string[] = [];
  deps.dispatch = async (spec) => {
    fixBriefs.push(spec.prompt);
    const wt = spec.cwd ?? "";
    if (existsSync(wt)) {
      fixCounter++;
      const name = `problem-fix-${String(fixCounter)}.ts`;
      writeFileSync(path.join(wt, name), `export const x = ${String(fixCounter)};\n`);
      await execp("git", { argv: ["add", "-A"], cwd: wt, env: stepGitEnv() });
      await execp("git", {
        argv: ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `fix: ${name}`],
        cwd: wt,
        env: stepGitEnv(),
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
    adversarialBriefs: prompts.filter((p) => p.role === "adversarial-developer").map((p) => p.prompt),
    verdict,
  };
}

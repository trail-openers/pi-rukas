/**
 * lib/lean-review-ticket-fixture — drives the lean `review` step far enough to
 * capture what its children were actually dispatched with.
 *
 * The pure renderers (`lensContext`, `fixPrompt`) can be asserted directly, but
 * that only proves the renderer prints the block — not that the step hands the
 * one `issueBody` it read to BOTH lens passes and to the fixer. So this harness
 * runs the real step over a real repo and a real branch, with the gates and the
 * fixer stubbed, and returns the strings the children received.
 *
 * The fixer stub COMMITS, through the step's own real `exec`, in the tree the
 * step dispatched it to: `assertFixAdvanced` refuses a wave whose head did not
 * move, and a refusal before the re-review would mean the second lens pass —
 * the second of the two passes this file exists to cover — never ran.
 *
 * Lives in lib/ rather than as a `test-*.ts` file so the smoke glob never
 * self-executes it.
 */

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import type { ReviewDeps } from "../../src/lean/review.ts";
import { FIXER_ROLE } from "../../src/lean/step-budget.ts";
import { DEFAULT_REVIEW_THRESHOLD } from "../../src/lens-review-format.ts";
import type { DispatchSpec } from "../../src/types.ts";
import {
  BRANCH,
  blockingFinding,
  cleanLensRound,
  ctxFor,
  depsWith,
  lensRoundFor,
  makeRepo,
  result,
  setup,
  stepGitEnv,
} from "./lean-review-fixtures.ts";

/** What the step's children were dispatched with. */
export interface CapturedBriefs {
  /** The `context` of every lens round, in call order (full round first). */
  contexts: string[];
  /** The rendered prompt of every fixer dispatch, in call order. */
  fixBriefs: string[];
  /** The step's outcome kind, or the error it threw — so a case cannot be
   * green on an empty capture without saying so. */
  verdict: string;
}

let fixCounter = 0;

/**
 * Run one review step whose gates block once, so the fix wave and the
 * re-review both run — the shape that reaches all three prompt sites.
 */
export async function runReviewStep(issueBody: string): Promise<CapturedBriefs> {
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const q = 1;\n" });
  const contexts: string[] = [];
  const fixBriefs: string[] = [];
  let lensCalls = 0;
  const env = stepGitEnv();
  const git = async (args: string[], cwd: string): Promise<void> => {
    await execp("git", { argv: args, cwd, env });
  };
  const deps: ReviewDeps = depsWith({
    fetchIssueBody: async () => issueBody,
    loadConfig: async () => defaultConfig(),
    reviewThreshold: async () => DEFAULT_REVIEW_THRESHOLD,
    adversarial: async () => result({ loopOutcome: "approved" }),
    lens: async (a) => {
      contexts.push(a.context);
      lensCalls++;
      // The full round blocks (so the wave is bought); the re-review clears it
      // (so the step reaches its clean pass rather than handing back).
      if (lensCalls === 1) {
        return lensRoundFor({ wave: "full", head: a.head }, "ISSUES_FOUND", [blockingFinding()]);
      }
      return lensRoundFor({ wave: "fix", since: a.since, head: a.head }, "APPROVED", []);
    },
    dispatch: async (spec: DispatchSpec) => {
      fixBriefs.push(spec.prompt);
      const wt = spec.cwd as string;
      if (existsSync(wt)) {
        fixCounter++;
        const name = `ticket-fix-${String(fixCounter)}.ts`;
        writeFileSync(path.join(wt, name), `export const x = ${String(fixCounter)};\n`);
        await git(["add", "-A"], wt);
        await git(
          ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `fix: ${name}`],
          wt,
        );
      }
      return result({ role: FIXER_ROLE });
    },
  });
  const ctx: HandlerCtx = ctxFor(repoRoot, baseSha, BRANCH);
  const { reviewOutcome } = await import("../../src/lean/review.ts");
  let verdict = "";
  try {
    const outcome = await reviewOutcome(ctx, deps);
    verdict = String((outcome as { kind?: string }).kind ?? "unknown");
  } catch (err) {
    verdict = `threw: ${(err as Error).message.slice(0, 120)}`;
  }
  return { contexts, fixBriefs, verdict };
}

void cleanLensRound;

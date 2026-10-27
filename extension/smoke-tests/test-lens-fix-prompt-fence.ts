#!/usr/bin/env bun
/**
 * #1852 — the lens-fix prompt prints THE FENCE THE GATE READS.
 *
 * The adversarial fix pass has had the prompt==gate equality since #1846
 * (`test-fix-pass-prompt-fence.ts` pins it). The lens-fix step had neither a
 * fence nor an equality to pin: `inlineLensFixPrompt` printed no declared paths,
 * no `outOfScope` list and no fan-out ceiling, and the landing arms committed and
 * pushed whatever the fixer wrote anywhere in the tree.
 *
 * This file pins the prompt half of #1852 for BOTH prompts — the ordinary
 * dispatch (`inlineLensFixPrompt`) and the re-dispatch branch, which is a second
 * inline literal built alongside that function and is exactly where the #1156
 * test-scope rule got dropped once. Each is compared against the plan-time fence
 * `lensFixPassPlan` built, i.e. against the SAME object the gate at the
 * adversarial step reads — not against a second rendering the test could keep
 * stale.
 *
 * The permitted asymmetry is the fix pass's own: the post-dispatch terms
 * (`passChanged`, the admitted slot count, the per-slot file sets) are filled in
 * by `gateFenceView` at the gate and never appear in the prompt.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { defaultExec } from "../src/work-driver-adversarial-fix-git.ts";
import {
  lensFixFenceLines,
  lensFixPassPlan,
} from "../src/work-driver-lens-fix-fence.ts";
import { fixPassFenceLines } from "../src/work-driver-fix-pass-fence-render.ts";
import { inlineLensFixPrompt, runLensFix } from "../src/work-driver-lens-fix.ts";
import { initialState } from "../src/workflow-state.ts";
import { git, repoWithFile } from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const FINDINGS =
  '[{"path":"a.txt","line":1,"severity":"MEDIUM","title":"t","suggestion":"s"}]';

/** `initialState` does not take a review round, and a lens round is 1 — a
 *  round-0 state reads as "no lens round has run", which is not the fixture. */
function lensRound(s: ReturnType<typeof initialState>): ReturnType<typeof initialState> {
  return { ...s, pipelineState: { ...s.pipelineState, reviewRound: 1 } };
}

/** A repo + a real `.worktrees/` lens tree with one commit, as a lens round starts. */
function lensFixture(label: string): { repoRoot: string; worktree: string; roundTip: string } {
  const repoRoot = repoWithFile(label);
  const tree = `${repoRoot}/.worktrees/issue-1852`;
  git(repoRoot, "worktree add -q --detach .worktrees/issue-1852 HEAD");
  writeFileSync(`${tree}/a.txt`, "two\n");
  git(tree, "add -A");
  git(tree, 'commit -q -m "develop: the feature"');
  return { repoRoot, worktree: tree, roundTip: git(tree, "rev-parse HEAD").trim() };
}

function fenceState(repoRoot: string, worktree: string, declared: string[], outOfScope: string[]) {
  const s = lensRound(initialState(1852, 1_000_000));
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "lens-fix" as const,
      baseSha: git(repoRoot, "rev-parse HEAD").trim(),
      worktrees: { default: worktree },
      workstreams: {
        default: { id: "default", scope: "fix", paths: declared, outOfScope },
      },
      reviewRound: 1,
    },
  };
}

console.log("# the lens-fix prompt prints the fence the gate reads");
{
  const t = lensFixture("1852-prompt");
  const st = fenceState(t.repoRoot, t.worktree, ["a.txt"], ["b.txt"]);
  const planned = await lensFixPassPlan(defaultExec, t.repoRoot, st.pipelineState, {
    id: "default",
    worktree: t.worktree,
    roundTip: t.roundTip,
    findings: FINDINGS,
  });
  if (!planned.ok) throw new Error(`lensFixPassPlan failed: ${planned.reason}`);
  const fence = lensFixFenceLines(planned.value);
  const prompt = inlineLensFixPrompt(FINDINGS, "/tmp/scratch", fence);

  assert(
    prompt.includes(fence.join("\n")),
    "the ordinary lens-fix prompt contains the plan-time fence block verbatim (prompt == the fence the gate reads)",
  );
  assert(
    fence.some((l) => l.includes("`a.txt`")) && fence.some((l) => l.includes("`b.txt`")),
    `the fence names the declared path and the outOfScope entry (got ${JSON.stringify(fence)})`,
  );
  // #1852-3: the render is pass-neutral, so the LENS fix names its own cap and
  // never tells the fixer it is bounded by the fix pass's.
  assert(
    fence.some((l) => l.includes("lens-fix-scope")) && !fence.some((l) => l.includes("fix-pass-park")),
    "the lens-fix fence names cap `lens-fix-scope` and never the fix pass's cap",
  );
  assert(
    fence.some((l) => l.includes("this lens fix")) && !fence.some((l) => l.includes("this fix pass")),
    "the fence block calls the dispatch a lens fix, not a fix pass",
  );
  // The fix pass's own rendering is unchanged by the new parameters.
  const fixPass = fixPassFenceLines(planned.value.fence);
  assert(
    fixPass.some((l) => l.includes("this fix pass")) && fixPass.some((l) => l.includes("fix-pass-park")),
    "the fix pass's own fence render keeps its original nouns and cap (PM decision #1852-3)",
  );
  // The post-dispatch terms are the permitted asymmetry: never printed.
  assert(
    !fence.some((l) => l.includes("passChanged") || l.includes("admitting slot(s): undefined")),
    "the prompt prints no post-dispatch term beyond the fence's own ceiling basis",
  );
  rmSync(t.repoRoot, { recursive: true, force: true });
}

console.log("# the RE-DISPATCH prompt prints the same fence");
{
  // Driven through the real `runLensFix` with a captured dispatch, so the
  // assertion is on what the driver really sends rather than a copy of the
  // resend literal this file could keep stale. The resend fires when the round
  // already carries a `lens-fix-empty-resend` event AND the tree reads clean
  // with nothing committed ahead of the branch.
  const t = lensFixture("1852-resend");
  const st = fenceState(t.repoRoot, t.worktree, ["a.txt"], ["b.txt"]);
  const planned = await lensFixPassPlan(defaultExec, t.repoRoot, st.pipelineState, {
    id: "default",
    worktree: t.worktree,
    roundTip: t.roundTip,
    findings: FINDINGS,
  });
  if (!planned.ok) throw new Error(`lensFixPassPlan failed: ${planned.reason}`);
  const fence = lensFixFenceLines(planned.value);

  const prompts: string[] = [];
  const prevResume = process.env.PI_ENSEMBLE_RESUME;
  process.env.PI_ENSEMBLE_RESUME = "0";
  try {
    const ctx = {
      host: { sendUserMessage: () => {}, emit: () => {} } as unknown as DriverContext["host"],
      repoRoot: t.repoRoot,
      issue: 1852,
      // Clean tree, nothing committed ahead: the resend shape. `branchName` is
      // empty so the #981 reposition gate is skipped on its own condition and
      // the prompt (not the gate) is what is exercised. The step's reads all go
      // through one argv-aware exec, so each of the three shapes the step makes
      // is answered for real: `status --porcelain` = clean, `rev-list --count`
      // = 0 ahead, `rev-parse HEAD` = the round tip the fence was built from.
      // A stub returning "" for all three would make the committed-count
      // unreadable, which is NOT the resend shape (#749).
      verifyExecFn: async (_cmd: string, opts?: { argv?: string[] }) => {
        const a = (opts?.argv ?? []).join(" ");
        if (a.includes("rev-parse HEAD")) return { stdout: `${t.roundTip}\n` };
        if (a.includes("rev-list")) return { stdout: "0\n" };
        return { stdout: "" };
      },
      dispatchFn: async (_h: unknown, spec: { role: string; prompt: string }) => {
        prompts.push(spec.prompt);
        return {
          role: "developer",
          ok: true,
          text: "nothing-to-fix: already resolved",
          toolUses: [],
          ms: 5,
          exitCode: 0,
          transcriptPath: "/tmp/stub.json",
        } as DispatchResult;
      },
    } as unknown as DriverContext;
    await runLensFix(
      ctx,
      {
        ...st,
        pipelineState: { ...st.pipelineState, branchName: "" },
        eventLog: [
          {
            kind: "lens-issues-found",
            at: 1_100_000,
            jobId: "j-1",
            round: 1,
            findings: FINDINGS,
            verdict: "ISSUES_FOUND",
          },
          {
            kind: "lens-fix-empty-resend",
            at: 1_150_000,
            jobId: "j-2",
            round: 1,
            worktree: t.worktree,
            evidence: "no committed fix",
          },
        ],
      },
      1_200_000,
    );
    const resend = prompts.find((p) => p.includes("RE-DISPATCH")) ?? "";
    assert(resend.includes("RE-DISPATCH"), "the fixture really drove the resend branch");
    assert(
      resend.includes(fence.join("\n")),
      "the RE-DISPATCH prompt contains the same plan-time fence block — the second literal is not left unfenced",
    );
  } finally {
    if (prevResume === undefined) delete process.env.PI_ENSEMBLE_RESUME;
    else process.env.PI_ENSEMBLE_RESUME = prevResume;
    rmSync(t.repoRoot, { recursive: true, force: true });
  }
}

console.log("# a fence that cannot be built is not silently absent");
{
  // No recorded worktree for the lens tree => no workstream id => no fence, and
  // the step still dispatches (the gate, not the prompt, is what refuses).
  const t = lensFixture("1852-noid");
  const s = lensRound(initialState(1852, 1_000_000));
  const prompt = inlineLensFixPrompt(FINDINGS, "/tmp/scratch");
  assert(
    !prompt.includes("## The fence"),
    "a prompt built without a fence carries no fence block (it does not fabricate one)",
  );
  assert(
    s.pipelineState.reviewRound === 1 && prompt.includes(FINDINGS),
    "non-vacuity: the fixture state is a lens round and the prompt is the real one",
  );
  rmSync(t.repoRoot, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);

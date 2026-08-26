#!/usr/bin/env bun
/**
 * #543 F5 (M4/M7) — the cap-hit checkpoint block (capedPartialState)
 * reaches BOTH handoff renderers. Split from test-handoff-rendering.ts
 * (AGENTS.md §12 file-size limit).
 *
 * The driver stages+commits the worktree after a loop/token-budget cap
 * kill and records the result on pipelineState.capedPartialState; the
 * renderers must surface it — the operator's "what was saved" is the
 * driver's composed state, never the killed child's final text.
 */

import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO = "/Users/x/repo";

function capedState(
  cap: string,
  role: string,
  over: Partial<WorkState["pipelineState"]["capedPartialState"]> = {},
): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 543,
    createdAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "develop",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: "feature/issue-543-caps",
      capedPartialState: {
        cap,
        role: role as WorkState["pipelineState"]["capedPartialState"]["role"],
        tree: "committed",
        at: Date.now(),
        ...over,
      },
    },
    eventLog: [{ kind: "cap-hit", at: 3, cap, reviewRound: 0, nextStep: "handoff" }],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; renderers read a subset
  } as any;
}

const capRenderers = [
  ["chat", (s: WorkState) => renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-543`)],
  ["markdown", (s: WorkState) => renderHandoffMarkdown(s, REPO)],
] as const;

// (a) develop caped, committed + remaining named.
{
  const s = capedState("loop-detected", "developer", {
    tree: "committed",
    commitSha: "abc1234",
    statusFile: `${REPO}/tmp/issue-543/status-developer.md`,
    remainingFiles: ["extension/src/foo.ts", "extension/src/bar.ts"],
  });
  for (const [name, out] of capRenderers.map(([n, f]) => [n, f(s)] as const)) {
    assert(out.includes("Cap-hit checkpoint"), `${name} (a): renders the checkpoint block`);
    assert(out.includes("abc1234"), `${name} (a): names the checkpoint commit sha`);
    assert(
      out.includes("extension/src/foo.ts") && out.includes("extension/src/bar.ts"),
      `${name} (a): names the remaining uncommitted paths`,
    );
    assert(/status-developer\.md/.test(out), `${name} (a): points at the driver status file`);
  }
}

// (b) dirty tree, nothing committed → the UNVERIFIED PARTIAL STATE tag.
{
  const s = capedState("token-budget", "developer", {
    tree: "dirty-uncommitted",
    remainingFiles: ["extension/src/foo.ts"],
  });
  for (const [name, out] of capRenderers.map(([n, f]) => [n, f(s)] as const)) {
    assert(
      /UNVERIFIED PARTIAL STATE/.test(out),
      `${name} (b): dirty+uncommitted → the unverified-partial-state tag`,
    );
  }
}

// (c) lens loop-killed → the cap hit carries the cap string, the surviving
// lenses' verdicts render from lensReviewSummary (M7), and the write-gated
// role is report-only (M5).
{
  const s = capedState("loop-detected", "code-review-specialist", {
    tree: "clean",
    reportOnly: true,
  });
  s.pipelineState.lensReviewSummary = {
    round: 1,
    verdict: "REVIEW_INCOMPLETE",
    lenses: [
      { lens: "correctness", ok: true, blocked: false, findings: 0 },
      { lens: "security", ok: false, blocked: false, findings: 2 },
      { lens: "looping-lens", ok: false, blocked: true, findings: 0 },
    ],
  };
  s.pipelineState.lastCompletedStep = "lens-review";
  for (const [name, out] of capRenderers.map(([n, f]) => [n, f(s)] as const)) {
    assert(
      out.includes("REVIEW_INCOMPLETE"),
      `${name} (c): surfaces the REVIEW_INCOMPLETE verdict`,
    );
    assert(
      out.includes("### Completed lenses"),
      `${name} (c): renders the completed-lenses section (M7)`,
    );
    assert(
      out.includes("security: issues (2 finding(s))"),
      `${name} (c): names a sibling lens's verdict + finding count`,
    );
    assert(
      /report-only/.test(out),
      `${name} (c): states the role is structurally write-gated (report-only)`,
    );
  }
}

// (d) explore caped → report-only (no commit was ever expected).
{
  const base = capedState("token-budget", "explore", { tree: "clean", reportOnly: true });
  const s: WorkState = {
    ...base,
    pipelineState: { ...base.pipelineState, branchName: undefined, lastCompletedStep: "explore" },
  };
  for (const [name, out] of capRenderers.map(([n, f]) => [n, f(s)] as const)) {
    assert(/report-only/.test(out), `${name} (d): explore cap kill renders the report-only line`);
    assert(
      !out.includes("committed work"),
      `${name} (d): does not claim committed work for a write-gated role`,
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);

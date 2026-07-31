#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: sections 39-42: PR10 driver-level multi-issue bundled API (happy/mixed/all-dropped) + per-issue handoff verdicts.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DriverContext, nextStep } from "../src/work-driver-context.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { appendEvent, initialState, readState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Minimal ExtensionAPI stub — only the methods runWorkDriver actually calls.
function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

// PR11 — default issue-body fetcher for tests. runExplore's empty-body
// halt guard (PR11 §C) would otherwise fire when execp("gh issue view N")
// rejects or returns empty stdout — true for almost every test (the test
// repos don't have GitHub remotes). Tests that deliberately exercise
// the empty-body path pass their own injection; everything else gets
// this stub so the cycle proceeds to plan/branch/develop normally.
const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue} — non-empty placeholder so PR11's empty-body guard doesn't fire`,
});

// Fake DispatchResult builder.
function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub explore output",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

// #297 — transient retries are exercised by dedicated tests below; zero the
// inter-attempt backoff so persistent-failure tests don't sleep 5-10s per
// retry.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

// Offline-suite safety net: a few flow tests deliberately reach the
// adversarial / lens steps without injecting a loopFn. Cap any such
// accidental live spawn at 2s so the suite stays deterministic and fast.
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

// PR17 — the outcome-verification gate is disabled globally here; dedicated
// gate tests re-enable it with an injected verifyExecFn.
process.env.PI_ENSEMBLE_VERIFY = "0";

// Tests 39-41 exercise the driver-level PR10 multi-issue bundled API
// (ctx.issues = [N, M, P]). PR15+ the /work entry point (commands.ts)
// no longer produces this shape — it fires per-issue sequential cycles
// instead, one PR per issue. These tests remain as back-compat contract
// tests for the driver-level API: programmatic callers or a future
// re-enablement path can still invoke the bundled shape. Retiring the
// bundled prompts/logic is deferred to a cleanup PR once we're sure the
// sequential shape is durable in the field.

// 39. PR10 — multi-issue happy path (driver-level API): explore returns
// per-issue NEEDS_WORK for all 3, activeIssues = [all 3], droppedIssues
// empty, plan + commit-pr see the full list.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-multi-ok-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const seenLabels: string[] = [];
    let planPrompt = "";
    let commitPrPrompt = "";
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 961,
      issues: [961, 962, 963],
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        if (opts?.label === "explore") {
          return mkResult({
            role: "explore",
            text: `## Verdict
- #961: NEEDS_WORK
- #962: NEEDS_WORK
- #963: NEEDS_WORK

## Workstreams

### default — fix the bugs
- paths: src/foo.ts
- out-of-scope: docs
`,
          });
        }
        if (opts?.label === "plan") {
          planPrompt = spec.prompt;
          throw new Error("halt at plan: captured prompt for assertion");
        }
        if (opts?.label === "ops:commit-pr") {
          commitPrPrompt = spec.prompt;
          throw new Error("halt at commit-pr: captured prompt for assertion");
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(dir, 961);
    assert(
      after?.pipelineState.activeIssues?.length === 3,
      "multi-issue happy: activeIssues includes all 3 NEEDS_WORK issues",
    );
    assert(
      (after?.pipelineState.droppedIssues ?? []).length === 0,
      "multi-issue happy: droppedIssues empty",
    );
    assert(
      planPrompt.includes("#961, #962, #963"),
      "multi-issue happy: plan prompt threads all 3 issue numbers in the headline",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 40. PR10 — multi-issue mixed verdict: NEEDS_WORK + ALREADY_COMPLETE +
// NEEDS_CLARIFICATION → activeIssues = [needs-work only], droppedIssues
// populated, commit-pr Fixes lines for active issues only.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-multi-mixed-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let commitPrPrompt = "";
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 970,
      issues: [970, 971, 972],
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "explore") {
          return mkResult({
            role: "explore",
            text: `## Verdict
- #970: NEEDS_WORK
- #971: ALREADY_COMPLETE — satisfied by PR #534
- #972: NEEDS_CLARIFICATION — acceptance criteria missing

## Workstreams

### default — fix it
- paths: src/foo.ts
- out-of-scope: docs
`,
          });
        }
        if (opts?.label === "ops:commit-pr") {
          commitPrPrompt = spec.prompt;
          throw new Error("halt at commit-pr: captured prompt for assertion");
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        // Stub everything else; we only care about explore + commit-pr.
        return mkResult({ role: spec.role, text: "stub" });
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(dir, 970);
    assert(
      JSON.stringify(after?.pipelineState.activeIssues) === JSON.stringify([970]),
      `multi-issue mixed: activeIssues = [970] (got ${JSON.stringify(after?.pipelineState.activeIssues)})`,
    );
    const dropped = after?.pipelineState.droppedIssues ?? [];
    assert(dropped.length === 2, "multi-issue mixed: droppedIssues contains 2 entries (971 + 972)");
    assert(
      dropped.find((d) => d.issue === 971)?.verdict === "ALREADY_COMPLETE",
      "multi-issue mixed: #971 dropped as ALREADY_COMPLETE",
    );
    assert(
      dropped.find((d) => d.issue === 972)?.verdict === "NEEDS_CLARIFICATION",
      "multi-issue mixed: #972 dropped as NEEDS_CLARIFICATION",
    );
    if (commitPrPrompt) {
      assert(
        commitPrPrompt.includes("Fixes #970") && !commitPrPrompt.includes("Fixes #971"),
        "multi-issue mixed: commit-pr prompt has Fixes for active only (not for dropped 971)",
      );
      assert(
        commitPrPrompt.includes("Companion to #971"),
        "multi-issue mixed: commit-pr prompt mentions dropped #971 as Companion-to (PR body context)",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 41. PR10 — multi-issue all-dropped: every issue ALREADY_COMPLETE →
// activeIssues = [], aggregate cap-hit 'explore-already-complete' →
// handoff (existing PR6 routing). Empirical /work 533 path generalised.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-multi-all-done-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 980,
      issues: [980, 981],
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        if (opts?.label === "explore") {
          return mkResult({
            role: "explore",
            text: `## Verdict
- #980: ALREADY_COMPLETE — merged via PR #100
- #981: ALREADY_COMPLETE — merged via PR #101
`,
          });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);
    const after = await readState(dir, 980);
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "explore-already-complete",
      "multi-issue all-dropped: cap='explore-already-complete' (aggregate)",
    );
    assert(
      after?.pipelineState.activeIssues?.length === 0,
      "multi-issue all-dropped: activeIssues = [] (all filtered)",
    );
    // No plan / branch / develop dispatches when all issues dropped.
    const cascadeLabels = seenLabels.filter(
      (l) => l === "plan" || l === "developer" || l.startsWith("developer["),
    );
    assert(
      cascadeLabels.length === 0,
      `multi-issue all-dropped: NO plan/develop dispatch (got: ${cascadeLabels.join(",") || "none"})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 42. PR10 — renderHandoffUserMessage surfaces per-issue verdicts for
// multi-issue cycles.
{
  let s = initialState(970, 1_000_000);
  s = {
    ...s,
    issues: [970, 971, 972],
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      status: "handoff",
      branchName: "feature/issues-970-971-972",
      activeIssues: [970],
      droppedIssues: [
        { issue: 971, verdict: "ALREADY_COMPLETE", reason: "satisfied by PR #534" },
        { issue: 972, verdict: "NEEDS_CLARIFICATION", reason: "acceptance criteria missing" },
      ],
    },
  };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_400,
    cap: "explore-already-complete",
    reviewRound: 0,
    nextStep: "handoff",
  });
  s = appendEvent(s, {
    kind: "handoff-emitted",
    at: 1_000_500,
    commentUrl: "https://github.com/x/y/issues/970#c1",
    labelApplied: true,
    handoffBodyPath: "/tmp/issue-970/handoff-comment.md",
  });
  const msg = renderHandoffUserMessage(s, "/repo/proj", "/repo/proj/tmp/issue-970");
  assert(
    msg.includes("issues #970, #971, #972"),
    "renderHandoffUserMessage multi-issue: header lists all 3 issues",
  );
  assert(
    msg.includes("#970: NEEDS_WORK (active in this PR)"),
    "renderHandoffUserMessage multi-issue: #970 listed as active",
  );
  assert(
    msg.includes("#971: ALREADY_COMPLETE — satisfied by PR #534"),
    "renderHandoffUserMessage multi-issue: #971 with verdict + reason surfaced",
  );
  assert(
    msg.includes("#972: NEEDS_CLARIFICATION"),
    "renderHandoffUserMessage multi-issue: #972 NEEDS_CLARIFICATION surfaced",
  );

  const md = renderHandoffMarkdown(s);
  assert(
    md.includes("`#970`, `#971`, `#972`"),
    "renderHandoffMarkdown multi-issue: header lists all 3 issues in code spans",
  );
  assert(
    md.includes("### Issues in this cycle"),
    "renderHandoffMarkdown multi-issue: 'Issues in this cycle' section emitted",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

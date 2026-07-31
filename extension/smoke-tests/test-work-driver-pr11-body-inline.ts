#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: sections 45-48: PR11 develop prompt activeIssues threading, empty issue body halts, explainCap for empty-body cap.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DriverContext, nextStep } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { appendEvent, initialState, readState, writeState } from "../src/workflow-state.ts";

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

// 45. PR11 §B — develop prompt threads activeIssues, not ctx.issue.
// Empirical v10r incident: pre-PR11 the developer prompt hardcoded
// ctx.issue (= primary = first token) even when activeIssues = [different
// issue from explore]. Result: PR #483 implemented #479's --config work
// while branded fix(#476).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-dev-active-issue-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    // Pre-seed at develop with primary issue=479 but activeIssues=[476]
    // (the v10r-incident shape). The developer prompt must reference #476.
    let s = initialState(479, 1_000_000);
    s = {
      ...s,
      issues: [479, 480, 481, 482, 476],
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { default: dir },
        workstreams: {
          default: {
            id: "default",
            scope: "fix the HNSW listener crash",
            paths: [],
            outOfScope: [],
          },
        },
        branchName: "feature/issue-476-heal-invalid-hnsw-index",
        activeIssues: [476],
        droppedIssues: [
          { issue: 479, verdict: "NEEDS_CLARIFICATION", reason: "No issue body available" },
          { issue: 480, verdict: "NEEDS_CLARIFICATION", reason: "No issue body available" },
          { issue: 481, verdict: "NEEDS_CLARIFICATION", reason: "No issue body available" },
          { issue: 482, verdict: "NEEDS_CLARIFICATION", reason: "No issue body available" },
        ],
      },
    };
    await writeState(dir, s);

    let developerPrompt = "";
    let speculativePrompt = "";
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 479,
      issues: [479, 480, 481, 482, 476],
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "developer") developerPrompt = spec.prompt;
        if (opts?.label === "explore:speculative") speculativePrompt = spec.prompt;
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        // Throw on any non-developer/non-speculative dispatch to halt the cycle.
        if (spec.role === "developer") {
          return mkResult({ role: "developer", text: "stub" });
        }
        if (spec.role === "explore" && opts?.label?.startsWith("explore:speculative")) {
          return mkResult({ role: "explore", text: "stub" });
        }
        throw new Error(`halt: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    // Developer prompt must reference #476 (the active issue), NOT #479
    // (the primary). The pre-PR11 bug would have the prompt say `#479`.
    assert(
      developerPrompt.includes("issue #476") && !developerPrompt.includes("issue #479"),
      `PR11 §B: developer prompt references active issue #476, NOT primary #479 (got headline: "${developerPrompt.split("\n")[0]}")`,
    );
    assert(
      developerPrompt.includes("gh issue view 476") &&
        !developerPrompt.includes("gh issue view 479"),
      "PR11 §B: developer prompt's re-fetch instruction targets active issue #476",
    );
    if (speculativePrompt) {
      assert(
        speculativePrompt.includes("#476") && !speculativePrompt.includes("#479"),
        "PR11 §B: speculative explore prompt also references active issue #476",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 46. PR11 §C — runExplore halts on empty issue body (test-only injection).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-explore-empty-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 850,
      // Simulate the v10r incident: gh issue view returns empty stdout
      // (projectCards GraphQL deprecation / gh extension hijack /
      // auth lapse). All bodies empty → halt.
      issueBodyFetcherFn: async (_n, _cwd) => ({ stdout: "" }),
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        return mkResult({ role: spec.role, text: "stub" });
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 850);
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "explore-bodies-empty",
      "PR11 §C: empty body → cap='explore-bodies-empty'",
    );
    assert(
      (after?.pipelineState.emptyBodyIssues ?? []).length === 1,
      "PR11 §C: emptyBodyIssues populated with the failed fetch",
    );
    assert(
      after?.pipelineState.emptyBodyIssues?.[0]?.issue === 850,
      "PR11 §C: emptyBodyIssues entry names the failing issue",
    );
    const cascadeLabels = seenLabels.filter(
      (l) => l === "plan" || l === "branch" || l === "developer" || l.startsWith("developer["),
    );
    assert(
      cascadeLabels.length === 0,
      `PR11 §C: NO plan/branch/develop dispatch (the v10r cascade prevented; got: ${cascadeLabels.join(",") || "none"})`,
    );
    assert(
      seenLabels.includes("ops:handoff"),
      "PR11 §C: handoff DID run (operator gets the explanation + recovery commands)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 47. PR11 §C — partial-empty (some bodies present, some empty) STILL
// halts. Strict rule per design — partial-data flow-through is what
// caused the v10r incident.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-explore-partial-empty-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let fetchCount = 0;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 860,
      issues: [860, 861, 862],
      issueBodyFetcherFn: async (n, _cwd) => {
        fetchCount++;
        // #860 succeeds; #861 + #862 return empty (v10r-shape).
        if (n === 860) return { stdout: `title:\tok\n\nreal body for #${n}` };
        return { stdout: "" };
      },
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        return mkResult({ role: spec.role, text: "stub" });
      },
    };
    await runWorkDriver(ctx);
    const after = await readState(dir, 860);
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "explore-bodies-empty",
      "PR11 §C: ANY empty body halts (strict rule, not majority)",
    );
    const empty = after?.pipelineState.emptyBodyIssues ?? [];
    assert(
      empty.length === 2 &&
        empty.some((e) => e.issue === 861) &&
        empty.some((e) => e.issue === 862),
      "PR11 §C: emptyBodyIssues lists exactly the failed fetches (#861, #862)",
    );
    assert(fetchCount === 3, "PR11 §C: fetcher called once per requested issue");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 48. PR11 §E — explainCap covers the new cap shape + renderHandoffUserMessage
// surfaces empty-body details with diagnostic recovery commands.
{
  let s = initialState(479, 1_000_000);
  s = {
    ...s,
    issues: [479, 480, 481, 482, 476],
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      status: "handoff",
      emptyBodyIssues: [
        {
          issue: 479,
          reason:
            "gh issue view returned empty stdout (possible projectCards GraphQL deprecation, gh extension hijack, or auth lapse)",
        },
        { issue: 480, reason: "gh issue view returned empty stdout" },
        { issue: 481, reason: "gh issue view returned empty stdout" },
        { issue: 482, reason: "gh issue view returned empty stdout" },
      ],
    },
  };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_400,
    cap: "explore-bodies-empty",
    reviewRound: 0,
    nextStep: "handoff",
  });
  s = appendEvent(s, {
    kind: "handoff-emitted",
    at: 1_000_500,
    commentUrl: "https://github.com/x/y/issues/479#c1",
    labelApplied: true,
    handoffBodyPath: "/tmp/issue-479/handoff-comment.md",
  });

  // explainCap covers the new shape and names the failing issues.
  const explanation = explainCap("explore-bodies-empty", s);
  assert(
    explanation.includes("#479") && explanation.includes("#480"),
    "PR11 §E: explainCap explore-bodies-empty names the failing issues",
  );
  assert(
    /gh auth status/i.test(explanation),
    "PR11 §E: explainCap suggests gh auth status as part of the diagnostic",
  );

  // renderHandoffUserMessage surfaces the diagnostic recovery commands.
  const msg = renderHandoffUserMessage(s, "/repo/v10r", "/repo/v10r/tmp/issue-479");
  assert(
    msg.includes("Empty/error body fetches:"),
    "PR11 §E: renderHandoffUserMessage lists failed body fetches",
  );
  assert(
    msg.includes("gh auth status") && msg.includes("gh --version"),
    "PR11 §E: recovery commands include gh auth status + gh --version",
  );
  assert(
    msg.includes("gh api repos/") && msg.includes("--jq .body"),
    "PR11 §E: recovery commands include REST-fallback probe",
  );

  // renderHandoffMarkdown emits the empty-body section above recovery.
  const md = renderHandoffMarkdown(s);
  assert(
    md.includes("### Empty / failed issue-body fetches"),
    "PR11 §E: renderHandoffMarkdown emits 'Empty / failed issue-body fetches' section",
  );
  assert(
    md.includes("#479") && md.includes("#480"),
    "PR11 §E: renderHandoffMarkdown lists each failed issue under the section",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

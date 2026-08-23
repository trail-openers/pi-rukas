#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: sections 11-16: PR4 parsePrNumber, parseHandoffCommentUrl, renderHandoffMarkdown, speculative explore, lifecycle round suffix.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DriverContext, nextStep } from "../src/work-driver-context.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { parseHandoffCommentUrl } from "../src/work-driver-handoff.ts";
import { parsePrNumber } from "../src/work-driver-lens.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { appendEvent, initialState, writeState } from "../src/workflow-state.ts";

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

// 11. PR4 — parsePrNumber lenient variants.
{
  assert(parsePrNumber("pr: 556") === 556, "parsePrNumber: plain `pr: 556`");
  assert(parsePrNumber("pr: #556") === 556, "parsePrNumber: hash-prefixed");
  assert(parsePrNumber("**pr**: `#556`") === 556, "parsePrNumber: markdown bold + backticks");
  assert(parsePrNumber("PR: 42") === 42, "parsePrNumber: case-insensitive");
  // End-of-reply marker line — the realistic shape from ops commit-pr.
  const realistic = [
    "Branch pushed and PR opened.",
    "",
    "Title: feat(#42): fix the thing",
    "URL: https://github.com/foo/bar/pull/42",
    "",
    "pr: 42",
  ].join("\n");
  assert(parsePrNumber(realistic) === 42, "parsePrNumber: end-of-reply marker line");
  assert(parsePrNumber(undefined) === undefined, "parsePrNumber: undefined input");
  assert(
    parsePrNumber("Some prose with PR mentioned but no marker") === undefined,
    "parsePrNumber: no marker line",
  );
  assert(parsePrNumber("pr: not-a-number") === undefined, "parsePrNumber: non-numeric rejected");
}

// 12. PR4 — parseHandoffCommentUrl finds the gh-printed URL.
{
  // gh prints the comment URL after `gh pr comment` / `gh issue comment` succeeds.
  const okReply = [
    "Posted comment.",
    "https://github.com/org/repo/pull/553#issuecomment-2547382109",
    "",
    "Applied label needs-human-attention.",
  ].join("\n");
  assert(
    parseHandoffCommentUrl(okReply) ===
      "https://github.com/org/repo/pull/553#issuecomment-2547382109",
    "parseHandoffCommentUrl: finds PR comment URL",
  );
  const issueReply = "https://github.com/org/repo/issues/600#issuecomment-99 posted.";
  assert(
    parseHandoffCommentUrl(issueReply) === "https://github.com/org/repo/issues/600#issuecomment-99",
    "parseHandoffCommentUrl: finds issue comment URL",
  );
  assert(
    parseHandoffCommentUrl(undefined) === undefined,
    "parseHandoffCommentUrl: undefined input",
  );
  assert(
    parseHandoffCommentUrl("ops failed: gh auth missing") === undefined,
    "parseHandoffCommentUrl: no URL → undefined",
  );
}

// 13. PR4 — renderHandoffMarkdown shape against a synthetic state.
{
  let s = initialState(553, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      branchName: "feature/issue-553-fix",
      reviewRound: 3,
      prNumber: 556,
    },
  };
  s = appendEvent(
    s,
    {
      kind: "dispatch-completed",
      step: "explore",
      role: "explore",
      jobId: "j1",
      label: "explore",
      ok: true,
      ms: 28000,
      at: 1_001_000,
      transcriptPath: "/tmp/foo/explore.json",
    },
    {
      kind: "dispatch-completed",
      step: "develop",
      role: "developer",
      jobId: "j2",
      label: "developer",
      ok: true,
      ms: 240000,
      at: 1_240_000,
      transcriptPath: "/tmp/foo/developer.json",
    },
    {
      kind: "lens-issues-found",
      at: 1_900_000,
      jobId: "j3",
      round: 3,
      findings: "[]",
      verdict: "ISSUES_FOUND",
    },
    { kind: "cap-hit", at: 1_900_000, cap: "round-cap", reviewRound: 3, nextStep: "handoff" },
  );
  const md = renderHandoffMarkdown(s);
  assert(md.includes("Cap hit"), "renderHandoffMarkdown: includes Cap hit banner");
  assert(md.includes("round-cap"), "renderHandoffMarkdown: names the cap that fired");
  assert(md.includes("feature/issue-553-fix"), "renderHandoffMarkdown: surfaces branch name");
  assert(md.includes(".pi/work-state/553.json"), "renderHandoffMarkdown: points at state file");
  assert(md.includes("What was attempted"), "renderHandoffMarkdown: includes step-duration block");
  assert(md.includes("28.0s · explore"), "renderHandoffMarkdown: includes per-step durations");
  // The heading changed when the handoff started printing the findings
  // themselves rather than a pointer to the state file. This fixture stores
  // `findings: "[]"`, so it exercises the empty branch: a round that reported
  // issues but recorded nothing readable must still say so, because silence
  // here reads as "the review found nothing".
  assert(
    md.includes("Review findings") && md.includes("none recorded"),
    "renderHandoffMarkdown: an issues-found round with an empty findings blob says so explicitly",
  );
  assert(md.includes("Transcripts"), "renderHandoffMarkdown: lists transcripts when present");
  assert(md.includes("/tmp/foo/explore.json"), "renderHandoffMarkdown: transcript paths verbatim");
}

// 14. Speculative explore is OFF by default — develop dispatches ONE child.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-spec-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(700, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { default: dir },
        workstreams: {
          default: {
            id: "default",
            scope: "single-task scope",
            paths: ["src/foo.ts"],
            outOfScope: [],
          },
        },
        branchName: "feature/issue-700",
      },
    };
    await writeState(dir, s);

    const seenLabels: string[] = [];
    let developerPrompt = "";
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 700,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        if (opts?.label === "developer" || opts?.label?.startsWith("developer[")) {
          developerPrompt = spec.prompt;
        }
        // Halt on the step after develop: with the explore opted out, develop
        // makes exactly ONE dispatch, so a second label means develop is done.
        if (seenLabels.length >= 2) {
          throw new Error("smoke: halting after develop step");
        }
        return mkResult({ role: spec.role, text: `mock ${spec.role} output` });
      },
    };
    await runWorkDriver(ctx);

    // The developer measurably never read the scratch file the explore wrote
    // (ENOENT on every access, across a full day of live cycles), so the
    // default is one child per workstream and the prompt promises nothing.
    assert(seenLabels.includes("developer"), "default: developer dispatched");
    assert(
      !seenLabels.includes("explore:speculative"),
      "canary: speculative explore NOT dispatched by default — it is opt-in",
    );
    assert(
      !developerPrompt.includes("speculative-"),
      "canary: default developer prompt names no speculative scratch path — nothing writes one",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 15. Speculative explore CAN be turned on via env opt-in.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-no-spec-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(701, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { default: dir },
        workstreams: {
          default: {
            id: "default",
            scope: "single-task scope",
            paths: ["src/foo.ts"],
            outOfScope: [],
          },
        },
      },
    };
    await writeState(dir, s);

    const prev = process.env.PI_ENSEMBLE_SPECULATIVE_EXPLORE;
    process.env.PI_ENSEMBLE_SPECULATIVE_EXPLORE = "1";
    try {
      const seenLabels: string[] = [];
      let developerPrompt = "";
      const ctx: DriverContext = {
        pi: makeFakePi().pi,
        repoRoot: dir,
        issue: 701,
        dispatchFn: async (_pi, spec, opts) => {
          seenLabels.push(opts?.label ?? spec.role);
          if (opts?.label === "developer" || opts?.label?.startsWith("developer[")) {
            developerPrompt = spec.prompt;
          }
          // Two concurrent dispatches in develop when the explore is on.
          if (seenLabels.length >= 3) {
            throw new Error("smoke: halting after develop step's Promise.allSettled");
          }
          return mkResult({ role: spec.role, text: `mock ${spec.role} output` });
        },
      };
      await runWorkDriver(ctx);
      assert(seenLabels.includes("developer"), "opt-in: developer dispatched");
      assert(
        seenLabels.includes("explore:speculative"),
        "opt-in: speculative explore dispatched under PI_ENSEMBLE_SPECULATIVE_EXPLORE=1",
      );
      assert(
        developerPrompt.includes("speculative-default.md"),
        "opt-in: developer prompt names the speculative scratch path the explore writes",
      );
    } finally {
      if (prev === undefined) delete process.env.PI_ENSEMBLE_SPECULATIVE_EXPLORE;
      else process.env.PI_ENSEMBLE_SPECULATIVE_EXPLORE = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 16. PR4 — round suffix only renders for round > 1 in lifecycle formatLine.
{
  const lc = await import("../src/lifecycle-events.ts");
  // Round 1 (or undefined) → no suffix.
  const round1 = lc.formatLine({
    kind: "step-started",
    jobId: "adversarial",
    label: "adversarial",
    role: "adversarial",
    stepNumber: 5,
    stepTotal: 9,
    round: 1,
  });
  assert(!round1.includes("(round"), "round=1 produces no `(round N)` suffix (first entry)");
  // Round 2+ shows suffix.
  const round2 = lc.formatLine({
    kind: "step-started",
    jobId: "adversarial",
    label: "adversarial",
    role: "adversarial",
    stepNumber: 5,
    stepTotal: 9,
    round: 2,
  });
  assert(round2.includes("(round 2)"), "round=2 shows `(round 2)` suffix");
  // Same for step-completed.
  const completed3 = lc.formatLine({
    kind: "step-completed",
    jobId: "lens-review",
    label: "lens-review",
    role: "lens-review",
    stepNumber: 7,
    stepTotal: 9,
    elapsedMs: 30000,
    round: 3,
  });
  assert(completed3.includes("(round 3)"), "step-completed: round=3 suffix shown");
}

console.log(`\nexit ${exit}`);
process.exit(exit);

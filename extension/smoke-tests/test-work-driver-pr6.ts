#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: sections 23-28: PR6 parseExploreVerdict + ALREADY_COMPLETE/NEEDS_CLARIFICATION/NEEDS_WORK routing + lens empty-diff guard + handoff recovery commands.
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
import { parseExploreVerdict } from "../src/work-driver-plan.ts";
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

// 23. PR6 — parseExploreVerdict pure helper.
{
  assert(
    parseExploreVerdict("VERDICT: ALREADY_COMPLETE") === "ALREADY_COMPLETE",
    "parseExploreVerdict: plain ALREADY_COMPLETE",
  );
  assert(
    parseExploreVerdict("**VERDICT:** NEEDS_WORK") === "NEEDS_WORK",
    "parseExploreVerdict: bold-wrapped NEEDS_WORK",
  );
  assert(
    parseExploreVerdict("verdict: needs_clarification") === "NEEDS_CLARIFICATION",
    "parseExploreVerdict: case-insensitive, lower-snake input",
  );
  assert(
    parseExploreVerdict("## Verdict\n\nVERDICT: ALREADY_COMPLETE\n\n## Touchpoints") ===
      "ALREADY_COMPLETE",
    "parseExploreVerdict: embedded under heading, first match wins",
  );
  assert(
    parseExploreVerdict("no verdict here") === null,
    "parseExploreVerdict: missing verdict → null",
  );
  assert(
    parseExploreVerdict("VERDICT: NEVER_VALID") === null,
    "parseExploreVerdict: unknown verdict → null (not coerced)",
  );
  assert(parseExploreVerdict("") === null, "parseExploreVerdict: empty string → null");
}

// 24. PR6 — runWorkDriver halts cleanly on VERDICT: ALREADY_COMPLETE.
// Empirical #533: explore correctly identified ALREADY_COMPLETED but
// driver ran every step to lens-fix before user intervention. After
// PR6, the verdict routes to handoff with no plan/branch/develop.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-already-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      host: makeFakePi().pi,
      repoRoot: dir,
      issue: 533,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        if (spec.role === "explore" && opts?.label === "explore") {
          return mkResult({
            role: "explore",
            text: "## Verdict\n\nVERDICT: ALREADY_COMPLETE\n\nIssue closed via PR #534 5 days ago.",
          });
        }
        if (opts?.label === "ops:handoff") {
          return mkResult({ role: "ops", text: "Posted." });
        }
        throw new Error(
          `unexpected dispatch in already-complete smoke: ${spec.role} / ${opts?.label}`,
        );
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 533);
    assert(
      after?.pipelineState.exploreVerdict === "ALREADY_COMPLETE",
      "ALREADY_COMPLETE: exploreVerdict persisted on pipelineState",
    );
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "explore-already-complete",
      "ALREADY_COMPLETE: synthesises cap='explore-already-complete'",
    );
    // The cascade the empirical #533 ran: must NOT have seen plan/branch/develop.
    const cascadeLabels = seenLabels.filter(
      (l) =>
        l === "plan" ||
        l === "branch" ||
        l === "developer" ||
        l.startsWith("adversarial") ||
        l === "commit-pr" ||
        l.startsWith("lens-review"),
    );
    assert(
      cascadeLabels.length === 0,
      `ALREADY_COMPLETE: NO plan/branch/develop/adversarial dispatch (got: ${cascadeLabels.join(",") || "none"})`,
    );
    assert(
      seenLabels.includes("ops:handoff"),
      "ALREADY_COMPLETE: handoff DID run (ops:handoff dispatch fired)",
    );
    assert(
      after?.pipelineState.status === "handoff",
      "ALREADY_COMPLETE: terminal status=handoff (not aborted — nothing broke)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 25. PR6 — VERDICT: NEEDS_CLARIFICATION routes to handoff with distinct cap.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-clarify-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const ctx: DriverContext = {
      host: makeFakePi().pi,
      repoRoot: dir,
      issue: 700,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (spec.role === "explore" && opts?.label === "explore") {
          return mkResult({
            role: "explore",
            text: "VERDICT: NEEDS_CLARIFICATION\n\nAcceptance criteria are missing.",
          });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);
    const after = await readState(dir, 700);
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "explore-needs-clarification",
      "NEEDS_CLARIFICATION: synthesises cap='explore-needs-clarification'",
    );
    assert(
      after?.pipelineState.exploreVerdict === "NEEDS_CLARIFICATION",
      "NEEDS_CLARIFICATION: exploreVerdict persisted",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 26. PR6 — NEEDS_WORK proceeds to plan normally (regression guard for
// happy path). Missing verdict header also falls through unchanged.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-needswork-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let planSeen = false;
    const ctx: DriverContext = {
      host: makeFakePi().pi,
      repoRoot: dir,
      issue: 701,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (spec.role === "explore" && opts?.label === "explore") {
          return mkResult({
            role: "explore",
            text: "VERDICT: NEEDS_WORK\n\n## Workstreams\n\n### default — fix the bug",
          });
        }
        if (opts?.label === "plan") {
          planSeen = true;
          // Halt the loop by throwing — we only care that plan was reached.
          throw new Error("test halt after reaching plan");
        }
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(dir, 701);
    assert(
      after?.pipelineState.exploreVerdict === "NEEDS_WORK",
      "NEEDS_WORK: exploreVerdict persisted even on the proceed path",
    );
    assert(planSeen, "NEEDS_WORK: driver proceeded to plan step (no early halt)");
    // PR5's halt-cascade router synthesises a step-failed:plan cap when we
    // throw inside plan to halt the test — that's correct, separate path.
    // The PR6 guarantee is that NO explore-* cap fired (i.e. the verdict
    // router didn't intercept).
    const exploreCapHits = (after?.eventLog ?? []).filter(
      (e) => e.kind === "cap-hit" && e.cap.startsWith("explore-"),
    );
    assert(
      exploreCapHits.length === 0,
      "NEEDS_WORK: no explore-* cap-hit synthesised (verdict router did not intercept)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 27. PR6 — runLens empty-diff guard skips dispatch + synthesises lens-approved.
// Empirical #533 lens-review found phantom PERFORMANCE issues in unrelated
// files on an empty diff; this guard prevents that path.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-empty-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    // Pre-seed state at lens-review with no worktrees and a clean repoRoot
    // → fetchAllDiffs returns "" and the guard fires.
    let s = initialState(702, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-review",
        lastCompletedStep: "commit-pr",
        worktrees: {},
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-702-test",
        prNumber: 9999,
      },
    };
    await writeState(dir, s);

    // Initialise a git repo at dir so fetchAllDiffs has something to read
    // (it'll return empty since nothing is staged/modified).
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);
    await execp("git init -q", { cwd: dir });
    await execp(
      'git config user.email "t@t" && git config user.name "T" && git commit --allow-empty -q -m init',
      { cwd: dir, shell: "/bin/bash" },
    );
    // #384 — the remote refs must EXIST for this to be the genuine no-work
    // case. Without them the diff read fails with "unknown revision", which
    // pre-#384 returned "" and was indistinguishable from empty — so this
    // test passed by exercising a git FAILURE rather than an empty diff.
    await execp("git update-ref refs/remotes/origin/main HEAD", { cwd: dir });
    await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", { cwd: dir });
    await execp("git update-ref refs/remotes/origin/feature/issue-702-test HEAD", { cwd: dir });

    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      host: makeFakePi().pi,
      repoRoot: dir,
      issue: 702,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        // ci step calls ops to watch CI; stub a quick success so we reach merged.
        if (spec.role === "ops") {
          return mkResult({ role: "ops", text: "CI_STATUS: success" });
        }
        throw new Error(`unexpected dispatch in empty-diff smoke: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 702);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(
      kinds.includes("lens-skipped-empty-diff"),
      "empty-diff: lens-skipped-empty-diff event emitted",
    );
    assert(
      kinds.includes("lens-approved"),
      "empty-diff: synthesised lens-approved event emitted (so nextStep advances)",
    );
    // No lens children dispatched — the role wouldn't be ops or handoff if so.
    const lensReviewLabels = seenLabels.filter(
      (l) => l.startsWith("lens-review") || l.startsWith("code-review-specialist"),
    );
    assert(
      lensReviewLabels.length === 0,
      `empty-diff: NO lens dispatch fired (got: ${lensReviewLabels.join(",") || "none"})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 28. PR6 — renderHandoffUserMessage produces cap-specific recovery commands
// for explore-* caps (different from PR5's spawn-backstop set).
{
  let s = initialState(533, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      status: "handoff",
      exploreVerdict: "ALREADY_COMPLETE",
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
    at: 1_000_600,
    commentUrl: "https://github.com/x/y/issues/533#comment-1",
    labelApplied: true,
    handoffBodyPath: "/tmp/issue-533/handoff-comment.md",
  });
  const msg = renderHandoffUserMessage(s, "/repo/my-app", "/repo/my-app/tmp/issue-533");
  assert(
    msg.includes("explore concluded this issue is already done"),
    "explore-already-complete: explainCap output in body",
  );
  assert(
    msg.includes("gh issue close 533"),
    "explore-already-complete: recovery includes gh issue close",
  );
  assert(
    !msg.includes("Discard the cycle and start over"),
    "explore-already-complete: does NOT include the wrong 'discard and retry' recovery",
  );
  assert(
    !msg.includes("git add -p && git commit"),
    "explore-already-complete: does NOT include the wrong 'git push what's there' recovery",
  );

  const md = renderHandoffMarkdown(s);
  assert(
    md.includes("gh issue close 533"),
    "renderHandoffMarkdown: explore-already-complete recovery includes gh issue close",
  );
  assert(
    !md.includes("Discard the cycle and start over"),
    "renderHandoffMarkdown: explore-already-complete does NOT include the wrong recovery",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: sections 49-53: PR12 terminal-state / --restart handling, parseStepBackReply, runStepBack, step-back cap renderers.
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
import { parseStepBackReply } from "../src/work-driver-stepback-ci.ts";
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

// 49. PR12 — runWorkDriver on terminal state (no --restart) emits a clear
// notify and returns. Pre-PR12 this silently fell through to the end of
// the function with no user-facing message; PM ended up recommending
// /do as a workaround.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-terminal-notify-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    // Pre-seed a terminal state file (status=handoff).
    let s = initialState(900, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "handoff",
        status: "handoff",
        branchName: "feature/issue-900",
      },
    };
    await writeState(dir, s);

    const { pi, sent } = makeFakePi();
    let dispatchCalled = false;
    const ctx: DriverContext = {
      pi,
      repoRoot: dir,
      issue: 900,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, _spec, _opts) => {
        dispatchCalled = true;
        return mkResult({ role: "explore", text: "stub" });
      },
    };
    await runWorkDriver(ctx);
    assert(
      dispatchCalled === false,
      "PR12 §B: runWorkDriver on terminal-handoff state does NOT dispatch anything",
    );
    const notify = sent.join("\n");
    assert(
      /already terminated as handoff/.test(notify),
      "PR12 §B: notify names the terminal status (handoff)",
    );
    assert(/--restart/.test(notify), "PR12 §B: notify points at /work --restart as the recovery");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 50. PR12 — runWorkDriver with ctx.restart=true skips readState; existing
// state is overwritten on first writeState. Asserts that the cycle runs
// from initialState even though a terminal state file exists.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-restart-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    // Pre-seed a terminal state with a fingerprint event so we can detect
    // whether it survived the restart (it should NOT).
    let s = initialState(910, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "handoff",
        status: "handoff",
        branchName: "feature/issue-910-old",
      },
    };
    s = appendEvent(s, {
      kind: "cap-hit",
      at: 1_000_500,
      cap: "adversarial-loop",
      reviewRound: 3,
      nextStep: "handoff",
    });
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 910,
      restart: true,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        // Halt at first dispatch (explore for the fresh cycle) so the
        // test runs fast — we only need to know the cycle didn't early-
        // exit on the prior terminal state.
        throw new Error(`halt-after-restart: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 910);
    assert(
      after?.pipelineState.branchName === undefined,
      "PR12 §A: --restart wipes prior pipelineState.branchName (fresh initialState)",
    );
    // The prior cycle's cap-hit ('adversarial-loop') must be GONE.
    // The post-restart cycle may emit its own cap-hits (e.g., from the
    // dispatch-halt the test fixture triggers); we only assert the
    // pre-seeded one didn't survive.
    const preSeededCapHits = (after?.eventLog ?? []).filter(
      (e) => e.kind === "cap-hit" && e.cap === "adversarial-loop",
    );
    assert(
      preSeededCapHits.length === 0,
      "PR12 §A: --restart wipes prior eventLog (no surviving 'adversarial-loop' cap-hit from previous cycle)",
    );
    assert(
      after?.pipelineState.currentStep !== "handoff" || after?.pipelineState.status === "aborted",
      "PR12 §A: --restart resets currentStep away from terminal handoff (or aborts on dispatch-halt)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 51. PR12 — parseStepBackReply extracts sddElement / diagnosis /
// proposedRevision from the @explore step-back reply. Lenient on
// markdown emphasis + multi-line values.
{
  const reply = `Analysis of the recurring lens findings:

sddElement: Outcomes — acceptance criteria

diagnosis: The issue doesn't specify what "fixed" looks like, so reviewers keep flagging missing tests for edge cases.

proposedRevision: ## Acceptance criteria

- All public functions in src/foo.ts have unit tests
- Edge cases X, Y, Z are covered
- typecheck + lint clean

alternativeApproach: Could also split into two issues — one for the impl, one for the test suite.
`;
  const r = parseStepBackReply(reply);
  assert(
    /Outcomes/.test(r.sddElement),
    `PR12: parseStepBackReply captures sddElement (got "${r.sddElement}")`,
  );
  assert(
    /reviewers keep flagging/.test(r.diagnosis),
    "PR12: parseStepBackReply captures diagnosis",
  );
  assert(
    /Acceptance criteria/.test(r.proposedRevision) && /edge cases/i.test(r.proposedRevision),
    "PR12: parseStepBackReply captures multi-line proposedRevision until the next key",
  );
  // Missing fields → empty strings (graceful degrade). sddElement captures
  // multi-line until the next recognised key or end-of-input (so when
  // ONLY sddElement is present, its capture extends to the end of the
  // reply — that's correct behaviour for graceful parsing, the renderer
  // shows whatever was captured).
  const partial = parseStepBackReply("sddElement: Constraints\n\n(no other fields)");
  assert(
    /Constraints/.test(partial.sddElement) &&
      partial.diagnosis === "" &&
      partial.proposedRevision === "",
    "PR12: parseStepBackReply returns empty strings for absent fields",
  );
}

// 52. PR12 — runStepBack appends step-back-completed AND cap-hit
// (cap='step-back-revise-spec') after the @explore dispatch. The cap-hit
// is the routing signal that lets the handoff renderer branch.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-stepback-cap-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(920, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "step-back",
        lastCompletedStep: "lens-review",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "x", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-920",
      },
    };
    s = appendEvent(s, {
      kind: "lens-issues-found",
      at: 1_000_200,
      jobId: "j1",
      round: 1,
      findings: '[{"lens":"ARCHITECTURE","severity":"HIGH","title":"missing AC"}]',
      verdict: "ISSUES_FOUND",
    });
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 920,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "explore:step-back") {
          return mkResult({
            role: "explore",
            text:
              "sddElement: Outcomes\n" +
              "diagnosis: The acceptance criteria are missing for edge case X.\n" +
              "proposedRevision: Add a 'must handle X' bullet under DoD.\n",
          });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 920);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(kinds.includes("step-back-completed"), "PR12 §C: step-back-completed event emitted");
    const sb = (after?.eventLog ?? []).find((e) => e.kind === "step-back-completed");
    assert(
      sb?.kind === "step-back-completed" && /Outcomes/.test(sb.sddElement),
      "PR12 §C: step-back-completed payload carries parsed sddElement",
    );
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "step-back-revise-spec",
      "PR12 §C: cap-hit synthesised with cap='step-back-revise-spec'",
    );
    assert(
      after?.pipelineState.status === "handoff",
      "PR12 §C: cycle routes to terminal handoff (existing nextStep cap-hit branch)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 53. PR12 — explainCap + handoff renderers surface the step-back
// proposedRevision + the /plan + --restart recovery commands.
{
  let s = initialState(930, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      status: "handoff",
      branchName: "feature/issue-930",
    },
  };
  s = appendEvent(
    s,
    {
      kind: "step-back-completed",
      at: 1_000_300,
      jobId: "j2",
      sddElement: "Outcomes — acceptance criteria",
      diagnosis: "AC are too vague; reviewers keep flagging missing edge-case coverage",
      proposedRevision: "Add explicit AC: all branches in src/foo.ts have unit tests for X, Y, Z.",
    },
    {
      kind: "cap-hit",
      at: 1_000_400,
      cap: "step-back-revise-spec",
      reviewRound: 3,
      nextStep: "handoff",
    },
    {
      kind: "handoff-emitted",
      at: 1_000_500,
      commentUrl: "https://github.com/x/y/issues/930#c1",
      labelApplied: true,
      handoffBodyPath: "/tmp/issue-930/handoff-comment.md",
    },
  );

  const explanation = explainCap("step-back-revise-spec", s);
  assert(
    /spec-level gap/i.test(explanation) && /Outcomes/.test(explanation),
    "PR12 §E: explainCap step-back-revise-spec names the sddElement",
  );
  assert(
    /--restart/.test(explanation),
    "PR12 §E: explainCap mentions /work --restart in recovery hint",
  );

  const msg = renderHandoffUserMessage(s, "/repo/proj", "/repo/proj/tmp/issue-930");
  assert(
    /Step-back analysis/i.test(msg),
    "PR12 §E: renderHandoffUserMessage emits 'Step-back analysis' section",
  );
  assert(
    msg.includes("/plan 930") && msg.includes("/work 930 --restart"),
    "PR12 §E: renderHandoffUserMessage recovery includes /plan + /work --restart",
  );
  assert(
    !msg.includes("git add -p && git commit"),
    "PR12 §E: renderHandoffUserMessage does NOT show the wrong 'git push what's there' generic recovery",
  );

  const md = renderHandoffMarkdown(s);
  assert(
    md.includes("### Step-back analysis"),
    "PR12 §E: renderHandoffMarkdown emits 'Step-back analysis' section",
  );
  assert(
    md.includes("Proposed revision") && md.includes("Add explicit AC"),
    "PR12 §E: renderHandoffMarkdown surfaces the proposedRevision verbatim",
  );
  assert(
    md.includes("/plan 930") && md.includes("/work 930 --restart"),
    "PR12 §E: renderHandoffMarkdown recovery includes /plan + /work --restart",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

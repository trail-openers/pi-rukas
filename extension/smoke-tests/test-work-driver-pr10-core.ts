#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: sections 35-38: PR10 parsePerIssueVerdicts, parseMergeCommit, runMerged happy path + dispatch failure.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DriverContext, STEP_FAILURE_POLICY } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { parseMergeCommit } from "../src/work-driver-merged.ts";
import { parsePerIssueVerdicts } from "../src/work-driver-plan.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { initialState, readState, writeState } from "../src/workflow-state.ts";

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

// 35. PR10 — parsePerIssueVerdicts pure helper.
{
  const text = `## Verdict
- #561: NEEDS_WORK — fresh bug
- #562: ALREADY_COMPLETE — satisfied by PR #534
- #563: NEEDS_CLARIFICATION — acceptance criteria missing
`;
  const result = parsePerIssueVerdicts(text, [561, 562, 563]);
  assert(result.length === 3, "parsePerIssueVerdicts: returns one entry per requested issue");
  assert(
    result[0]?.issue === 561 &&
      result[0]?.verdict === "NEEDS_WORK" &&
      result[0]?.reason === "fresh bug",
    "parsePerIssueVerdicts: #561 NEEDS_WORK + reason captured",
  );
  assert(
    result[1]?.verdict === "ALREADY_COMPLETE" && result[1]?.reason.includes("PR #534"),
    "parsePerIssueVerdicts: #562 ALREADY_COMPLETE + reason captured",
  );
  assert(
    result[2]?.verdict === "NEEDS_CLARIFICATION" &&
      result[2]?.reason.includes("acceptance criteria"),
    "parsePerIssueVerdicts: #563 NEEDS_CLARIFICATION + reason captured",
  );
  // Missing per-issue line falls back to overall verdict.
  const fallback = parsePerIssueVerdicts("VERDICT: NEEDS_WORK\n", [700, 701]);
  assert(
    fallback[0]?.verdict === "NEEDS_WORK" && fallback[1]?.verdict === "NEEDS_WORK",
    "parsePerIssueVerdicts: falls back to overall VERDICT when per-issue absent",
  );
  assert(
    fallback[0]?.verdictSource === "overall",
    "parsePerIssueVerdicts: ...and records that the verdict came from the overall marker, not per-issue",
  );

  // #408 — this assertion is INVERTED from what it said before, deliberately.
  // It used to read "defaults to NEEDS_WORK when nothing parseable (driver
  // proceeds rather than silently drops)", which is the "silence is
  // permission" shape #378 set out to remove: nothing in the reply said to
  // build these issues, and the driver decided to anyway. On the multi-issue
  // path — which #397 made the only multi-issue path — that means building
  // work nobody asked for, off a verdict the driver invented.
  //
  // Dropping to NEEDS_CLARIFICATION is recoverable: the operator is told the
  // verdict could not be read and can re-run. Building the wrong thing is not.
  const defaulted = parsePerIssueVerdicts("no verdicts here at all", [800]);
  assert(
    defaulted[0]?.verdict === "NEEDS_CLARIFICATION",
    "parsePerIssueVerdicts: NOTHING parseable does NOT mean build it — it means ask",
  );
  assert(
    defaulted[0]?.verdictSource === "default",
    "...and the verdict is marked as driver-invented, not something the reply said",
  );
  assert(
    /could not be read/.test(defaulted[0]?.reason ?? ""),
    "...with a reason that says the verdict was unreadable, not that the issue was vague",
  );
  assert(
    parsePerIssueVerdicts("#561: NEEDS_WORK — go", [561])[0]?.verdictSource === "per-issue",
    "a real per-issue verdict is still recorded as parsed (the assertions above are not vacuous)",
  );
}

// 36. PR10 — parseMergeCommit pure helper.
{
  assert(
    parseMergeCommit("merge-commit: abc1234") === "abc1234",
    "parseMergeCommit: plain marker line captured",
  );
  assert(
    parseMergeCommit("**merge-commit:** `deadbee567`") === "deadbee567",
    "parseMergeCommit: markdown emphasis + backticks tolerated",
  );
  assert(
    parseMergeCommit("...preamble...\nmerge-commit: 1234567890abcdef") === "1234567890abcdef",
    "parseMergeCommit: marker line found inside multi-line reply",
  );
  assert(
    parseMergeCommit("no marker") === undefined,
    "parseMergeCommit: missing marker → undefined",
  );
  assert(
    parseMergeCommit(undefined) === undefined,
    "parseMergeCommit: undefined input → undefined",
  );
}

// 37. PR10 — runMerged actually dispatches ops on the happy path; the
// merged event captures the parsed merge-commit SHA. Empirical /work 561
// + /work 562 case: pre-PR10 driver said MERGED ✓ while PRs sat OPEN.
// After PR10 the dispatch fires and status flips on completion.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-merge-ok-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(950, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "merged",
        lastCompletedStep: "ci",
        branchName: "feature/issue-950",
        prNumber: 9501,
      },
    };
    await writeState(dir, s);
    // #380 — merging now needs an explicit grant AND executed evidence. These
    // tests cover the merge MECHANISM, so they grant it the way `--merge`
    // would and answer `gh` green. The gate is covered by
    // test-merge-authority.ts, and by the no-grant case at the end of this file.
    const greenGh = async (cmd: string) => {
      if (cmd.includes("mergeStateStatus")) {
        return { stdout: JSON.stringify({ mergeStateStatus: "CLEAN", state: "OPEN" }) };
      }
      if (cmd.includes("gh pr checks")) {
        return { stdout: JSON.stringify([{ name: "ci", bucket: "pass", isRequired: true }]) };
      }
      return { stdout: "" };
    };
    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 950,
      mergeGrant: true,
      verifyExecFn: greenGh,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        if (opts?.label === "ops:merge") {
          return mkResult({
            role: "ops",
            text: "PR squash-merged + branch deleted.\nmerge-commit: abc1234def\n",
          });
        }
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);
    const after = await readState(dir, 950);
    assert(
      seenLabels.includes("ops:merge"),
      "runMerged: ops:merge dispatch DID fire (was a 0ms no-op pre-PR10)",
    );
    assert(
      after?.pipelineState.status === "merged",
      "runMerged: terminal status='merged' after successful dispatch",
    );
    const mergedEvent = (after?.eventLog ?? []).find((e) => e.kind === "merged");
    assert(
      mergedEvent?.kind === "merged" && mergedEvent.mergeCommit === "abc1234def",
      "runMerged: merged event captures parsed mergeCommit SHA",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 38. PR10 — runMerged dispatch failure → cap-hit 'step-failed:merged' →
// handoff. STEP_FAILURE_POLICY[merged] is HALT (was DEGRADED_OK pre-PR10),
// so PR5's halt-cascade router intercepts when ops can't actually merge.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-merge-fail-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(951, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "merged",
        lastCompletedStep: "ci",
        branchName: "feature/issue-951",
        prNumber: 9511,
      },
    };
    await writeState(dir, s);
    // #380 — merging now needs an explicit grant AND executed evidence. These
    // tests cover the merge MECHANISM, so they grant it the way `--merge`
    // would and answer `gh` green. The gate is covered by
    // test-merge-authority.ts, and by the no-grant case at the end of this file.
    const greenGh = async (cmd: string) => {
      if (cmd.includes("mergeStateStatus")) {
        return { stdout: JSON.stringify({ mergeStateStatus: "CLEAN", state: "OPEN" }) };
      }
      if (cmd.includes("gh pr checks")) {
        return { stdout: JSON.stringify([{ name: "ci", bucket: "pass", isRequired: true }]) };
      }
      return { stdout: "" };
    };
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 951,
      mergeGrant: true,
      verifyExecFn: greenGh,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:merge") {
          return mkResult({
            role: "ops",
            ok: false,
            exitCode: 1,
            text: "[pi-ensemble] killed after 600000ms timeout",
          });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);
    const after = await readState(dir, 951);
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "step-failed:merged",
      "runMerged failure: cap='step-failed:merged' synthesised (PR5 halt-cascade router fires for HALT-class merged)",
    );
    assert(
      after?.pipelineState.status === "aborted",
      "runMerged failure: terminal status='aborted' (mid-flight failure routed through handoff)",
    );
    const explanation = explainCap("step-failed:merged", after!);
    assert(
      explanation.includes("gh pr merge") && /merge manually/i.test(explanation),
      "explainCap step-failed:merged gives the operator a merge-manually recovery hint",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 39. #380 — the whole point: with NO grant, the driver reaches the merged
// step and does NOT merge. This is the integration-level canary. Sections 37
// and 38 above both had to be given `mergeGrant: true` to keep passing, which
// is itself the proof that the gate is load-bearing rather than decorative:
// remove the gate and this section fails; remove the grant from 37 and IT
// fails.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-merge-nogrant-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    // Deliberately an AGENTS.md that says plenty but never grants merging —
    // the common real case, and stricter than simply omitting the file.
    await fs.writeFile(
      path.join(dir, "AGENTS.md"),
      "# Conventions\n\nOne PR per issue. Run the quality gate before pushing.\n",
    );
    let s2 = initialState(952, 1_000_000);
    s2 = {
      ...s2,
      pipelineState: {
        ...s2.pipelineState,
        currentStep: "merged",
        lastCompletedStep: "ci",
        branchName: "feature/issue-952",
        prNumber: 9521,
      },
    };
    await writeState(dir, s2);
    const seenLabels: string[] = [];
    await runWorkDriver({
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 952,
      issueBodyFetcherFn: mockIssueBodyOk,
      // No mergeGrant, and an AGENTS.md with no grant in it.
      verifyExecFn: async () => ({ stdout: "" }),
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        return mkResult({ role: "ops", text: "ok" });
      },
    });
    const after = await readState(dir, 952);
    assert(
      !seenLabels.includes("ops:merge"),
      "#380: with no grant, ops:merge NEVER dispatches — pre-#380 this merged unconditionally",
    );
    assert(
      after?.pipelineState.status !== "merged",
      "#380: and the cycle does not claim it merged",
    );
    const cap = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      cap?.kind === "cap-hit" && cap.cap === "awaiting-human-merge",
      "#380: it parks as awaiting-human-merge instead",
    );
    assert(
      after?.pipelineState.mergeHold?.authorityGranted === false,
      "#380: the hold records that authority — not evidence — was the blocker",
    );
    const explanation = explainCap("awaiting-human-merge", after!);
    assert(
      /9521/.test(explanation) && /not permitted/i.test(explanation),
      "#380: the operator explanation names the PR and says plainly it was not permitted",
    );
    assert(
      /AGENTS\.md/.test(explanation),
      "...and points at where the grant would have to come from",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);

#!/usr/bin/env bun/**
 * #798 (workstream `ws2`) — the handoff READER surfaces state WHERE the
 * artefacts landed, explicitly.
 *
 * The #782 incident: the handoff labelled PR #796, the event recorded
 * `labelApplied: true` with no target field, and an operator checking issue
 * #782 saw no label and (wrongly) concluded the driver had lied. The two
 * reader surfaces named by the ticket must now state the target without URL
 * parsing:
 *
 *   1. `renderHandoffUserMessage` (in-chat scrollback) — per-target label
 *      state (issue / PR) and the explicit comment target.
 *   2. `renderStatus` (the `/work-status` terminal surface) — the same
 *      facts, including the partial-failure split (issue verified, PR not).
 *
 * Pre-#798 events (no per-target fields) must render exactly as before —
 * the readers must not claim knowledge they don't have.
 */

import { renderStatus } from "../src/work-status.ts";
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

/** A cycle that parked after opening PR #796 (the #782 shape). */
function parkedWithPr(
  ev: {
    issueLabelApplied?: boolean;
    prLabelApplied?: boolean;
    targetType?: "issue" | "pr";
    targetNumber?: number;
  },
): WorkState {
  // biome-ignore lint/suspicious/noExplicitAny: partial fixture; readers read a subset
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 782,
    startedAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "commit-pr",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: "feature/issue-782-x",
      prNumber: 796,
    },
    eventLog: [
      { kind: "cap-hit", at: 3, cap: "lens-issues-found", reviewRound: 3, nextStep: "handoff" },
      {
        kind: "handoff-emitted",
        at: 4,
        commentUrl: "https://github.com/acme/widget/pull/796#issuecomment-1",
        labelApplied: ev.issueLabelApplied === true && ev.prLabelApplied === true,
        handoffBodyPath: `${REPO}/tmp/issue-782/handoff-comment.md`,
        ...ev,
      },
    ],
  } as any;
}

// ── 1. In-chat message: dual-target, both verified ─────────────────────────
{
  const out = renderHandoffUserMessage(
    parkedWithPr({
      targetType: "pr",
      targetNumber: 796,
      issueLabelApplied: true,
      prLabelApplied: true,
    }),
    REPO,
    `${REPO}/tmp/issue-782`,
  );
  assert(/label applied:/.test(out), "chat (dual ok): states the label block per-target");
  assert(/issue #782: applied/.test(out), "chat (dual ok): issue label verified on the issue");
  assert(/PR #796: applied/.test(out), "chat (dual ok): PR label verified on the PR");
  assert(/comment target: pr #796/.test(out), "chat (dual ok): the comment target is explicit (no URL parsing)");
}

// ── 2. In-chat message: partial failure (issue ok, PR not) ─────────────────
{
  const out = renderHandoffUserMessage(
    parkedWithPr({
      targetType: "pr",
      targetNumber: 796,
      issueLabelApplied: true,
      prLabelApplied: false,
    }),
    REPO,
    `${REPO}/tmp/issue-782`,
  );
  assert(/issue #782: applied/.test(out), "chat (partial): the issue label is applied");
  assert(/PR #796: NOT verified/.test(out), "chat (partial): the PR label is NOT verified (distinguished from success)");
  assert(!/label applied to/.test(out), "chat (partial): does not use the single-target 'applied to' phrasing");
}

// ── 3. In-chat message: pre-#798 event (no per-target fields) ──────────────
{
  const out = renderHandoffUserMessage(
    parkedWithPr({}),
    REPO,
    `${REPO}/tmp/issue-782`,
  );
  assert(
    /label applied to pr 796/.test(out),
    "chat (legacy event): the old single-target 'label applied to pr 796' line is unchanged",
  );
  assert(!/comment target:/.test(out), "chat (legacy event): no 'comment target' line invented from nothing");
}

// ── 4. /work-status terminal: dual-target + explicit target line ───────────
{
  const out = renderStatus(
    parkedWithPr({
      targetType: "pr",
      targetNumber: 796,
      issueLabelApplied: true,
      prLabelApplied: true,
    }),
    REPO,
  );
  assert(/target:  pr #796 \(explicit, #798\)/.test(out), "status (dual ok): the target line is explicit");
  assert(/on issue #782 \/ on PR #796/.test(out), "status (dual ok): per-target label state, both verified");
}

// ── 5. /work-status terminal: partial failure ───────────────────────────────
{
  const out = renderStatus(
    parkedWithPr({
      targetType: "pr",
      targetNumber: 796,
      issueLabelApplied: true,
      prLabelApplied: false,
    }),
    REPO,
  );
  assert(/NOT verified on PR #796/.test(out), "status (partial): PR label NOT verified is named");
  assert(/\(partial failure\)/.test(out), "status (partial): the partial failure is called out");
}

// ── 6. /work-status terminal: pre-#798 event renders as before ─────────────
{
  const out = renderStatus(parkedWithPr({}));
  assert(
    /label:   needs-human-attention applied/.test(out),
    "status (legacy event): the old single-boolean label line is unchanged",
  );
}

// ── 7. No-PR path: target is the issue, no PR label line ────────────────────
{
  // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  const s: any = parkedWithPr({
    targetType: "issue",
    targetNumber: 782,
    issueLabelApplied: true,
  });
  s.pipelineState.prNumber = undefined;
  const out = renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-782`);
  assert(/issue #782: applied/.test(out), "chat (no PR): issue label line is present");
  assert(!/PR #/.test(out.split("label applied:")[1] ?? ""), "chat (no PR): no PR label line when prLabelApplied is absent");
  assert(/comment target: issue #782/.test(out), "chat (no PR): the target names the issue");
}

console.log(`\nexit ${exit}`);
process.exit(exit);

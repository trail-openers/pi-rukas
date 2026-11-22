#!/usr/bin/env bun
/**
 * #2472 — a headless result never names a worktree the handoff removed.
 * `failure.evidence`, `failure.message`, `questions` and `causeEvidence` replace
 * each whole path in `handoffSnapshot.removedWorktrees` (before the bound is
 * applied), and leave every other path unchanged. Offline and pure.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { projectIssue } from "../src/headless/result.ts";
import type { WorkEvent } from "../src/workflow-state-events.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const GONE = "/r/.worktrees/issue-9-a";
const SIBLING = "/r/.worktrees/issue-9-a-b";
const KEPT = "/r/.worktrees/issue-9-b";
const LIT = "(a worktree the handoff removed)";
const LENS = `The fix's commits remain in the worktree ${GONE}. Also ${GONE} again. Sibling ${SIBLING} and retained ${KEPT} stay.`;
const PARK = `Open questions:\n- Which API does ${GONE} use now?\n- Is ${KEPT} the base?`;

type Snap = "unset" | "empty" | "removed";
function build(cap: string, evidence: string, snap: Snap): WorkState {
  let s = initialState(9);
  const events: WorkEvent[] = [
    { kind: "step-started", step: "review", at: 1 },
    { kind: "cap-hit", cap, at: 2, reviewRound: 1, nextStep: "handoff", evidence } as WorkEvent,
    { kind: "step-started", step: "handoff", at: 3 },
  ];
  for (const e of events) s = appendEvent(s, e);
  const ps = { ...s.pipelineState, status: "handoff" as const };
  if (snap !== "unset") {
    ps.handoffSnapshot = {
      modifiedFiles: [],
      unstagedCount: 0,
      stagedCount: 0,
      branchExists: true,
      branchPushed: false,
      capturedAt: 1,
      // GONE is both removed and retained: removal wins.
      retainedWorktrees: [KEPT, GONE],
      removedWorktrees: snap === "removed" ? [GONE] : [],
    };
  }
  return { ...s, pipelineState: ps };
}

// ── failure.evidence, failure.message and causeEvidence on a lens-fix cap.
{
  const r = projectIssue(build("lens-fix-not-integrated", LENS, "removed"), "f");
  const f = r.failure;
  assert(f !== undefined && f.evidence !== undefined, "the cap projects a failure with evidence");
  const want = `The fix's commits remain in the worktree ${LIT}. Also ${LIT} again. Sibling ${SIBLING} and retained ${KEPT} stay.`;
  assert(
    f?.evidence === want,
    `failure.evidence replaces every removed path only (${f?.evidence})`,
  );
  assert(f?.message === want, `failure.message replaces every removed path only (${f?.message})`);
  const cause = (r.causeEvidence ?? []).join("\n");
  assert(
    !cause.replaceAll(SIBLING, "").includes(GONE) && cause.includes(LIT),
    `causeEvidence names no removed path (${cause})`,
  );
  assert(cause.includes(KEPT) && cause.includes(SIBLING), "causeEvidence keeps the other paths");
}

// ── questions at exit 11: the path sits mid-line, after prose.
{
  const r = projectIssue(build("intent-park", PARK, "removed"), "f");
  assert(r.exitCode === 11, `intent-park is exit 11 (${r.exitCode})`);
  const q = JSON.stringify(r.questions);
  assert(
    q === JSON.stringify([`q1: Which API does ${LIT} use now?`, `q2: Is ${KEPT} the base?`]),
    `questions replace the removed path only (${q})`,
  );
}

// ── With no removed tree recorded, all four surfaces are unchanged.
for (const snap of ["unset", "empty"] as const) {
  const r = projectIssue(build("lens-fix-not-integrated", LENS, snap), "f");
  assert(r.failure?.evidence === LENS, `${snap}: failure.evidence is the cap's evidence`);
  assert(r.failure?.message === LENS, `${snap}: failure.message is its first line`);
  const cause = JSON.stringify(r.causeEvidence);
  assert(cause === JSON.stringify([LENS]), `${snap}: causeEvidence is the evidence (${cause})`);
  const q = JSON.stringify(projectIssue(build("intent-park", PARK, snap), "f").questions);
  assert(
    q === JSON.stringify([`q1: Which API does ${GONE} use now?`, `q2: Is ${KEPT} the base?`]),
    `${snap}: questions are the bullets (${q})`,
  );
}

// ── An input within the bound projects within the bound: the scrub runs before the clip.
for (const [field, max] of [
  ["evidence", 2000],
  ["message", 500],
] as const) {
  const text = `${GONE} ${"a b ".repeat(max)}`.slice(0, max);
  const v = projectIssue(build("lens-fix-not-integrated", text, "removed"), "f").failure?.[field];
  assert(
    v?.startsWith(LIT) === true && v.length > max - 16 && v.length <= max,
    `failure.${field} stays within ${max} (${v?.length})`,
  );
}

// ── The host contract states the replacement on all three rows.
{
  const lines = readFileSync(
    path.resolve(import.meta.dirname, "..", "..", "docs", "headless.md"),
    "utf8",
  ).split("\n");
  for (const lead of [
    "| `issues[].questions` | exit 11 only |",
    "| `message` | always |",
    "| `evidence` | when the cap recorded some |",
  ]) {
    assert(
      lines.some((l) => l.startsWith(lead) && l.includes(`\`${LIT}\``)),
      `docs/headless.md row ${lead} states the replacement`,
    );
  }
}

process.exit(exit);

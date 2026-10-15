#!/usr/bin/env bun
/**
 * After a consolidation, the handoff describes the branch it just filled.
 *
 * The cycle this pins (#1286): the handoff consolidated a parked
 * workstream onto the feature branch and restored the operator's checkout,
 * then printed, in one block:
 *
 *     branch: feature/issue-97-… (NOT pushed — local only) · HEAD 077f007
 *     0 file(s) modified
 *
 * `077f007` was the BASE commit — the snapshot read repoRoot's HEAD, which
 * the restore had just put back, not the branch — and "0 file(s) modified"
 * counted uncommitted files only. Beside "the branch holds the work" that
 * reads as an empty branch. The posted comment added `Rounds: 0 of 3 review
 * rounds` after an adversarial round and its fix pass had run: the number is
 * the six-lens counter and was true, the label did not say so.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { captureWorktreeSnapshot } from "../src/work-driver-handoff-snapshot.ts";
import { renderTerminalStatus } from "../src/work-status.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const BRANCH = "feature/issue-97-meter";
const tmp = mkdtempSync(join(tmpdir(), "pi-branch-tip-"));
const git = (...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd: tmp,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

try {
  // The world a successful consolidation leaves: the branch is two commits
  // past the base, and repoRoot is checked out where the operator was.
  git("init", "-q", "-b", "main");
  writeFileSync(join(tmp, "a.txt"), "base\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", BRANCH);
  for (const n of ["one", "two"]) {
    writeFileSync(join(tmp, "a.txt"), `${n}\n`);
    git("commit", "-q", "-am", n);
  }
  const tip = git("rev-parse", BRANCH);
  git("checkout", "-q", "main");

  const snap = await captureWorktreeSnapshot(tmp, BRANCH, undefined, base);
  assert(
    snap.branchTip?.sha === tip,
    `snapshot: records the feature branch's own tip (got ${JSON.stringify(snap.branchTip)})`,
  );
  assert(snap.branchTip?.ahead === 2, "snapshot: records how far the branch is ahead of the base");
  assert(
    base.startsWith(snap.repoRootHeadSha),
    "snapshot: repoRootHeadSha is still repoRoot's checkout — the base here",
  );

  const state: WorkState = {
    schemaVersion: 1,
    resumable: false,
    issue: 97,
    startedAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "adversarial",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: BRANCH,
      baseSha: base,
      handoffSnapshot: snap,
    },
    eventLog: [
      { kind: "adversarial-round", at: 2, round: 1, status: "ISSUES_FOUND", verdictParsed: true },
      { kind: "cap-hit", at: 3, cap: "verify-failed:develop", reviewRound: 0, nextStep: "handoff" },
    ],
  };

  const surfaces = {
    chat: renderHandoffUserMessage(state, tmp, join(tmp, "tmp/issue-97")),
    markdown: renderHandoffMarkdown(state),
    status: renderTerminalStatus(state, tmp),
  };
  for (const [name, text] of Object.entries(surfaces)) {
    assert(
      text.includes(tip.slice(0, 8)) && /2 commit\(s\) ahead of base/.test(text),
      `${name}: prints the branch's real tip and its commits ahead of the base`,
    );
  }
  const branchLine = (text: string) => text.split("\n").find((l) => l.includes("branch: ")) ?? "";
  for (const name of ["chat", "status"] as const) {
    assert(
      !branchLine(surfaces[name]).includes(base.slice(0, 7)),
      `canary — ${name}: the branch line does not carry the base commit as the branch's HEAD`,
    );
  }
  assert(
    /repo-root HEAD/.test(surfaces.markdown),
    "markdown: the repo-root HEAD it also prints is labelled as that",
  );
  assert(
    !/0 file\(s\) modified/.test(surfaces.chat) && /0 uncommitted file\(s\)/.test(surfaces.chat),
    'canary — chat: the porcelain count is labelled "uncommitted", not "0 file(s) modified"',
  );

  // The Rounds line says what it counts, and reports the adversarial rounds
  // the log already holds.
  assert(
    !/\*\*Rounds\*\*: 0 of 3 review rounds$/m.test(surfaces.markdown),
    "canary — markdown: no bare '0 of 3 review rounds' after an adversarial round ran",
  );
  assert(
    /\*\*Rounds\*\*: 0 of 3 review rounds \(six-lens review; the adversarial gate ran 1 round\(s\), last: ISSUES_FOUND\)/.test(
      surfaces.markdown,
    ),
    "markdown: names the counter and the adversarial round that ran",
  );
  const noAdv = renderHandoffMarkdown({
    ...state,
    eventLog: state.eventLog.filter((e) => e.kind !== "adversarial-round"),
  });
  assert(
    /\*\*Rounds\*\*: 0 of 3 review rounds \(six-lens review\)$/m.test(noAdv),
    "markdown: with no adversarial-round record it claims no adversarial rounds",
  );

  // A snapshot from before the field: the old value is still shown, labelled.
  const old = structuredClone(state);
  if (old.pipelineState.handoffSnapshot) old.pipelineState.handoffSnapshot.branchTip = undefined;
  assert(
    /repo-root HEAD/.test(branchLine(renderHandoffUserMessage(old, tmp, join(tmp, "tmp/x")))),
    "chat: a snapshot without branchTip falls back to repoRoot's HEAD, labelled as such",
  );

  // No branch → no tip invented.
  const none = await captureWorktreeSnapshot(tmp, "feature/never-created", undefined, base);
  assert(none.branchTip === undefined, "snapshot: a branch that does not exist has no tip");

  // An unknown distance is said to be unknown, never read as "no commits".
  const unknownState: WorkState = {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      handoffSnapshot: { ...snap, branchTip: { sha: tip } },
    },
  };
  const unknownChat = renderHandoffUserMessage(unknownState, tmp, join(tmp, "tmp/issue-97"));
  assert(
    !/0 file\(s\) modified/.test(unknownChat) && /commits ahead of base NOT READ/.test(unknownChat),
    "canary — chat: an unknown branch distance is NOT READ, not '0 file(s) modified'",
  );
  const unknownMarkdown = renderHandoffMarkdown(unknownState);
  assert(
    /commits ahead of base unknown/.test(unknownMarkdown),
    "markdown: an unknown branch distance is said to be unknown",
  );
  assert(
    !/file\(s\) modified/.test(unknownMarkdown) && /0 uncommitted file\(s\)/.test(unknownMarkdown),
    "canary — markdown: an unknown branch distance labels the count uncommitted, not 'file(s) modified'",
  );
  const unknownStatus = renderTerminalStatus(unknownState, tmp);
  assert(
    !/file\(s\) modified/.test(unknownStatus) && /0 uncommitted file\(s\)/.test(unknownStatus),
    "canary — status: an unknown branch distance labels the count uncommitted, not 'file(s) modified'",
  );

  // A base that is not a commit SHA is never handed to git; the gap is recorded.
  const badBase = await captureWorktreeSnapshot(tmp, BRANCH, undefined, "HEAD; echo x");
  assert(
    badBase.branchTip?.ahead === undefined &&
      (badBase.unreadable ?? []).some((l) => /is not a commit SHA/.test(l)),
    "snapshot: a non-SHA base is recorded as unread and rev-list is not run",
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.exit(exit);

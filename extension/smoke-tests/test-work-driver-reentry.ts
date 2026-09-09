#!/usr/bin/env bun
/**
 * Re-entry idempotence at the mechanized seams (census 2026-09-09).
 *
 * The seam audit found three unguarded re-entry paths:
 *   - `mechanizedCommitPr` had NO PR-existence check — a resume past a
 *     successful prCreate re-ran `integrate()` (whose `checkout -B` resets
 *     the branch to base) and created a duplicate PR, gated only by the
 *     push rejection;
 *   - the handoff writer never consulted a prior `handoff-emitted` event —
 *     a crash between comment-post and writeState re-posted a duplicate;
 *   - the mechanized branch/commit events used the literal jobId
 *     "mechanized" (twice per fan-out cycle in 37 state files) instead of
 *     the unique id `synthesizeDriverCompletion` already mints.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { mechanizedCommitPr } from "../src/work-driver-commit.ts";
import { priorHandoffCommentUrl } from "../src/work-driver-handoff.ts";
import { findOpenPrForBranch } from "../src/work-driver-pr-preflight.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------- findOpenPrForBranch

type Exec = (cmd: string, opts?: unknown) => Promise<{ stdout: string; stderr?: string }>;

{
  const cmds: string[] = [];
  const hit: Exec = async (cmd) => {
    cmds.push(cmd);
    return { stdout: JSON.stringify([{ number: 12 }]) };
  };
  assert(
    (await findOpenPrForBranch(hit as never, "/r", "feature/issue-9-x")) === 12,
    "findOpenPrForBranch: an open PR heading the branch returns its number",
  );
  assert(
    /--head "feature\/issue-9-x"/.test(cmds[0] ?? "") && /--state open/.test(cmds[0] ?? ""),
    "…via an exact --head --state open query",
  );
  const empty: Exec = async () => ({ stdout: "[]" });
  assert((await findOpenPrForBranch(empty as never, "/r", "b")) === undefined, "no PR → undefined");
  const boom: Exec = async () => {
    throw new Error("gh: network");
  };
  assert(
    (await findOpenPrForBranch(boom as never, "/r", "b")) === undefined,
    "unreadable gh FAILS OPEN (the push rejection remains the backstop)",
  );
  const garbage: Exec = async () => ({ stdout: "not json" });
  assert(
    (await findOpenPrForBranch(garbage as never, "/r", "b")) === undefined,
    "unparseable JSON fails open",
  );
}

// -------------------------------------- mechanizedCommitPr re-entry guard

{
  const NOW = 1_700_000_000_000;
  const base = initialState(9, NOW);
  const state: WorkState = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      currentStep: "commit-pr",
      branchName: "feature/issue-9-x",
      baseSha: "a".repeat(40),
      worktrees: { default: "/tmp/nowhere/wt" },
    },
  };
  const cmds: string[] = [];
  const exec: Exec = async (cmd) => {
    cmds.push(cmd);
    if (cmd.includes("gh pr list") && cmd.includes("--head")) {
      return { stdout: JSON.stringify([{ number: 77 }]) };
    }
    // inspectCommitPrRoot's git reads — generic empty answers are fine.
    return { stdout: "" };
  };
  const ctx = { repoRoot: "/tmp/nowhere", issue: 9, verifyExecFn: exec } as never;
  const res = await mechanizedCommitPr(ctx, state, NOW);
  assert(res.ok === true, "re-entry with an existing open PR short-circuits ok");
  const doneEvent = res.ok
    ? [...res.state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "dispatch-completed" }> =>
            e.kind === "dispatch-completed",
        )
    : undefined;
  assert(
    /RE-ENTRY: open PR #77/.test(doneEvent?.summary ?? "") &&
      /\npr: 77/.test(doneEvent?.summary ?? ""),
    "…emitting the completion event with the FOUND PR number (parsePrNumber-compatible)",
  );
  assert(
    doneEvent?.jobId !== "mechanized" && (doneEvent?.jobId ?? "").length > 0,
    "…with a unique jobId (the literal 'mechanized' correlation key is gone)",
  );
  assert(
    !cmds.some((c) => /checkout -B|git push|pr create/.test(c)),
    "…and NO integrate/push/prCreate command ran (the branch is never reset, no duplicate PR)",
  );
}

// ------------------------------------------------ handoff comment dedupe

{
  const NOW = 1_700_000_000_000;
  const base = initialState(9, NOW);
  const withPrior = appendEvent(base, {
    kind: "handoff-emitted",
    at: NOW + 1,
    commentUrl: "https://github.com/o/r/issues/9#issuecomment-123",
    labelApplied: true,
    handoffBodyPath: "/tmp/x",
  } as WorkEvent);
  assert(
    priorHandoffCommentUrl(withPrior.eventLog) ===
      "https://github.com/o/r/issues/9#issuecomment-123",
    "priorHandoffCommentUrl: a delivered comment is found (re-entry reuses it, never re-posts)",
  );
  assert(priorHandoffCommentUrl(base.eventLog) === undefined, "…absent when never delivered");
  const withEmpty = appendEvent(base, {
    kind: "handoff-emitted",
    at: NOW + 1,
    commentUrl: undefined,
    labelApplied: false,
    handoffBodyPath: "/tmp/x",
  } as WorkEvent);
  assert(
    priorHandoffCommentUrl(withEmpty.eventLog) === undefined,
    "…an emitted event WITHOUT a url is not proof of delivery",
  );
}

// ---------------------------------------------------------- source canaries

{
  const handoff = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "work-driver-handoff.ts"),
    "utf8",
  );
  assert(
    /parseHandoffCommentUrl\(opsReplyText\) \?\? priorHandoffCommentUrl\(/.test(handoff),
    "canary: the handoff writer consults the prior handoff-emitted event before posting",
  );
  const grep = [
    "work-driver-commit.ts",
    "work-driver-branch-develop.ts",
    "work-driver-merged.ts",
  ].map((f) => readFileSync(path.resolve(import.meta.dirname, "..", "src", f), "utf8"));
  assert(
    grep.every((s) => !/jobId:\s*"mechanized"/.test(s)),
    "canary: the non-unique literal jobId 'mechanized' is gone from the mechanized emitters",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

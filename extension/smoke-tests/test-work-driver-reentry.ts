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

import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mechanizedCommitPr } from "../src/work-driver-commit.ts";
import { priorHandoffCommentUrl } from "../src/work-driver-handoff.ts";
import { findOpenPrForBranch, findOpenPrForIssue } from "../src/work-driver-pr-preflight.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";
import { trackedTempDir } from "./lib/git-test-env.ts";

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

/**
 * The remote the non-existent-path lookup fixtures answer with.
 *
 * Both raw-`gh` pre-merge lookups now ask which forge the repo is on before
 * they run `gh` (they read the PR `body` field, which only GitHub's list
 * carries), so a fake exec that never answers the remote read gets a named
 * refusal instead of a PR row. A github.com remote is the answer that lets the
 * GitHub-side assertions run; the GitLab side is asserted in
 * `test-work-driver-forge-ctx.ts`.
 */
const GH_REMOTE = "https://github.com/o/r\n";

{
  const cmds: string[] = [];
  const hit: Exec = async (cmd) => {
    cmds.push(cmd);
    if (cmd.includes("remote.origin.url")) return { stdout: GH_REMOTE };
    return { stdout: JSON.stringify([{ number: 12 }]) };
  };
  assert(
    (await findOpenPrForBranch(hit as never, "/r", "feature/issue-9-x")) === 12,
    "findOpenPrForBranch: an open PR heading the branch returns its number",
  );
  // The lookup command itself, not the remote read that had to answer first.
  const lookup = cmds.find((c) => c.startsWith("gh pr list")) ?? "";
  assert(
    /--head "feature\/issue-9-x"/.test(lookup) && /--state open/.test(lookup),
    "…via an exact --head --state open query",
  );
  const empty: Exec = async (cmd) =>
    cmd.includes("remote.origin.url") ? { stdout: GH_REMOTE } : { stdout: "[]" };
  assert((await findOpenPrForBranch(empty as never, "/r", "b")) === undefined, "no PR → undefined");
  const boom: Exec = async (cmd) => {
    if (cmd.includes("remote.origin.url")) return { stdout: GH_REMOTE };
    throw new Error("gh: network");
  };
  assert(
    (await findOpenPrForBranch(boom as never, "/r", "b")) === undefined,
    "unreadable gh FAILS OPEN (the push rejection remains the backstop)",
  );
  const garbage: Exec = async (cmd) =>
    cmd.includes("remote.origin.url") ? { stdout: GH_REMOTE } : { stdout: "not json" };
  assert(
    (await findOpenPrForBranch(garbage as never, "/r", "b")) === undefined,
    "unparseable JSON fails open",
  );
}

{
  // The named refusal: the two raw-`gh` body lookups against a GitLab repo
  // never run `gh`. Both read the PR `body` — which is exactly why neither can
  // be answered on GitLab (its MR list carries no body field), and exactly why
  // both have to ask the forge first: running `gh` there answers "no PR" from
  // a command that cannot see the repository, which is how a duplicate PR gets
  // opened. `findOpenPrForIssue` is the branch-step pre-flight and the
  // repeat-park re-check; `findOpenPrForBranch` is the commit-pr re-entry guard.
  const cmds: string[] = [];
  const gl: Exec = async (cmd) => {
    cmds.push(cmd);
    if (cmd.includes("remote.origin.url")) {
      return { stdout: "git@gitlab.example.com:g/r.git\n" };
    }
    if (cmd.includes(".pi/forge")) return { stdout: "" };
    // A row that WOULD match, so a failure below cannot be blamed on empty data.
    return { stdout: JSON.stringify([{ number: 12, headRefName: "x", body: "Closes #9" }]) };
  };
  const repoRoot = trackedTempDir("reentry-gl-");
  mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
  writeFileSync(
    path.join(repoRoot, ".pi", "forge"),
    "type=gitlab\nhost=gitlab.example.com\n",
    "utf8",
  );
  assert(
    (await findOpenPrForBranch(gl as never, repoRoot, "feature/issue-9-x")) === undefined,
    "findOpenPrForBranch on a GitLab repo is a NAMED REFUSAL, not a gh call",
  );
  assert(
    (await findOpenPrForIssue(gl as never, repoRoot, 9)) === undefined,
    "findOpenPrForIssue on a GitLab repo is the same NAMED REFUSAL (the duplicate-PR pre-flight)",
  );
  assert(
    cmds.every(
      (c) =>
        !c.startsWith("gh ") &&
        !c.includes("pr list --state open --head") &&
        !c.includes("pr list --state open --limit 100"),
    ),
    `…and neither gh lookup ran (${cmds.join(" | ")})`,
  );
}

{
  // The positive control for the arm above: the SAME exec, with only the
  // remote's host changed, gets the row. Without it the GitLab refusal above
  // is indistinguishable from a lookup that never had data to answer with.
  const cmds: string[] = [];
  const gh: Exec = async (cmd) => {
    cmds.push(cmd);
    if (cmd.includes("remote.origin.url")) return { stdout: GH_REMOTE };
    return { stdout: JSON.stringify([{ number: 12, headRefName: "x", body: "Closes #9" }]) };
  };
  const found = await findOpenPrForIssue(gh as never, "/r", 9);
  assert(
    found?.number === 12 && found.matchedBy === "body",
    "findOpenPrForIssue on a GitHub repo still reads the body signal",
  );
  assert(
    cmds.some((c) => c.startsWith("gh pr list --state open --limit 100")),
    `…via the pinned gh command the builder documents (${cmds.find((c) => c.startsWith("gh "))})`,
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
    // The remote read the branch's forge detection makes before it will run a
    // `gh` lookup: the lookup is GitHub-only, so a repo whose forge cannot be
    // named refuses it (see `rawGhLookupRefusal`) and this fixture would see
    // no PR at all.
    if (cmd.includes("remote.origin.url")) {
      return { stdout: "https://github.com/o/r\n" };
    }
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

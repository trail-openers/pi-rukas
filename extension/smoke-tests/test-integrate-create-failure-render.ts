#!/usr/bin/env bun
/**
 * #1543 — when commit-pr cannot CREATE the integrate worktree, the handoff
 * names git's error, not a branch-holder audit that never ran.
 *
 * janit/tehas cycle 56-261017-115808: `git worktree add` failed with "fatal:
 * not a git repository", the fallback raised `integration-worktree-violation`
 * without dispatching anyone, and the handoff then said "commit-pr's ops
 * fallback worked in the wrong tree … inspect the offending holder" — the
 * #861 audit's story, for an ops child that never existed. The same record
 * carried "repoRoot was restored to undefined (verified)".
 */

import { explainCap } from "../src/work-driver-explain.ts";
import { recoveryStepsForCap } from "../src/work-driver-handoff-recovery.ts";
import { integrate } from "../src/work-driver-integrate.ts";
import { INTEGRATE_CREATE_FAILED_PREFIX } from "../src/workflow-state-cap.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";
import type { ExecFn } from "../src/worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string, detail?: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}${detail ? `\n  ${detail}` : ""}`);
    exit = 1;
  }
}

const GIT_ERR =
  "fatal: not a git repository (or any parent up to mount point /home/boss/tehas/work)";

function capped(evidence: string): WorkState {
  let s = initialState(56, 1) as WorkState;
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 2,
    cap: "integration-worktree-violation",
    evidence,
    reviewRound: 0,
    nextStep: "handoff",
  });
  return s;
}

{
  const s = capped(`${INTEGRATE_CREATE_FAILED_PREFIX}${GIT_ERR}`);
  const why = explainCap("integration-worktree-violation", s);
  assert(why.includes(GIT_ERR), "the explanation quotes git's error", why);
  assert(!why.includes("wrong tree"), "no ops child is said to have worked in the wrong tree", why);
  assert(!why.includes("offending holder"), "no holder is invented", why);
  assert(why.includes("No ops child was dispatched"), "it says no ops child ran", why);
  const text = JSON.stringify(recoveryStepsForCap(s, "github").steps);
  assert(text.includes(GIT_ERR), "the recovery steps carry git's error", text);
  assert(
    !text.includes("offending holder"),
    "the recovery steps do not send the operator to a holder",
  );
}

{
  // The #861 audit shape keeps its own story.
  const s = capped("branch feature/issue-56-x is held by /tmp/other-worktree");
  const why = explainCap("integration-worktree-violation", s);
  assert(
    why.includes("wrong tree"),
    "a real branch-holder violation keeps the audit's explanation",
  );
  assert(
    JSON.stringify(recoveryStepsForCap(s, "github").steps).includes("offending holder"),
    "...and its holder recovery steps",
  );
}

{
  // A failure before repoRoot's ref is read never touched repoRoot.
  const failing: ExecFn = async () => {
    throw Object.assign(new Error(GIT_ERR), { stdout: "", stderr: GIT_ERR });
  };
  const r = (await integrate(failing, {
    repoRoot: "/nonexistent/repo",
    branchName: "feature/issue-56-x",
    baseSha: "a".repeat(40),
    worktrees: { default: "/nonexistent/wt" },
    scratchDir: "/nonexistent/scratch",
    commitTitle: "t",
    commitBody: "b",
    mode: "create",
  })) as { ok: boolean; reason?: string };
  const reason = String(r.reason ?? "");
  assert(!r.ok, "the integrate fails");
  assert(!reason.includes("undefined"), "the restore claim never names an undefined ref", reason);
  assert(reason.includes("repoRoot was not touched"), "it says repoRoot was not touched", reason);
}

process.exit(exit);

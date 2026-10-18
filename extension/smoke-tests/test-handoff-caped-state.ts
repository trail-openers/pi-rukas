#!/usr/bin/env bun
/**
 * #543 F5 (M4/M7) — the cap-hit checkpoint block (capedPartialState)
 * reaches BOTH handoff renderers. Split from test-handoff-rendering.ts
 * (AGENTS.md §12 file-size limit).
 *
 * The driver stages+commits the worktree after a loop/token-budget cap
 * kill and records the result on pipelineState.capedPartialState; the
 * renderers must surface it — the operator's "what was saved" is the
 * driver's composed state, never the killed child's final text.
 */

import { CHECKPOINT_TYPECHECK_CMD } from "../src/work-driver-cap-checkpoint.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
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

/** #1414 — the command the checkpoint runs. Imported from the leaf that
 * defines it, not re-spelled here: a local copy is exactly the two-sources-
 * of-truth shape this assertion exists to catch, and when the driver's
 * spelling moved to the project's own compiler this line kept asserting the
 * old command and failed for the wrong reason. */
const TYPECHECK_CMD = CHECKPOINT_TYPECHECK_CMD;

function capedState(
  cap: string,
  role: string,
  over: Partial<WorkState["pipelineState"]["capedPartialState"]> = {},
): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 543,
    createdAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "develop",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: "feature/issue-543-caps",
      capedPartialState: {
        cap,
        role: role as WorkState["pipelineState"]["capedPartialState"]["role"],
        tree: "committed",
        at: Date.now(),
        ...over,
      },
    },
    eventLog: [{ kind: "cap-hit", at: 3, cap, reviewRound: 0, nextStep: "handoff" }],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; renderers read a subset
  } as any;
}

const capRenderers = [
  ["chat", (s: WorkState) => renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-543`)],
  ["markdown", (s: WorkState) => renderHandoffMarkdown(s, REPO)],
] as const;

// (a) develop caped, committed + remaining named.
{
  const s = capedState("loop-detected", "developer", {
    tree: "committed",
    commitSha: "abc1234",
    statusFile: `${REPO}/tmp/issue-543/status-developer.md`,
    remainingFiles: ["extension/src/foo.ts", "extension/src/bar.ts"],
  });
  for (const [name, out] of capRenderers.map(([n, f]) => [n, f(s)] as const)) {
    assert(out.includes("Cap-hit checkpoint"), `${name} (a): renders the checkpoint block`);
    assert(out.includes("abc1234"), `${name} (a): names the checkpoint commit sha`);
    assert(
      out.includes("extension/src/foo.ts") && out.includes("extension/src/bar.ts"),
      `${name} (a): names the remaining uncommitted paths`,
    );
    assert(/status-developer\.md/.test(out), `${name} (a): points at the driver status file`);
  }
}

// (b) dirty tree, nothing committed → the UNVERIFIED PARTIAL STATE tag.
{
  const s = capedState("token-budget", "developer", {
    tree: "dirty-uncommitted",
    remainingFiles: ["extension/src/foo.ts"],
  });
  for (const [name, out] of capRenderers.map(([n, f]) => [n, f(s)] as const)) {
    assert(
      /UNVERIFIED PARTIAL STATE/.test(out),
      `${name} (b): dirty+uncommitted → the unverified-partial-state tag`,
    );
  }
}

// (c) lens loop-killed → the cap hit carries the cap string, the surviving
// lenses' verdicts render from lensReviewSummary (M7), and the write-gated
// role is report-only (M5).
{
  const s = capedState("loop-detected", "code-review-specialist", {
    tree: "clean",
    reportOnly: true,
  });
  s.pipelineState.lensReviewSummary = {
    round: 1,
    verdict: "REVIEW_INCOMPLETE",
    lenses: [
      { lens: "correctness", ok: true, blocked: false, findings: 0 },
      { lens: "security", ok: false, blocked: false, findings: 2 },
      { lens: "looping-lens", ok: false, blocked: true, findings: 0 },
    ],
  };
  s.pipelineState.lastCompletedStep = "lens-review";
  for (const [name, out] of capRenderers.map(([n, f]) => [n, f(s)] as const)) {
    assert(
      out.includes("REVIEW_INCOMPLETE"),
      `${name} (c): surfaces the REVIEW_INCOMPLETE verdict`,
    );
    assert(
      out.includes("### Completed lenses"),
      `${name} (c): renders the completed-lenses section (M7)`,
    );
    assert(
      out.includes("security: issues (2 finding(s))"),
      `${name} (c): names a sibling lens's verdict + finding count`,
    );
    assert(
      /report-only/.test(out),
      `${name} (c): states the role is structurally write-gated (report-only)`,
    );
  }
}

// (d) explore caped → report-only (no commit was ever expected).
{
  const base = capedState("token-budget", "explore", { tree: "clean", reportOnly: true });
  const s: WorkState = {
    ...base,
    pipelineState: { ...base.pipelineState, branchName: undefined, lastCompletedStep: "explore" },
  };
  for (const [name, out] of capRenderers.map(([n, f]) => [n, f(s)] as const)) {
    assert(/report-only/.test(out), `${name} (d): explore cap kill renders the report-only line`);
    assert(
      !out.includes("committed work"),
      `${name} (d): does not claim committed work for a write-gated role`,
    );
  }
}

// (e) #1414 — typecheck FAILED: both renderers name the command the driver
// actually ran. Before the fix the bullet claimed the driver had run
// `bunx tsc --no-emit` — an alias provisioning may not create and a flag tsc
// does not accept — so the operator was told committed code was broken on the
// strength of a command that could never have succeeded. No case here ever
// set `typechecked`, so the line had zero regression coverage.
{
  const s = capedState("loop-detected", "developer", {
    tree: "committed",
    commitSha: "def4567",
    typechecked: false,
    statusFile: `${REPO}/tmp/issue-543/status-developer.md`,
  });
  for (const [name, out] of capRenderers.map(([n, f]) => [n, f(s)] as const)) {
    assert(
      out.includes("typecheck FAILED at checkpoint"),
      `${name} (e): the failed-typecheck bullet renders`,
    );
    assert(
      out.includes(TYPECHECK_CMD),
      `${name} (e): names the command the checkpoint ran (${TYPECHECK_CMD})`,
    );
    assert(!/\bbunx\b/.test(out), `${name} (e): no bare bunx in the handoff`);
    assert(!out.includes("--no-emit"), `${name} (e): no non-existent tsc flag in the handoff`);
  }
}

// (f) #1414 — a passing typecheck adds no broken-code claim (absent and true
// both render nothing; only false does).
{
  const s = capedState("loop-detected", "developer", {
    tree: "committed",
    commitSha: "aaa1111",
    typechecked: true,
  });
  for (const [name, out] of capRenderers.map(([n, f]) => [n, f(s)] as const)) {
    assert(
      !/typecheck FAILED/.test(out),
      `${name} (f): a passing typecheck makes no broken-code claim`,
    );
    assert(!out.includes(TYPECHECK_CMD), `${name} (f): a passing typecheck names no command`);
  }
}

// (g) #1414 round 2 — the typecheck reached NO VERDICT (the field is absent).
// Pre-fix this shape was indistinguishable from "broken", in BOTH
// directions: a command that could not run reached the renderer as `false`
// (the broken-code bullet, a lie), and once round 2 makes the field honestly
// absent, the renderer must not fall into "no bullet, therefore it passed".
// It says plainly that nothing was judged, names the reason, and claims
// neither way about the code.
{
  const s = capedState("loop-detected", "developer", {
    tree: "committed",
    commitSha: "bbb2222",
    typechecked: undefined,
    typecheckReason: "could not run (sh: tsc: command not found)",
    statusFile: `${REPO}/tmp/issue-543/status-developer.md`,
  });
  for (const [name, out] of capRenderers.map(([n, f]) => [n, f(s)] as const)) {
    assert(
      !/typecheck FAILED/.test(out),
      `${name} (g): a check that never ran is NEVER reported as a failed typecheck`,
    );
    assert(
      /typecheck: no verdict/.test(out),
      `${name} (g): the no-verdict bullet renders — silence here would read as "it passed"`,
    );
    assert(
      out.includes("could not run"),
      `${name} (g): the handoff carries the REASON the operator can act on`,
    );
    assert(
      out.includes(TYPECHECK_CMD) && !/\bbunx\b/.test(out) && !out.includes("--no-emit"),
      `${name} (g): names the command it meant, spelled correctly`,
    );
    assert(
      !/the code is broken as-is/.test(out),
      `${name} (g): makes no broken-code claim without a verdict`,
    );
  }
}

// (h) #1414 round 2 — mutation direction for (g): a REAL diagnostic still
// produces the broken-code bullet. Without this case, deleting the `false`
// branch (or routing everything to the no-verdict bullet) would pass (g).
{
  const s = capedState("loop-detected", "developer", {
    tree: "committed",
    commitSha: "ccc3333",
    typechecked: false,
  });
  for (const [name, out] of capRenderers.map(([n, f]) => [n, f(s)] as const)) {
    assert(
      /typecheck FAILED at checkpoint/.test(out),
      `${name} (h): a real verdict still blames the code`,
    );
    assert(
      !/typecheck: no verdict/.test(out),
      `${name} (h): a verdict is not rendered as no-verdict`,
    );
  }
}

// (i) #1414 round 2 — a clean tree with no verdict needs no warning: nothing
// was committed, so nothing is being passed off as sound.
{
  const s = capedState("token-budget", "explore", {
    tree: "clean",
    reportOnly: true,
    typechecked: undefined,
  });
  for (const [name, out] of capRenderers.map(([n, f]) => [n, f(s)] as const)) {
    assert(
      !/typecheck/.test(out),
      `${name} (i): a report-only / clean checkpoint makes no typecheck claim at all`,
    );
  }
}

// (j) #1414 round 3 — a DIRTY-UNCOMMITTED checkpoint that never ran the
// typecheck. This is the case the round-2 bullet got wrong: the checkpoint
// commits only when the tree is dirty, and the typecheck runs on that path
// only — so a record whose commit attempt failed, or whose checkpoint never
// reached the check, had `typechecked` absent and `tree` dirty with no
// `typecheckAttempted`, and the renderer printed the no-verdict bullet anyway,
// either bare ("reason: not recorded") or, pre-round-2, claiming a verdict it
// never got. The handoff must say PLAINLY that the check was not attempted,
// and must not present a reason it does not have.
{
  const s = capedState("loop-detected", "developer", {
    tree: "dirty-uncommitted",
    remainingFiles: ["extension/src/partial.ts"],
    // typechecked absent, typecheckReason absent, typecheckAttempted absent —
    // exactly what a checkpoint that never ran the check records.
  });
  for (const [name, out] of capRenderers.map(([n, f]) => [n, f(s)] as const)) {
    assert(
      /typecheck: not attempted/.test(out),
      `${name} (j): a checkpoint that never ran the check says so, rather than going silent`,
    );
    assert(
      !/typecheck: no verdict/.test(out),
      `${name} (j): no no-verdict bullet for a check that was never attempted — that bullet asserts an attempt`,
    );
    assert(!/typecheck FAILED/.test(out), `${name} (j): no broken-code claim without a verdict`);
    assert(
      !/not recorded; see the status file/.test(out),
      `${name} (j): the handoff does not print a reason placeholder it has no reason for`,
    );
    assert(
      /the driver did not run/.test(out),
      `${name} (j): the wording attributes the absence to the driver, not to the code`,
    );
    assert(
      out.includes(TYPECHECK_CMD) && !/\bbunx\b/.test(out) && !out.includes("--no-emit"),
      `${name} (j): names the command it did not run, spelled correctly`,
    );
    // The dirty-state warning the operator needs is still there — the new
    // bullet supplements it, it does not replace it.
    assert(
      /UNVERIFIED PARTIAL STATE/.test(out),
      `${name} (j): the unverified-partial-state warning still renders`,
    );
  }
}

// (k) #1414 round 3 — mutation direction for (j): the SAME dirty tree with the
// check genuinely attempted and genuinely undecided still gets the no-verdict
// bullet with its reason. Without this case, (j) is satisfied by deleting the
// whole no-verdict branch.
{
  const s = capedState("loop-detected", "developer", {
    tree: "dirty-uncommitted",
    remainingFiles: ["extension/src/partial.ts"],
    typechecked: undefined,
    typecheckAttempted: true,
    typecheckReason:
      "the host could not start the typecheck (fork failed / out of process slots), so it judged nothing",
  });
  for (const [name, out] of capRenderers.map(([n, f]) => [n, f(s)] as const)) {
    assert(
      /typecheck: no verdict/.test(out),
      `${name} (k): an ATTEMPTED check with no verdict still renders the no-verdict bullet`,
    );
    assert(out.includes("fork failed"), `${name} (k): the recorded reason reaches the operator`);
    assert(
      !/typecheck: not attempted/.test(out),
      `${name} (k): an attempted check is never described as not attempted`,
    );
  }
}

// (l) #1414 round 3 — an ATTEMPTED check that typechecked cleanly renders no
// typecheck bullet at all, and specifically not the not-attempted one. This is
// the (f) assertion re-made under the new gate: `typechecked: true` falls
// through both the `false` test and the `undefined` test, and the not-attempted
// bullet lives inside the `undefined` branch, so a restructure that hoists it
// out would be caught here.
{
  const s = capedState("loop-detected", "developer", {
    tree: "dirty-uncommitted",
    typechecked: true,
  });
  for (const [name, out] of capRenderers.map(([n, f]) => [n, f(s)] as const)) {
    assert(
      !/typecheck: not attempted/.test(out),
      `${name} (l): a clean typecheck on a dirty tree is not reported as an unattempted check`,
    );
    assert(!/typecheck/.test(out), `${name} (l): a passing check names no command`);
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);

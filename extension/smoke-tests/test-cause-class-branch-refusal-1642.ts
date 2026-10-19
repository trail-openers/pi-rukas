#!/usr/bin/env bun
/**
 * #1642 (interactive #1557) — a branch step that refused a stale worktree said
 * "check sleep/suspend … caffeinate". The refusal had been recorded verbatim
 * two fields away in `plumbReports`; nothing read it.
 *
 * Split from test-cause-class.ts for the AGENTS.md §12 500-line cap; the
 * fixtures there keep the five measured parks and the completeness half.
 */
import { causeVerdictOf } from "../src/work-driver-cause-class.ts";
import { TEMPLATE_CAP_CAUSE } from "../src/work-driver-cause-table.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function assertDefined<T>(v: T | undefined, msg: string): asserts v is T {
  assert(v !== undefined, msg);
  if (v === undefined) throw new Error(`missing: ${msg}`);
}

const REPO = "/REPO";

/** The 1557 state's own plumb-report body, verbatim in its operative parts. */
function state1557(body: string): WorkState {
  return {
    issue: 1557,
    schemaVersion: 1,
    resumable: true,
    createdAt: 1,
    updatedAt: 3,
    pipelineState: {
      status: "aborted",
      currentStep: "handoff",
      lastCompletedStep: "branch",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      plumbReports: [{ step: "branch", role: "driver", body, at: 2 }],
    },
    eventLog: [
      { kind: "step-started", step: "branch", at: 1 },
      {
        kind: "cap-hit",
        at: 2,
        cap: "step-failed:branch",
        reviewRound: 0,
        nextStep: "handoff",
      },
    ],
  } as unknown as WorkState;
}

const wt = `${REPO}/.worktrees/issue-1557-default`;
const salvageDir = `${REPO}/tmp/issue-1557/salvage/issue-1557-default`;
// The refusal and the salvage note are SEPARATE lines in the real plumb report
// (the branch step joins them with `\n`), and the classifier reads the salvage
// directory by line — so the fixture reproduces that shape, not a flattened one.
const refusal = [
  `refusing to force-remove existing worktree ${wt} — it holds unrecoverable work: 1 uncommitted file(s): !! dist/`,
  "Inspect the worktree (`git status`, `git diff`), salvage the work, then remove it and re-run.",
  // The salvage note is a SECOND line in the real plumb report (the branch
  // step joins them with `\n`) and the classifier reads the salvage directory
  // by line, so the fixture reproduces that shape rather than flattening it.
  `\nSalvaged dirty worktree ${wt} (workstream 'refused') to ${salvageDir} (salvage.patch, untracked.txt, files/)`,
  `— inspect it, then remove the worktree (\`git worktree remove --force -- ${wt}\`) and re-run.`,
].join(" ");

{
  const v = causeVerdictOf(state1557(refusal), "step-failed:branch", undefined);
  assertDefined(v, "a verdict exists for the branch refusal");
  assert(
    v.causeClass === "environment",
    "1557: the branch worktree refusal is an operator-clearable environment cause, not a driver gap",
  );
  assert(
    v.causeReason.includes("stale worktree") && v.causeReason.includes("branch"),
    "1557: the reason names the stale worktree that blocked the branch step",
  );
  assert(
    !/caffeinate|suspend|sleep/i.test(`${v.causeReason} ${v.userAction ?? ""}`),
    "1557: the refusal no longer tells the operator to go look for a host suspend",
  );
  assert(
    (v.userAction ?? "").includes(`git worktree remove --force -- ${wt}`) &&
      (v.userAction ?? "").includes(salvageDir) &&
      (v.userAction ?? "").includes("/work 1557"),
    "1557: the action names the salvage, the exact removal command and the re-run",
  );
  assert(
    v.causeEvidence.some((l) => l.includes("!! dist/")),
    "1557: the evidence quotes the plumb line that recorded the real reason",
  );
}

// A step-failed with NO refusal evidence keeps today's kind-driven behaviour —
// the branch step's shape when the ops fallback failed too and nobody recorded why.
{
  const bare = state1557("");
  bare.pipelineState.plumbReports = [];
  const v = causeVerdictOf(bare, "step-failed:branch", undefined);
  assertDefined(v, "a verdict exists for a bare step-failed:branch");
  assert(
    v.causeReason === TEMPLATE_CAP_CAUSE["step-failed"].reason,
    "a step-failed with no evidence keeps the generic table reason (no invented cause)",
  );
}

// A sibling-listing refusal names no worktree to remove: it falls through rather
// than being handed a removal command it cannot honour.
{
  const v = causeVerdictOf(
    state1557(
      "git worktree list failed, so same-issue siblings could not be scanned: fatal: bad object",
    ),
    "step-failed:branch",
    undefined,
  );
  assert(
    v?.causeReason === TEMPLATE_CAP_CAUSE["step-failed"].reason,
    "a refusal that names no worktree is not given a removal command it cannot honour",
  );
}

// The path lifted from the refusal text is interpolated into a shell command
// the OPERATOR runs. A path the conservative shape check rejects (here: one
// carrying `;` and a backtick) must never reach the command — the handoff
// degrades to the `<path>` placeholder and points at the quoted evidence.
{
  const injected = `${REPO}/.worktrees/issue-1557-x;`;
  const v = causeVerdictOf(
    state1557(
      `refusing to force-remove existing worktree ${injected}\`touch /tmp/pwned\` — it holds unrecoverable work: 1 uncommitted file(s): !! dist/`,
    ),
    "step-failed:branch",
    undefined,
  );
  assertDefined(v, "a verdict exists for a refusal naming a malformed path");
  assert(
    (v.userAction ?? "") ===
      "inspect the worktree itself — inspect the worktree named in the evidence, " +
        "remove the worktree with `git worktree remove --force -- <path>`, then re-run `/work 1557`",
    "a path outside the safe shape is replaced by <path>, never interpolated into the removal command",
  );
  assert(
    (v.userAction ?? "").includes("inspect the worktree named in the evidence") &&
      v.causeEvidence.some((l) => l.includes(injected)),
    "the degraded action points at the evidence, which still quotes the real path",
  );
}

// The ordinary mechanized-failure report (no refusal) is not a refusal either —
// it reaches the ops fallback, and must not be dressed up as one.
{
  const v = causeVerdictOf(
    state1557("Mechanized branch setup failed (git error: fatal: cannot lock ref 'refs/heads/x')"),
    "step-failed:branch",
    undefined,
  );
  assert(
    v?.causeReason === TEMPLATE_CAP_CAUSE["step-failed"].reason,
    "a non-refusal mechanized failure is not classified as a worktree refusal",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

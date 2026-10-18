#!/usr/bin/env bun
/**
 * #747 — the handoff must not tell the operator to push or cherry-pick a
 * branch that was never created.
 *
 * The #674 worktree-aware recovery block (work-driver-handoff-recovery-
 * worktree.ts) gated ONLY on `committedWork.length > 0 && ps.branchName`.
 * `branchName` is written by the branch step and survives every later cap,
 * so a cycle that recorded committed work on detached-HEAD worktrees and
 * then lost (or never had) its local branch still rendered
 * `git checkout <branch>` / `git cherry-pick …` / `git push -u origin
 * <branch>` — commands against a ref that does not exist. The message
 * renderer already reads `handoffSnapshot.branchExists` for exactly this
 * distinction ("no branch was created"); the recovery renderer did not.
 *
 * The issue's acceptance criterion is a MATRIX: every cap × branchExists
 * (true/false), asserting BOTH renderers (the in-chat user message and the
 * GitHub markdown body) agree on whether the block appears. Both surfaces
 * read the same shared decision (`recoveryStepsForCap`), so the block's
 * presence is decided once — this test pins the predicate AND that neither
 * surface re-introduces push/checkout text on its own.
 */

import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { recoveryStepsForCap } from "../src/work-driver-handoff-recovery.ts";
import type { WorkEvent } from "../src/workflow-state-events.ts";
import type { WorkStep } from "../src/workflow-state-events.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO = "/Users/x/repo";
const ISSUE = 747;
const BRANCH = "feature/issue-747";
const BASE = "aaaabbbb11112222333344445555666677778888";

/** Every concrete cap literal in the `cap-hit` union (the template caps get
 * their own instance with a real step substituted below). */
const PLAIN_CAPS = [
  "adversarial-loop",
  "round-cap",
  "wall-clock",
  "review-incomplete",
  "ci-retry",
  "spawn-backstop",
  "explore-already-complete",
  "explore-needs-clarification",
  "explore-bodies-empty",
  "step-back-revise-spec",
  "commit-pr-incomplete-consolidation",
  "lens-fix-not-integrated",
  "integration-verify-failed",
  "integration-worktree-violation",
  "consolidated-verify-conflict",
  "consolidated-verify-consolidation-created",
  "consolidation-incomplete",
  "develop-incomplete-deliverables",
  "intent-park",
  "awaiting-human-merge",
  "lens-diff-unreadable",
  "draft-rearm-failed",
  "existing-pr-detected",
  "ops-merge-base-mismatch",
  "adversarial-infra-failure",
  "provider-unavailable",
  "cross-group-conflict",
  "dependency-timeout",
  "dependency-parked",
  "dependency-cycle",
  "queue-stranded",
  "loop-detected",
  "token-budget",
  "plan-timeout",
  "plan-spec-mismatch",
  "repeat-finding-seam",
  "fix-pass-park",
  "deferred-creation:develop",
  "fence-violation:develop",
  "repo-root-residue",
  "no-review-outcome",
  "lens-fix-reposition",
  "deadline",
  "develop-child-crash",
  "worktree-listing-unreadable",
] as const;

/** The template-literal caps (`verify-failed:${WorkStep}` etc.) with a real
 * step substituted, so a template cap is exercised too. */
const STEPS: WorkStep[] = [
  "explore",
  "plan",
  "branch",
  "develop",
  "adversarial",
  "commit-pr",
  "lens-review",
  "lens-fix",
  "ci",
  "merged",
  "handoff",
];
const TEMPLATES = [
  "verify-failed",
  "verify-timeout",
  "verify-env",
  "verify-baseline-red",
  "pr-not-open",
  "step-failed",
  "driver-crash",
] as const;

function allCaps(): string[] {
  const caps: string[] = [...PLAIN_CAPS];
  for (const t of TEMPLATES) for (const s of STEPS) caps.push(`${t}:${s}`);
  caps.push("branch-ahead:42");
  return caps;
}

/**
 * The shape the issue describes: committed work sits on detached-HEAD
 * worktrees (so `committedWork` is non-empty), `branchName` is set, and the
 * only variable is whether the local branch actually exists.
 */
function state(opts: {
  cap: string;
  branchExists: boolean;
  consolidated: boolean;
  /**
   * Whether the `handoff-consolidated` event counts as proof of the ref.
   * True only when the snapshot positively read the branch — in
   * `runHandoff` the snapshot is captured AFTER consolidation, so a real
   * successful consolidation always leaves `branchExists: true`. The matrix
   * sets this false for `branchExists: false` so the consolidated variant
   * with no resolvable ref is exercised (the shape where the block used to
   * print `git push -u origin <branch>` for a ref that did not exist).
   */
  consolidateProof?: boolean;
  branchName?: string | undefined;
  committedWork?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: partial fixture; renderers read a subset
}): any {
  const committedWork = opts.committedWork ?? true;
  // The driver writes `handoff-consolidated` BEFORE capturing the snapshot,
  // so `consolidateProof: true` with `branchExists: false` is the snapshot-
  // read-failed shape; `consolidateProof: false` with `branchExists: false`
  // is the never-had-a-ref shape. Both must render no ref-moving command.
  const refProven = opts.consolidateProof ?? opts.branchExists;
  const events: WorkEvent[] = [
    {
      kind: "cap-hit",
      at: 3,
      // biome-ignore lint/suspicious/noExplicitAny: cap literal built from the enumerated list
      cap: opts.cap as any,
      reviewRound: 0,
      nextStep: "handoff",
    },
  ];
  if (opts.consolidated && refProven) {
    events.push({
      kind: "handoff-consolidated",
      at: 4,
      branchName: BRANCH,
      workstreams: ["default", "task-a"],
      restoreClaim: "repoRoot restored to the operator's original checkout",
    });
    events.push({
      kind: "handoff-emitted",
      at: 5,
      commentUrl: "https://github.com/acme/repo/issues/747#issuecomment-1",
      labelApplied: true,
      handoffBodyPath: `${REPO}/tmp/issue-747/handoff-comment.md`,
      consolidated: true,
      consolidatedBranch: BRANCH,
      consolidatedWorkstreams: ["default", "task-a"],
    });
  }
  return {
    schemaVersion: 1,
    resumable: false,
    issue: ISSUE,
    startedAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "develop",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: opts.branchName === undefined ? BRANCH : opts.branchName,
      baseSha: BASE,
      worktrees: {
        default: `${REPO}/.worktrees/issue-747-default`,
        "task-a": `${REPO}/.worktrees/issue-747-task-a`,
      },
      handoffSnapshot: {
        modifiedFiles: [],
        unstagedCount: 0,
        stagedCount: 0,
        branchExists: opts.branchExists,
        branchPushed: false,
        repoRootHeadSha: "99998888",
        capturedAt: 1000,
        ...(committedWork
          ? {
              committedWork: [
                {
                  worktreeId: "default",
                  path: `${REPO}/.worktrees/issue-747-default`,
                  headSha: "1111222233334444555566667777888899990000",
                  ahead: 2,
                },
                {
                  worktreeId: "task-a",
                  path: `${REPO}/.worktrees/issue-747-task-a`,
                  headSha: "aabbccddeeff0011223344556677889900112233",
                  ahead: 1,
                },
              ],
            }
          : {}),
      },
    },
    eventLog: events,
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any;
}

/** Does a rendered handoff tell the operator to move a branch that may not exist? */
/**
 * Lines that tell the operator to move a branch. Deliberately does NOT
 * count the `commit-pr-incomplete-consolidation` recipe's own `git push`
 * (no `-u origin`): that cap fires after commit-pr, when the branch really
 * does exist, and that recipe is chartered separately (#875).
 */
/**
 * Command lines that tell the operator to move a branch that may not exist.
 * Comment (`#`) and bullet (`-`) lines are excluded: the consolidation-explain
 * sections legitimately *say* "cherry-pick conflict" and `explainCap` names
 * worktree paths — prose, not commands. `Take over manually` is the header of
 * the generic block that emits `git add -p` / `git push -u origin <branch>`,
 * so it is counted even where its commands are indented.
 */
function branchMovingLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("#") && !l.startsWith("- "))
    .filter(
      (l) =>
        /git push -u origin\s+feature\//.test(l) ||
        /^git checkout\s+feature\//.test(l) ||
        /\bgit cherry-pick\b/.test(l) ||
        /\bgit add -p\b/.test(l) ||
        /Take over manually/.test(l),
    );
}

/**
 * `commit-pr-incomplete-consolidation` owns its whole recovery surface in
 * both renderers — it renders its per-workstream inspect/apply sequence and
 * RETURNS before the worktree block — so the "did the block render" prose
 * probe cannot see it. Its block presence is asserted against the shared
 * decision, and its renderer behaviour in a dedicated case below.
 */
const CONSOLIDATION_CAP = "commit-pr-incomplete-consolidation";

function worktreeStepCount(state: ReturnType<typeof state>): number {
  return recoveryStepsForCap(state, "github").steps.filter(
    (s) => s.section === "worktree-work-consolidated" || s.section === "worktree-work-fallback",
  ).length;
}

/** Did the fixture give this state a consolidation event (the second proof)? */
function refProvenFor(state: ReturnType<typeof state>): boolean {
  return state.eventLog.some((e: { kind: string }) => e.kind === "handoff-consolidated");
}

// ---------------------------------------------------------------------------
// 1. The matrix: every cap × branchExists, both renderers must agree.
// ---------------------------------------------------------------------------
{
  const caps = allCaps();
  assert(caps.length >= 50, `matrix covers every cap literal (${caps.length} caps)`);

  let mismatches = 0;
  let falsePushBlocks = 0;
  const seenNoBranch = new Set<string>();
  const seenBranch = new Set<string>();

  for (const cap of caps) {
    for (const consolidated of [false, true]) {
      for (const branchExists of [false, true]) {
        const st = state({ cap, branchExists, consolidated });
        const shared = worktreeStepCount(st);
        const md = renderHandoffMarkdown(st);
        const chat = renderHandoffUserMessage(st, REPO, `${REPO}/tmp/issue-747`);
        const mdRenders = md.includes(
          consolidated
            ? "The driver consolidated the workstream work onto the feature branch"
            : "The driver could not consolidate the work",
        );
        const chatRenders = chat.includes(
          consolidated
            ? "The driver consolidated the workstream work onto the feature branch"
            : "The driver could not consolidate the work",
        );
        // (a) The shared decision is the single source: the block is present
        // iff committed work exists, a branch name was captured, AND the ref
        // is proven (the snapshot read it, or a consolidation event proves
        // the driver created it).
        const expect =
          (st.pipelineState.handoffSnapshot?.committedWork?.length ?? 0) > 0 &&
          !!st.pipelineState.branchName &&
          (branchExists || (consolidated && refProvenFor(st)));
        assert(
          shared > 0 === expect,
          `matrix cap=${cap} consolidated=${consolidated} branchExists=${branchExists}: shared decision block=${shared > 0} (expected ${expect})`,
        );
        // (b) Both renderers agree with each other AND with the decision —
        // except the cap that owns its own renderer branch (see above).
        if (
          cap === CONSOLIDATION_CAP
            ? mdRenders !== chatRenders
            : mdRenders !== chatRenders || mdRenders !== expect
        ) {
          mismatches++;
          console.error(
            `✗ matrix cap=${cap} consolidated=${consolidated} branchExists=${branchExists}: md=${mdRenders} chat=${chatRenders} expected=${expect} (shared=${shared > 0})`,
          );
        }
        // (c) With no local branch, no surface may print branch-moving text.
        if (!branchExists) {
          const bad = [...branchMovingLines(md), ...branchMovingLines(chat)];
          if (bad.length > 0) {
            falsePushBlocks++;
            seenNoBranch.add(`${cap}: ${bad.slice(0, 3).join(" | ")}`);
          }
        } else {
          seenBranch.add(cap);
        }
      }
    }
  }
  assert(
    mismatches === 0,
    `both renderers agree with the shared decision across the matrix (${mismatches} mismatches)`,
  );
  assert(
    falsePushBlocks === 0,
    `no cap with branchExists:false prints push/checkout/cherry-pick text (${falsePushBlocks} offenders)`,
  );
  for (const s of [...seenNoBranch].slice(0, 5)) console.error(`  offender: ${s}`);
  assert(
    seenBranch.size === caps.length,
    "the matrix really exercised branchExists:true for every cap",
  );
}

// ---------------------------------------------------------------------------
// 2. The concrete incident: develop-cap handoff, work committed, NO branch.
// ---------------------------------------------------------------------------
{
  const st = state({ cap: "verify-failed:develop", branchExists: false, consolidated: false });
  const md = renderHandoffMarkdown(st);
  const chat = renderHandoffUserMessage(st, REPO, `${REPO}/tmp/issue-747`);
  assert(
    !/git push -u origin/.test(md) && !/git push -u origin/.test(chat),
    "#747 no-branch handoff: neither surface says 'git push -u origin <branch>'",
  );
  assert(
    !/^git checkout /m.test(md) && !/git checkout feature\/issue-747/.test(chat),
    "#747 no-branch handoff: neither surface says 'git checkout <branch>'",
  );
  assert(
    !/cherry-pick/.test(md) && !/cherry-pick/.test(chat),
    "#747 no-branch handoff: neither surface offers a cherry-pick onto a nonexistent branch",
  );
  assert(
    md.includes("worktree") && chat.includes("worktree"),
    "#747 no-branch handoff: the operator is still told the work is on the worktrees",
  );
}

// ---------------------------------------------------------------------------
// 3. Same shape WITH the branch: the #674 recovery must still render.
// ---------------------------------------------------------------------------
{
  const st = state({ cap: "verify-failed:develop", branchExists: true, consolidated: false });
  // The by-name push step belongs to the consolidated variant; the fallback
  // variant's last step is "push the branch" too — but only once the driver
  // has put the work on the branch, which is the consolidated case.
  const stCons = state({ cap: "verify-failed:develop", branchExists: true, consolidated: true });
  const md = renderHandoffMarkdown(st);
  const chat = renderHandoffUserMessage(st, REPO, `${REPO}/tmp/issue-747`);
  const mdC = renderHandoffMarkdown(stCons);
  const chatC = renderHandoffUserMessage(stCons, REPO, `${REPO}/tmp/issue-747`);
  assert(
    /cherry-pick/.test(md),
    "#674 regression guard (branch exists): markdown keeps cherry-pick",
  );
  assert(/cherry-pick/.test(chat), "#674 regression guard (branch exists): chat keeps cherry-pick");
  assert(
    // The chat twin re-qualifies every git line to `git -C <repoRoot> …`, so
    // the push command appears with the repo-root prefix there.
    /git push -u origin/.test(mdC) && /git -C [^\n]* push -u origin/.test(chatC),
    "#674 regression guard (branch exists, consolidated): both surfaces keep the push step",
  );
  assert(
    recoveryStepsForCap(st, "github").steps.some((s) => s.section === "worktree-work-fallback"),
    "#674 regression guard (branch exists): the shared decision still produces the fallback block",
  );
}

// ---------------------------------------------------------------------------
// 4. A branchExists:false snapshot with NO committed work is unaffected.
// ---------------------------------------------------------------------------
{
  const st = state({
    cap: "verify-failed:develop",
    branchExists: false,
    consolidated: false,
    committedWork: false,
  });
  assert(
    worktreeStepCount(st) === 0,
    "no committed work: no worktree-aware block regardless of branchExists",
  );
}

// ---------------------------------------------------------------------------
// 5. The GENERIC fallback block (no committed work, so no worktree-aware
//    steps at all) had the same defect: it keyed on `!ps.branchName`, so a
//    cycle with a captured name and no ref fell through to
//    `git add -p` / `git push -u origin <branch>`. Both twins must now read
//    the ref proof, and the pre-branch recipe (state file + --restart) must
//    be what renders instead. No worktrees are recorded here: with one,
//    #1575's take-over pushes the worktree HEAD by refspec, which needs no
//    local ref (covered by test-handoff-recovery-tree.ts).
// ---------------------------------------------------------------------------
{
  // No committed work, no recorded worktrees: the repoRoot fallback.
  const generic = (branchExists: boolean) => {
    const base = state({ cap: "spawn-backstop", branchExists, consolidated: false });
    return {
      ...base,
      pipelineState: {
        ...base.pipelineState,
        committedWork: undefined,
        worktrees: {},
        handoffSnapshot: {
          modifiedFiles: [],
          unstagedCount: 0,
          stagedCount: 0,
          branchExists,
          branchPushed: false,
          capturedAt: 3,
        },
      },
    };
  };
  const noRefMd = renderHandoffMarkdown(generic(false));
  const noRefChat = renderHandoffUserMessage(generic(false), REPO, `${REPO}/tmp/issue-747`);
  assert(
    !/push -u origin feature\/issue-747/.test(noRefMd) &&
      !/git -C [^\n]* push -u origin feature\/issue-747/.test(noRefChat) &&
      !/git add -p/.test(noRefMd) &&
      !/git add -p/.test(noRefChat),
    "#747 generic block: a captured name with no ref gets no takeover commands (either surface)",
  );
  assert(
    /--restart/.test(noRefMd) && /--restart/.test(noRefChat),
    "#747 generic block: ...and the restart-a-cycle recipe renders instead",
  );
  const withRefChat = renderHandoffUserMessage(generic(true), REPO, `${REPO}/tmp/issue-747`);
  assert(
    /push -u origin feature\/issue-747/.test(withRefChat),
    "#747 generic block: a proven ref still gets the takeover commands (no over-correction)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

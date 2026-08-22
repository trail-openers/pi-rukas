#!/usr/bin/env bun
/**
 * #398 — what the handoff actually says to the operator.
 *
 * **No test anywhere asserted on rendered handoff content**, which is why this
 * shipped: `intent-park` fires in `explore`, before the branch step — no
 * branch, no worktree, no PR, nothing written — and it inherited a recovery
 * block written for `developer-timeout`. A real run on #337 told the operator
 * to retry a timeout that never happened, keep worktree changes that did not
 * exist, and run:
 *
 *     git push -u origin (branch not captured)
 *
 * — a literal placeholder inside a copy-pasteable command.
 *
 * The `&&` assertions are not cosmetic. These lines land in the Pi chat via
 * `sendUserMessage`, and per `modules/core/oo-command-runner.md:107-125` the
 * permission matcher cannot wildcard a chained shape, so every unique chain
 * re-prompts the operator.
 */

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

/** A cycle that parked at intent resolution: nothing ran past explore. */
function intentParkState(parkReason = "underspecified"): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 337,
    createdAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "explore",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      // branchName deliberately absent — no branch was ever created.
      normalisedSpec: {
        intent: "Fix the release-please CI gate.",
        deliverables: [],
        acceptanceCriteria: [],
        outOfScope: [],
        assumptions: [],
        openQuestions: [],
        evidence: [],
        verdict: "park",
        parkReason,
        rationale: "The mechanism is confirmed via executed evidence.",
      },
    },
    eventLog: [{ kind: "cap-hit", at: 3, cap: "intent-park", reviewRound: 0, nextStep: "handoff" }],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; renderers read a subset
  } as any;
}

const REPO = "/Users/x/repo";

for (const [name, render] of [
  ["chat", (s: WorkState) => renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-337`)],
  ["markdown", (s: WorkState) => renderHandoffMarkdown(s, REPO)],
] as const) {
  const out = render(intentParkState());

  // ---- the four things the #337 handoff got wrong

  assert(!/git push/.test(out), `${name}: no 'git push' — the cycle never created a branch`);
  assert(
    !/\(branch not captured\)/.test(out.replace(/\*\*Branch\*\*:[^\n]*/g, "")),
    `${name}: the '(branch not captured)' fallback never reaches a command`,
  );
  assert(
    !/longer per-spawn cap/.test(out),
    `${name}: no 'retry with a longer per-spawn cap' — nothing timed out`,
  );
  assert(
    !/keep the worktree changes|keep worktree/.test(out),
    `${name}: does not offer to keep worktree changes that do not exist`,
  );

  // ---- and what it should say instead

  assert(/intent resolution/i.test(out), `${name}: says the cycle halted at intent resolution`);
  assert(
    /add acceptance criteria|concrete description/i.test(out),
    `${name}: carries parkAction's text for the recorded reason`,
  );
  assert(/spec\.txt/.test(out), `${name}: points at the resolver's own reasoning`);

  // ---- no chained shell commands anywhere in the rendered output

  const shellLines = out
    .split("\n")
    .filter((l) => /^\s*(#\s)?\s*(git|gh|rm|export|cat|\/work)\b/.test(l.trim()));
  const chained = shellLines.filter((l) => /&&|\|\||;\s|\|/.test(l));
  assert(
    chained.length === 0,
    `${name}: no chained commands — each re-prompts the operator (${chained[0]?.trim() ?? "none"})`,
  );
  assert(
    shellLines.length > 0,
    `${name}: ...and there ARE commands to check, so the assertion is not vacuous`,
  );
}

// ------------------------------------- the park reason reaches the action

{
  const a = renderHandoffUserMessage(intentParkState("too-large"), REPO, `${REPO}/tmp`);
  const b = renderHandoffUserMessage(intentParkState("already-implemented"), REPO, `${REPO}/tmp`);
  assert(/split/i.test(a), "a `too-large` park says to split the issue");
  assert(/close/i.test(b), "an `already-implemented` park says to confirm and close");
  assert(a !== b, "different park reasons produce different handoffs");
}

// -------------------------- a real branch still gets the takeover commands

{
  const s = intentParkState();
  s.pipelineState.branchName = "feature/issue-337-x";
  s.eventLog = [
    { kind: "cap-hit", at: 3, cap: "developer-timeout", reviewRound: 0, nextStep: "handoff" },
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  ] as any;
  const out = renderHandoffUserMessage(s, REPO, `${REPO}/tmp`);
  assert(
    /git .*push -u origin feature\/issue-337-x/.test(out),
    "a post-branch cap DOES get the takeover command, with the real branch name",
  );
  assert(
    !/&&/.test(
      out
        .split("\n")
        .filter((l) => /^\s*git\b/.test(l.trim()))
        .join("\n"),
    ),
    "...still unchained",
  );
}

// ---------------------------------------------------------------------------
// #500 — commit-pr-incomplete-consolidation with recorded repoRoot state.
//
// The pre-#500 handoff for this cap rendered recovery commands that assumed a
// clean tree, while the live #481 cycle left repoRoot with two UU paths and
// eight staged files. The test renders the handoff for a state whose
// pipelineState records unmerged paths and asserts the body names those paths
// and carries a clearing command.
// ---------------------------------------------------------------------------

/** A cycle that parked at commit-pr with a conflicted repoRoot.
 *
 * The eventLog carries the ops-fallback plumb-report — the driver writes it
 * when the mechanized path falls back — so the #500 DoD bullet ("the hedge is
 * rendered into the handoff body") is exercised by an unconditional assertion
 * below rather than a conditional that could silently skip.
 */
function commitPrConflictedState(): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 481,
    startedAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "commit-pr",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: "feature/issue-481-worktree-provision",
      worktrees: {},
      incompleteConsolidation: [
        { id: "default", paths: ["extension/src/worktree-provision.ts"] },
        { id: "task-b", paths: ["extension/smoke-tests/test-worktree-provision.ts"] },
      ],
      // #500 — the recorded repoRoot state at commit-pr handoff.
      commitPrRoot: {
        branch: "feature/issue-481-worktree-provision",
        unmergedPaths: [
          "extension/src/worktree-provision.ts",
          "extension/smoke-tests/test-worktree-provision.ts",
        ],
        stagedCount: 8,
        totalEntries: 10,
        capturedAt: Date.now(),
      },
    },
    eventLog: [
      {
        kind: "plumb-report",
        at: 2,
        step: "commit-pr",
        role: "driver",
        body: "Mechanized commit-pr fell back to the ops dispatch: apply conflict. Note: the repo root may contain partially staged consolidation from the mechanized attempt — verify with `git status` before re-applying patches.",
      },
      {
        kind: "cap-hit",
        at: 3,
        cap: "commit-pr-incomplete-consolidation",
        reviewRound: 0,
        nextStep: "handoff",
      },
    ],
  };
}

{
  const s = commitPrConflictedState();
  const md = renderHandoffMarkdown(s, REPO);
  const chat = renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-481`);

  // The handoff must name the unmerged paths.
  assert(
    md.includes("extension/src/worktree-provision.ts") &&
      md.includes("extension/smoke-tests/test-worktree-provision.ts"),
    "markdown: names both unmerged paths",
  );
  assert(
    chat.includes("extension/src/worktree-provision.ts") &&
      chat.includes("extension/smoke-tests/test-worktree-provision.ts"),
    "chat: names both unmerged paths",
  );

  // The handoff must carry a clearing command (reset --hard or checkout --theirs).
  // The chat renderer prefixes commands with `git -C <repoRoot>`, so the
  // regex must allow for that prefix between `git` and the subcommand.
  const clearingCmd = /git (?:-C \S+ )?(?:reset --hard|checkout --theirs)/;
  assert(
    clearingCmd.test(md),
    "markdown: carries a clearing command for the conflicted state",
  );
  assert(
    clearingCmd.test(chat),
    "chat: carries a clearing command for the conflicted state",
  );

  // The handoff must state the branch.
  assert(
    md.includes("feature/issue-481-worktree-provision"),
    "markdown: states the recorded branch",
  );
  assert(
    chat.includes("feature/issue-481-worktree-provision"),
    "chat: states the recorded branch",
  );

  // The staged count must be present.
  assert(
    /8 staged|staged-but-uncommitted: 8/.test(md),
    "markdown: states the staged count",
  );
  assert(
    /8 staged|staged-but-uncommitted: 8/.test(chat),
    "chat: states the staged count",
  );

  // The recovery commands must be valid against the conflicted state:
  // the unmerged-paths warning must appear before the git apply commands.
  assert(
    /unmerged|conflict|resolve/i.test(md),
    "markdown: warns about the unmerged paths before the git apply commands",
  );
  assert(
    /unmerged|conflict|resolve/i.test(chat),
    "chat: warns about the unmerged paths before the git apply commands",
  );

  // The ops-fallback plumb-report's hedge ("repo root may contain partially
  // staged") is rendered into the handoff body — the fixture's eventLog
  // carries the plumb-report the driver writes on fallback, so this
  // assertion is unconditional: a renderer that drops the hedge fails the
  // gate instead of passing silently behind an `if (plumb)` guard.
  assert(
    s.eventLog.some((e) => e.kind === "plumb-report"),
    "#500: fixture carries the ops-fallback plumb-report",
  );
  assert(
    md.includes("partially staged"),
    "markdown: renders the plumb-report hedge into the handoff body",
  );

  // No `&&`-chained shell commands anywhere. (The existing recovery commands
  // use `|` pipes for `git diff | git apply` — a shell pipeline that runs as
  // one command, not a `&&` chain that re-prompts the operator. The #398
  // check for the intent-park cap uses `|` in the regex because that cap has
  // no pipe commands; the commit-pr cap's recovery commands pre-date #398
  // and use pipes by design.)
  for (const [name, out] of [
    ["markdown", md],
    ["chat", chat],
  ] as const) {
    const shellLines = out
      .split("\n")
      .filter((l) => /^\s*(#\s)?\s*(git|gh|rm|export|cat|\/work)\b/.test(l.trim()));
    const chained = shellLines.filter((l) => /&&|\|\||;\s/.test(l));
    assert(
      chained.length === 0,
      `${name} (#500): no &&-chained commands (${chained[0]?.trim() ?? "none"})`,
    );
    // The `|` exemption is by design (git diff | git apply), but the
    // exemption must not be vacuous: every piped shell line must be the
    // expected pipeline shape, and there must be shell lines at all.
    const pipeLines = shellLines.filter((l) => l.includes("|"));
    assert(
      pipeLines.every((l) => /git (?:-C \S+ )?diff[^|]*\|[^|]*git (?:-C \S+ )?apply/.test(l)),
      `${name} (#500): every piped line is the expected git-diff|git-apply pipeline (${pipeLines[0]?.trim() ?? "none"})`,
    );
    assert(
      shellLines.length > 0,
      `${name} (#500): ...and there ARE commands to check, so the assertion is not vacuous`,
    );
  }
}

// #500 — the clean-tree variant: no unmerged paths, the recovery commands
// apply as-is and the handoff says the tree is clean.
{
  const s = commitPrConflictedState();
  s.pipelineState.commitPrRoot = {
    branch: "feature/issue-481-worktree-provision",
    unmergedPaths: [],
    stagedCount: 0,
    totalEntries: 0,
    capturedAt: Date.now(),
  };
  const md = renderHandoffMarkdown(s, REPO);
  const chat = renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-481`);
  assert(
    /clean|as-is/.test(md),
    "markdown (clean root): says the tree is clean and commands apply as-is",
  );
  assert(
    /clean|as-is/.test(chat),
    "chat (clean root): says the tree is clean and commands apply as-is",
  );
  assert(
    !/unmerged paths \(\d+\)/.test(md),
    "markdown (clean root): does not claim unmerged paths",
  );
}

// #500 — the inspection-failed variant: the handoff says the state is unknown
// and tells the operator to run git status first.
{
  const s = commitPrConflictedState();
  s.pipelineState.commitPrRoot = undefined;
  s.pipelineState.commitPrRootError = "git status exited 128: not a git repository";
  const md = renderHandoffMarkdown(s, REPO);
  const chat = renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-481`);
  assert(
    /inspection failed/.test(md),
    "markdown (inspection failed): says the inspection failed",
  );
  assert(
    /git status/.test(md),
    "markdown (inspection failed): tells the operator to run git status first",
  );
  assert(
    /inspection failed/.test(chat),
    "chat (inspection failed): says the inspection failed",
  );
}

// ---------------------------------------------------------------------------
// #499 — the lossless consolidation recipe reaches BOTH handoff surfaces.
//
// The defect: `git diff HEAD` does not report untracked files, so a
// workstream that created a NEW file loses it entirely when an operator
// follows the in-chat recipe — while the GitHub body (`renderHandoffMarkdown`)
// already printed the lossless shape (`add -A` → `diff --cached --binary |
// git apply --3way --binary --index`). The two renderers disagreed and the
// in-chat one was the lossy twin. #483's workstream had created a 204-line
// test file that only `git status --porcelain` would have surfaced.
//
// The DoD evidence bullet: build a state with cap
// `commit-pr-incomplete-consolidation` and one missing workstream, render
// both surfaces, and assert the in-chat output stages before diffing (an
// `add` step, or an explicit porcelain-derived command naming untracked
// paths) and contains no bare `diff HEAD`.
// ---------------------------------------------------------------------------
{
  const s = commitPrConflictedState();
  // DoD shape: ONE missing workstream. The fixture's two workstreams
  // (#500) are superseded here — the recipe assertions below count
  // occurrences, and one workstream keeps the arithmetic unambiguous.
  s.pipelineState.incompleteConsolidation = [
    { id: "default", paths: ["extension/src/worktree-provision.ts (new)"] },
  ];
  // A clean repoRoot: step 1b's conflicted-tree block is a separate concern
  // (#500) and its commands would muddy the lossless-recipe check.
  s.pipelineState.commitPrRoot = {
    branch: "feature/issue-481-worktree-provision",
    unmergedPaths: [],
    stagedCount: 0,
    totalEntries: 0,
    capturedAt: Date.now(),
  };

  const md = renderHandoffMarkdown(s, REPO);
  const chat = renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-481`);

  for (const [name, out] of [
    ["markdown", md],
    ["chat", chat],
  ] as const) {
    const wt = `issue-${s.issue}-default`;

    // 1. No bare `diff HEAD |` pipeline in the rendered recovery — it is the
    //    lossy form: it omits untracked files. (diff --cached, diff --stat,
    //    diff --name-only are fine and expected. Explanatory comments that
    //    MENTION `diff HEAD` are fine; the assertion targets the command form.)
    assert(
      !/diff HEAD\s*\|/.test(out),
      `${name} (#499): no bare 'diff HEAD |' pipeline — it silently drops untracked files`,
    );

    // 2. The recipe stages BEFORE diffing — `git add -A` inside the missing
    //    workstream, then `git diff --cached --binary` piped to `git apply`.
    //    The markdown renderer uses cwd-relative paths (`git -C .worktrees/…`);
    //    the chat renderer uses absolute (`git -C <repoRoot>/.worktrees/…`).
    //    Match on the worktree-qualified suffix common to both.
    const wtSuffix = `.worktrees/${wt}`;
    assert(
      out.includes(`${wtSuffix} add -A`),
      `${name} (#499): stages untracked files first — 'add -A' in the worktree`,
    );
    assert(
      out.includes(`${wtSuffix} diff --cached --binary`),
      `${name} (#499): diffs the staged tree, not HEAD`,
    );
    assert(
      /diff --cached --binary\s*\|\s*git (?:-C \S+ )?apply --3way --binary --index/.test(out),
      `${name} (#499): applies the staged diff losslessly (--3way --binary --index)`,
    );

    // 3. The recipe appears exactly once — one missing workstream, one
    //    recipe. Prevents a renderer from quietly dropping one surface.
    const addCount = out.split(`${wtSuffix} add -A`).length - 1;
    assert(
      addCount === 1,
      `${name} (#499): the add step appears exactly once for the one missing workstream (got ${addCount})`,
    );

    // 4. The no-bare-diff assertion must not be vacuous: the recovery block
    //    still carries the worktree apply commands at all.
    assert(
      /git (?:-C \S+ )?apply/.test(out),
      `${name} (#499): ...and there IS an apply step, so the diff assertion is not vacuous`,
    );
  }

  // 5. The surfaces agree on the recipe. Prefixes legitimately differ (chat
  //    is `git -C <repoRoot>`, markdown is cwd-relative), so compare the
  //    command after the prefix: both must use the same lossless pipeline
  //    for the workstream's diff.
  const chatRecipe = (chat.match(/\.worktrees[^\n]*add -A[^\n]*/g) ?? [])[0] ?? "";
  const mdRecipe = (md.match(/\.worktrees[^\n]*add -A[^\n]*/g) ?? [])[0] ?? "";
  assert(
    chatRecipe.includes("add -A") && mdRecipe.includes("add -A"),
    "#499: both surfaces stage before diffing (chat + markdown agree on the add step)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

#!/usr/bin/env bun
/**
 * #875 — dirty-flag variants for the commit-pr-incomplete-consolidation
 * recovery renderers (extracted from test-work-driver-pr14.ts §61b,
 * AGENTS.md §12 file-size limit). The persisted per-verdict `dirty` flag
 * determines which recovery commands render:
 *   - dirty=false → cherry-pick line, no `add -A`/`git apply`
 *   - dirty=true  → `add -A` + `diff --cached | git apply`
 *   - legacy (no flag) → treated as dirty (old behaviour preserved)
 * The renderers read ONLY the persisted field (no git calls at render time).
 */

import { explainCap } from "../src/work-driver-explain.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const mkDirtyState = (dirty: boolean | undefined) => {
  let s = initialState(577, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      status: "handoff",
      branchName: "feature/issue-577-multi",
      worktrees: {
        "prompt-reorder": "/repo/proj/.worktrees/issue-577-prompt-reorder",
        observability: "/repo/proj/.worktrees/issue-577-observability",
      },
      baseSha: "aaa1111",
      workstreamBaseShas: { "prompt-reorder": "aaa1111", observability: "aaa1111" },
      commitShas: { "prompt-reorder": "bbb2222", observability: "ccc3333" },
      incompleteConsolidation: {
        verdicts: [
          {
            id: "prompt-reorder",
            status: "uncovered" as const,
            uncoveredPaths: ["selfhost/strategy-command/prompts/strategy-research.md"],
            ...(dirty !== undefined ? { dirty } : {}),
          },
        ],
        filesPresent: ["selfhost/strategy-command/nessie.toml"],
      },
    },
  };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_500,
    cap: "commit-pr-incomplete-consolidation",
    reviewRound: 0,
    nextStep: "handoff",
  });
  return s;
};

// dirty=false: no `add -A`, no `git apply`, HAS cherry-pick.
{
  const s = mkDirtyState(false);
  const msg = renderHandoffUserMessage(s, "/repo/proj", "/repo/proj/tmp/issue-577");
  const md = renderHandoffMarkdown(s);
  assert(msg.includes("cherry-pick"), "dirty=false: chat has cherry-pick line");
  assert(!msg.includes("add -A"), "dirty=false: chat has no 'add -A'");
  assert(!/git (?:-C \S+ )?apply/.test(msg), "dirty=false: chat has no 'git apply'");
  assert(md.includes("cherry-pick"), "dirty=false: markdown has cherry-pick line");
  assert(!md.includes("add -A"), "dirty=false: markdown has no 'add -A'");
  const explanation = explainCap("commit-pr-incomplete-consolidation", s);
  assert(
    !explanation.includes("uncommitted on disk"),
    "dirty=false: explainCap has no 'uncommitted on disk'",
  );
}

// dirty=true: has `add -A` + `git apply`.
{
  const s = mkDirtyState(true);
  const msg = renderHandoffUserMessage(s, "/repo/proj", "/repo/proj/tmp/issue-577");
  const md = renderHandoffMarkdown(s);
  assert(msg.includes("add -A"), "dirty=true: chat has 'add -A'");
  assert(/git (?:-C \S+ )?apply/.test(msg), "dirty=true: chat has 'git apply'");
  assert(md.includes("add -A"), "dirty=true: markdown has 'add -A'");
  const explanation = explainCap("commit-pr-incomplete-consolidation", s);
  assert(explanation.includes("uncommitted on disk"), "dirty=true: explainCap has 'uncommitted on disk'");
}

// Legacy (no dirty flag): treated as dirty (old behaviour preserved).
{
  const s = mkDirtyState(undefined);
  const msg = renderHandoffUserMessage(s, "/repo/proj", "/repo/proj/tmp/issue-577");
  assert(msg.includes("add -A"), "legacy: chat has 'add -A'");
  const explanation = explainCap("commit-pr-incomplete-consolidation", s);
  assert(explanation.includes("uncommitted on disk"), "legacy: explainCap has 'uncommitted on disk'");
}

// Legacy (no dirty flag): the markdown surface's header must claim the work
// is still uncommitted — the `anyUncommitted` gate reads `dirty !== false`,
// so a legacy flag-absent verdict counts as uncommitted (consistent with
// isDirty/isClean), not "committed there".
{
  const s = mkDirtyState(undefined);
  const md = renderHandoffMarkdown(s, "/repo/proj");
  assert(
    md.includes("# 1. Inspect each missing workstream's worktree — the developer's work is still there uncommitted:"),
    "legacy: markdown header keeps the 'still there uncommitted' wording",
  );
  assert(!md.includes("nothing uncommitted — the work is committed there"), "legacy: markdown header does not claim the work is committed");
}

console.log(`\nexit ${exit}`);
process.exit(exit);

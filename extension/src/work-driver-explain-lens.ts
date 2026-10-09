/**
 * work-driver-explain-lens — cap-hit explanations for the lens family
 * (lens-diff-unreadable, lens-fix-not-integrated). Split from
 * work-driver-explain.ts so that file sits under the 500-line cap with
 * headroom for new caps; the content here is the verbatim former case
 * bodies of work-driver-explain.ts.
 */

import { inlineCodeSafe } from "./work-driver-conflict-evidence.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/**
 * Explains the lens family of caps (`lens-diff-unreadable`,
 * `lens-fix-not-integrated`); the dispatch is exhaustive, so an unknown
 * cap can never land here.
 */
export function explainLens(cap: Cap, state: WorkState): string {
  switch (cap) {
    case "lens-diff-unreadable": {
      const why = state.pipelineState.lensDiffError ?? "(no detail recorded)";
      return `The six-pass code review could not read the diff it is supposed to review: ${why}. The driver halted rather than approving. Before #384 an unreadable diff returned empty, and the empty-diff guard treated empty as approved — so a stale ref or a transient git error merged code that nothing had reviewed. Check that the branch is pushed and \`origin\` is current (\`git fetch origin --prune\`), then re-run.`;
    }
    case "lens-fix-not-integrated": {
      // #492 — the cap-hit itself carries the cause and the git evidence
      // that establishes it, plus the worktree the driver inspected. Read
      // the latest such cap from the log; an absent detail (pre-#492 state
      // files) falls back to naming the worktree from the recorded map.
      const hit = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "cap-hit" }> =>
            e.kind === "cap-hit" && e.cap === "lens-fix-not-integrated",
        );
      const worktree = hit?.lensWorktreePath ?? state.pipelineState.worktrees?.default;
      const cause =
        hit?.evidence ??
        (hit
          ? "(no git evidence recorded — this cycle predates #492's cause classification)"
          : "(no lens-fix-not-integrated cap recorded in the event log)");
      const where = worktree
        ? `The worktree inspected was \`${worktree}\` (\`git -C ${worktree} status\`).`
        : "The inspected worktree path was not recorded.";
      // #797 — the repoRoot condition is stated in the handoff body itself,
      // not only in the evidence. The operator following the recovery steps
      // must know whether repoRoot is usable before running anything there;
      // a pre-#797 cap (no `restoredToRef`, no restore claim in the
      // evidence) gets the honest "not recorded" sentence rather than a
      // fabricated clean state.
      const ref = hit?.restoredToRef;
      const notRestored = cause.includes("repoRoot was NOT restored");
      const rootCondition = notRestored
        ? `⚠ repoRoot was NOT restored — it requires manual repair before any further /work cycle: run \`git status\` and \`git branch --show-current\` in the repository root, then \`git reset --hard\` and \`git checkout --force\` to the ref the cycle started from (${ref ?? "see the event-log evidence"}). The preserved state (if any) is named in the evidence above.`
        : ref
          ? `repoRoot was restored to ${ref} (verified) — the repository root is usable again; run \`git status\` and \`git symbolic-ref --short HEAD\` there to confirm (it must show ${ref} and an empty porcelain).`
          : `the repoRoot condition was not recorded (this cycle predates #797) — run \`git status\` in the repository root before re-running; a dirty root will abort the next cycle's branch step.`;
      return `the lens-fix round did not reach the branch — ${cause}. ${where} ${rootCondition} The cycle halted rather than reviewing again, because the next round would have re-read an unchanged branch and re-reported the identical findings until the round cap fired, which is what burned whole review budgets on already-solved defects. If the fix is still on disk, commit and push it there and re-run; if nothing exists, the findings were likely false positives and should be adjudicated before re-running`;
    }
    case "lens-fix-reposition": {
      // #981 — the round-2 reposition guard refused to dispatch the fixer
      // onto a base it could not verify: a dirty worktree, round-1 work that
      // never landed on the branch, or a worktree that diverged from the
      // branch tip. The kind + git detail ride on the cap's evidence; a
      // backup ref (unlanded / diverged / git-failed) rides on
      // `restoredToRef` — a `git-failed` result (e.g. the cherry path made
      // a backup ref, then the checkout failed) keeps it too, because it is
      // the only way to recover the tree.
      const hit = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "cap-hit" }> =>
            e.kind === "cap-hit" && e.cap === "lens-fix-reposition",
        );
      const worktree = hit?.lensWorktreePath ?? state.pipelineState.worktrees?.default;
      const cause = hit?.evidence ?? "(no detail recorded)";
      // #981 — the worktree path is interpolated into a backtick code span
      // below; a backtick or newline in it would break the span, so it is
      // sanitised via inlineCodeSafe (the worktree path is untrusted data).
      const safeWorktree = worktree ? inlineCodeSafe(worktree) : undefined;
      const where = safeWorktree
        ? `The worktree inspected was \`${safeWorktree}\` (\`git -C ${safeWorktree} status\`).`
        : "The inspected worktree path was not recorded.";
      const ref = hit?.restoredToRef;
      const backup = ref
        ? ` The worktree's pre-move state is preserved at ref \`${ref}\` (\`git show ${ref}\`) — nothing was discarded; if the park was a \`git-failed\` (e.g. the backup succeeded but the checkout that followed did not), restore the tree from it with \`git checkout ${ref}\` before re-running.`
        : "";
      return `the lens-fix reposition guard could not establish the correct base for the next round: ${cause}. ${where}${backup} The cycle halted rather than dispatching a fix onto a stale or diverged worktree, because a fix built there would not integrate cleanly (the #978 shape: round 2 built on the old base while the branch advanced by round 1). Inspect the worktree and the evidence above — commit or clean uncommitted work, land the missing commit on the branch, or restore from the backup ref — then re-run the cycle`;
    }
    default:
      return `unhandled lens cap: ${cap}`;
  }
}

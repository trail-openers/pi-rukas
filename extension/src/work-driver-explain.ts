/**
 * work-driver-explain — cap-hit → operator-readable sentence.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Pure
 * formatter with no DriverContext dependency — single source of truth
 * for the WHY explanation used by every handoff surface (in-chat
 * sendUserMessage via work-driver-handoff-message.ts, /work-status
 * terminal renderer, GitHub body via work-driver-handoff-markdown.ts).
 */

import { MAX_CI_RETRIES, MAX_REVIEW_ROUNDS } from "./work-driver-context.ts";
import { type ParkReason, explainPark } from "./work-driver-intent.ts";
import { explainMergeHold } from "./work-driver-merge-authority.ts";
import type { WorkEvent, WorkState, WorkStep } from "./workflow-state.ts";

/**
 * PR5 — single source of truth mapping a cap-hit `cap` value to an
 * operator-readable sentence. Used by every handoff surface (in-chat
 * sendUserMessage, /work-status terminal renderer, GitHub
 * renderHandoffMarkdown) so the WHY explanation stays consistent.
 *
 * Exhaustive switch — adding a new cap value to the WorkEvent union
 * forces a typecheck error here, which is the design intent.
 */
export function explainCap(
  cap: Extract<WorkEvent, { kind: "cap-hit" }>["cap"] | undefined,
  state: WorkState,
): string {
  // An absent cap is a real state — a cycle can reach handoff without one — and
  // this used to throw on `cap.startsWith`, so the four renderers all defaulted
  // to "adversarial-loop" rather than risk it. That default is what told the
  // operator the adversarial gate had failed in 23 of 53 handoffs, 14 of which
  // died at lens-review with adversarial approving every round. Saying nothing
  // was recorded is honest; naming a gate that passed is not.
  if (!cap) {
    return "the cycle halted without recording which gate stopped it — check the event log directly";
  }
  const snap = state.pipelineState.handoffSnapshot;
  const fileCount = snap ? snap.unstagedCount + snap.stagedCount : undefined;
  const fileBlurb =
    fileCount !== undefined ? `${fileCount} file(s) modified-but-uncommitted` : "uncommitted work";
  switch (cap) {
    case "adversarial-loop":
      return "adversarial gate ran its 3-round internal loop and could not reach APPROVED — the diff still has issues the adversarial-developer flagged";
    case "round-cap":
      return `lens-review hit its ${MAX_REVIEW_ROUNDS}-round cap with findings still open — the lens reviewers and the developer's fixes did not converge`;
    case "wall-clock":
      return "lens-review fix loop exceeded its 90-minute wall-clock cap — total time spent in review/fix iterations is past the budget";
    case "review-incomplete":
      return "at least one lens failed every retry, so the six-pass review is incomplete — the diff was not fully reviewed, which is not the same as being rejected";
    case "ci-retry":
      return `CI failed ${MAX_CI_RETRIES} times in a row (each retry re-entered develop → adversarial → lens-review → ci) — CI is permanently broken for this branch, or the develop step keeps producing the same failure`;
    case "developer-timeout":
      return `developer subagent hit the wall-clock backstop (PI_ENSEMBLE_SPAWN_TIMEOUT_MS, default 2 h) with ${fileBlurb} in the worktree — that backstop only catches runaway loops, so reaching it means the work needs different decomposition (split the issue into smaller workstreams) or manual takeover`;
    case "explore-already-complete":
      return "explore concluded this issue is already done (e.g., satisfied by a prior PR or merged earlier). The driver halted before branch/develop ran — no code was written. Close the issue if you agree, or re-run /work with additional context if you believe there IS work to do";
    case "intent-park": {
      const spec = state.pipelineState.normalisedSpec;
      const reason = (spec?.parkReason ?? "underspecified") as ParkReason;
      const why = explainPark(reason, state.issue);
      const contradictions = (spec?.evidence ?? []).filter((e) => e.verdict === "contradicted");
      const evidence =
        contradictions.length > 0
          ? `\n\nContradicting evidence:\n${contradictions.map((e) => `  - ${e.claim}${e.source ? ` (${e.source})` : ""}`).join("\n")}`
          : "";
      const rationale = spec?.rationale ? `\n\nResolver's rationale: ${spec.rationale}` : "";
      return `${why} No code was written — the driver halted at intent resolution, before plan or branch ran.${evidence}${rationale}`;
    }
    case "lens-diff-unreadable": {
      const why = state.pipelineState.lensDiffError ?? "(no detail recorded)";
      return `The six-pass code review could not read the diff it is supposed to review: ${why}. The driver halted rather than approving. Before #384 an unreadable diff returned empty, and the empty-diff guard treated empty as approved — so a stale ref or a transient git error merged code that nothing had reviewed. Check that the branch is pushed and \`origin\` is current (\`git fetch origin --prune\`), then re-run.`;
    }
    case "adversarial-infra-failure": {
      const out = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "adversarial-workstream-outcome" }> =>
            e.kind === "adversarial-workstream-outcome" &&
            (e.outcome === "infra-failure" || e.outcome === "dispatch-failed"),
        );
      const which = out ? `workstream ${out.workstreamId}` : "a workstream";
      return `${which}'s adversarial loop failed on infrastructure and stayed failed after a retry with the provider-stated backoff — NO verdict exists for it, and that is not a review rejection. The other workstreams' completed reviews are preserved in the state file (adversarial-workstream-outcome events); recover by re-running /work, which re-enters the adversarial step and re-runs ONLY the workstream(s) that never produced a verdict`;
    }
    case "awaiting-human-merge": {
      const hold = state.pipelineState.mergeHold;
      const pr = state.pipelineState.prNumber;
      const base = explainMergeHold(
        {
          granted: hold?.authorityGranted ?? false,
          source: hold?.authoritySource ?? "none",
          ...(hold?.authorityQuote ? { quote: hold.authorityQuote } : {}),
        },
        hold?.evidenceReason
          ? { ok: false, reason: hold.evidenceReason, failing: [], inconclusive: [] }
          : undefined,
        pr,
      );
      const skipped =
        hold?.inconclusive && hold.inconclusive.length > 0
          ? `\n\nRequired checks reporting \`skipped\`/\`neutral\`: ${hold.inconclusive.join(", ")}. GitHub counts those as success; this driver does not, because a required workflow that can be skipped is a gate that cannot fail.`
          : "";
      return `${base}${skipped} All the work is done and pushed — only the merge is held.`;
    }
    case "existing-pr-detected": {
      const pr = state.pipelineState.existingPr;
      const via =
        pr?.matchedBy === "branch"
          ? `its head branch \`${pr.headRefName}\` names the issue`
          : "its body carries a closing keyword for the issue";
      return `PR #${pr?.number ?? "(unknown)"} is already open for this issue — ${via}. The driver halted at the branch step BEFORE any dispatch, so no tokens were spent and nothing was written. \`--restart\` wipes the driver's state file but not GitHub, which is how issue #5 got rebuilt from scratch and shipped as a duplicate (#358 left orphaned by #359). Decide whether to resume that PR's branch, close it, or retarget it — the driver will not attach new commits to a PR whose head is a different branch`;
    }
    case "explore-needs-clarification":
      return "explore could not determine concrete work to do — the issue may be ambiguous, missing acceptance criteria, or contradictory. The driver halted before plan ran. Clarify the issue body and re-run /work";
    case "explore-bodies-empty": {
      const failed = state.pipelineState.emptyBodyIssues ?? [];
      const which =
        failed.length > 0 ? failed.map((f) => `#${f.issue}`).join(", ") : "one or more issues";
      return `\`gh issue view\` returned empty/error for ${which} on every attempt (the fetch is retried with backoff, so a one-off blip is already ruled out) — the driver cannot reliably classify work that hasn't been read. Most likely causes: gh version with projectCards GraphQL deprecation, gh extension hijacking stdout, expired auth (\`gh auth status\`), or a persistent network fault. Fix the gh setup and re-run /work; the body fetch is a load-bearing pre-condition`;
    }
    case "step-back-revise-spec": {
      const sb = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "step-back-completed" }> =>
            e.kind === "step-back-completed",
        );
      const elem = sb?.sddElement ?? "(spec element not specified)";
      return `explore stepped back and identified a spec-level gap in **${elem}** — the lens-review fix loop kept flagging the same shape across rounds (MAST 41.77% — spec-level problem fingerprint). The handoff body includes a proposed revision. After updating the issue (via /plan or \`gh issue edit\`), re-run with \`/work N --restart\` to start a fresh cycle against the revised spec`;
    }
    case "integration-verify-failed":
      return "the consolidated tree failed the project's verify command, so nothing was pushed. Each workstream passed its own develop gate in its own worktree; the combination does not build — which is a defect integration CREATED, and the only place it can be caught. The failing output is in the plumb-report above. Recover by fixing the interaction (typically one workstream renamed or moved something another still refers to) and re-running";
    case "lens-fix-not-integrated":
      return "the lens-fix round did not reach the branch — either the integration failed or the fixer wrote nothing — so the cycle halted rather than reviewing again. The next round would have re-read an unchanged branch and re-reported the identical findings until the round cap fired, which is what burned whole review budgets on already-solved defects. The git detail is in the plumb-report above; the fix may still be sitting uncommitted in the worktree, so check `git -C .worktrees/... status` before re-running";
    case "commit-pr-incomplete-consolidation": {
      const missing = state.pipelineState.incompleteConsolidation ?? [];
      const which =
        missing.length > 0 ? missing.map((m) => m.id).join(", ") : "one or more workstreams";
      return `commit-pr's post-dispatch consolidation gate detected that the committed diff is missing files from these workstreams: ${which}. Ops committed a partial slice — the developers' work in the missing worktrees is uncommitted on disk. Pre-PR14 this would have merged silently (v0.12.13 /work 577 closed an issue with 1 of 3 workstreams' changes shipped). The driver halted before merge; recover by collecting the missing diffs from \`.worktrees/issue-N-<id>\` and re-running, or take over the integration manually`;
    }
  }
  // PR17 — `verify-failed:<step>`: the driver-side outcome gate found
  // the step's claimed result isn't backed by executed evidence. The
  // per-check findings live in pipelineState.verifyEvidence.
  if (cap.startsWith("verify-failed:")) {
    const step = cap.slice("verify-failed:".length);
    const evidence = state.pipelineState.verifyEvidence;
    const findings =
      evidence && evidence.failures.length > 0
        ? `\n${evidence.failures.map((f) => `  - ${f}`).join("\n")}`
        : " (evidence detail missing from state)";
    return `the driver's outcome-verification gate rejected the ${step} step's "done" claim — the claimed result is not backed by executed evidence:${findings}\nNo LLM judged this; the driver ran the checks itself (git diff/rev-list, the project's verify command, gh pr view). Inspect the worktree(s), fix or re-dispatch, and re-run. Set PI_ENSEMBLE_VERIFY=0 to disable the gate (not recommended)`;
  }
  // Template-literal `step-failed:<step>` values land here. Switch on the
  // step suffix to produce a tailored sentence.
  if (cap.startsWith("step-failed:")) {
    const step = cap.slice("step-failed:".length) as WorkStep;
    // PR7 — for multi-workstream halts (PR3 fanout steps: develop +
    // lens-review), append a parenthetical with the per-branch verdict
    // count. The branches-converged event already carries the granular
    // verdicts; explainCap surfaces the count so the operator can tell
    // "all 3 branches failed" from "1 of 3 failed" without reading the
    // event log.
    const lastConverged = [...state.eventLog]
      .reverse()
      .find(
        (e): e is Extract<WorkEvent, { kind: "branches-converged" }> =>
          e.kind === "branches-converged" && e.step === step,
      );
    const fanoutTag = lastConverged
      ? ` (${lastConverged.verdicts.filter((v) => !v.ok).length}/${lastConverged.verdicts.length} workstream branches failed)`
      : "";
    switch (step) {
      case "explore":
        return "the explore step dispatch failed before producing a usable spec — cycle cannot continue without recon context";
      case "plan":
        return "the plan step dispatch failed before decomposing the issue into workstreams — cycle would silently regress to single-task develop without out-of-scope fences";
      case "branch":
        return "the branch step dispatch failed before creating the feature branch — develop would edit HEAD (likely main), commit-pr has nothing to push, CI has nothing to watch";
      case "develop":
        return `the develop step dispatch failed with ${fileBlurb} on disk${fanoutTag} — adversarial review of partial work is not meaningful, halting cleanly`;
      case "adversarial":
        return "the adversarial gate dispatch failed twice (retry exhausted) — cannot commit code that has not passed the adversarial gate";
      case "commit-pr":
        return "the commit-pr step dispatch failed before pushing the PR — lens-review of uncommitted work would waste hours, CI has nothing to watch";
      case "lens-review":
        return `the lens-review dispatch failed twice (retry exhausted)${fanoutTag} — cannot ship code that has not passed the six-pass review`;
      case "lens-fix":
        return "the lens-fix step dispatch failed mid-fix — re-running adversarial on a partial fix is not meaningful";
      case "ci":
        return "the CI monitoring step dispatch failed — cannot mark a cycle merged without confirming CI passed";
      case "merged":
        // PR10 — merged step is now HALT. The `gh pr merge` invocation
        // (mechanized or LLM fallback) can fail on auth, branch
        // protection, conflicts, or a missing required review.
        return "the merge step failed — the PR was approved and CI passed, but `gh pr merge` did not succeed (auth / branch protection / conflicts / missing required review). Merge manually via `gh pr merge <PR-N> --squash --delete-branch` (check `gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed` for allowed methods)";
      case "step-back":
      case "handoff":
        // These remain DEGRADED_OK in STEP_FAILURE_POLICY and should never
        // produce a step-failed:<step> cap. Render generic if it ever happens.
        return `step "${step}" failed unexpectedly — see state-file event log`;
    }
  }
  // Should be unreachable when the WorkEvent union is exhaustively
  // covered above; if we land here, surface the raw cap so the user
  // can still grep the state file.
  return `step failed: ${String(cap)} — see state-file event log`;
}

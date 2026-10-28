/**
 * work-driver-explain-step-failed — the `step-failed:<step>` template family,
 * split out of work-driver-explain.ts so that file stays under the AGENTS.md
 * §12 size cap. Same shape as every sibling `work-driver-explain-*.ts`: one
 * cap family, one pure formatter. Every sentence is verbatim from the split.
 */

import { developVerdictLines } from "./work-develop-verdict-source.ts";
import { adversarialFailureCause } from "./work-driver-explain-other.ts";
import type { WorkEvent, WorkState, WorkStep } from "./workflow-state.ts";

/** Tailored sentence for `step-failed:<step>`; `fileBlurb` names what is on disk. */
export function explainStepFailed(step: WorkStep, state: WorkState, fileBlurb: string): string {
  // Template-literal values land here; switch on the step suffix for a tailored
  // sentence.
  // PR7 — for multi-workstream halts (PR3 fanout steps: develop +
  // lens-review), append a parenthetical with the per-branch verdict
  // count. The branches-converged event already carries the granular
  // verdicts; explainCap surfaces the count so the operator can tell
  // "all 3 branches failed" from "1 of 3 failed" without reading the
  // event log.
  // The develop count must agree with the handoff's verdict section, so it
  // comes from the same shared source; other steps keep their own converged event.
  const developLines = step === "develop" ? developVerdictLines(state) : undefined;
  const lastConverged =
    developLines === undefined
      ? [...state.eventLog]
          .reverse()
          .find(
            (e): e is Extract<WorkEvent, { kind: "branches-converged" }> =>
              e.kind === "branches-converged" && e.step === step,
          )
      : undefined;
  const fanoutTag = developLines
    ? developLines.length > 0
      ? ` (${developLines.filter((v) => !v.ok).length}/${developLines.length} workstream branches failed)`
      : ""
    : lastConverged
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
    case "adversarial": {
      // #79 — name the endpoint's fault, not the driver's retry budget: a
      // quota window or a missing model is not retried at all.
      const cause = adversarialFailureCause(state);
      return `the adversarial gate produced no verdict${cause ? ` — reviewer unavailable: ${cause}` : " (dispatch failed, retry exhausted)"} — cannot commit code that has not passed the adversarial gate`;
    }
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
      // protection, conflicts, or a missing required review. Authority and
      // the evidence gate already PASSED before this attempt — this is a
      // hard failure of the merge itself, a distinct cap from
      // `awaiting-human-merge`. A re-run would just hit the same wall,
      // so `gh pr merge` by hand is the only recovery here — the
      // exception, not the project's normal path.
      return "the merge step failed — authority was granted and CI passed, but `gh pr merge` itself did not succeed (auth / branch protection / conflicts / missing required review). This cap means the merge ATTEMPT failed, not that the project denies agents — a re-run would hit the same wall, so remove the blocking cause and merge once with `gh pr merge <PR-N> --squash --delete-branch` (check `gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed` for allowed methods)";
    case "step-back":
    case "handoff":
      // These remain DEGRADED_OK in STEP_FAILURE_POLICY and should never
      // produce a step-failed:<step> cap. Render generic if it ever happens.
      return `step "${step}" failed unexpectedly — see state-file event log`;
  }
}

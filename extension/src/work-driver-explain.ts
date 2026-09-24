/**
 * work-driver-explain — cap-hit → operator-readable sentence.
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Pure
 * formatter with no DriverContext dependency — single source of truth
 * for the WHY explanation used by every handoff surface.
 */

import { commitPrRootBlurb } from "./work-driver-commit-inspect.ts";
import { MAX_CI_RETRIES, MAX_REVIEW_ROUNDS } from "./work-driver-context.ts";
import { explainConsolidation } from "./work-driver-explain-consolidation.ts";
import { explainDetectCaps } from "./work-driver-explain-detect-caps.ts";
import { explainLens } from "./work-driver-explain-lens.ts";
import { explainOther } from "./work-driver-explain-other.ts";
import { explainPrSteps } from "./work-driver-explain-pr-steps.ts";
import { explainReview } from "./work-driver-explain-review.ts";
import { type ParkReason, explainPark } from "./work-driver-intent.ts";
import { explainMergeHold } from "./work-driver-merge-authority.ts";
import { lastCapHit } from "./workflow-state-cap.ts";
import {
  type WorkEvent,
  type WorkState,
  type WorkStep,
  filesPresentFromConsolidation,
  missingWorkstreamsFromConsolidation,
} from "./workflow-state.ts";

/**
 * PR5 — single source of truth mapping a cap-hit `cap` value to an
 * operator-readable sentence. Used by every handoff surface so the
 * WHY explanation stays consistent.
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
    case "loop-detected":
      return explainDetectCaps(cap, state);
    case "token-budget":
      return explainDetectCaps(cap, state);
    case "plan-timeout":
      // #754 — the plan step's own bound: the kill-cause family module owns
      // the sentence (it reads the kill event's usage off the log).
      return explainDetectCaps(cap, state);
    case "repeat-finding-seam": {
      // #280 §B — same finding shape across ≥3 files is a missing-seam
      // signal, not N independent defects. Patching each instance would
      // entrench the duplication; explore is dispatched to analyse which
      // spec element under-specifies the shared behaviour.
      const hit = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "cap-hit" }> =>
            e.kind === "cap-hit" && e.cap === "repeat-finding-seam",
        );
      const evidence =
        hit?.evidence ?? "the lens found the same finding shape across multiple files";
      return `lens-review round 1 flagged a repeating-seam pattern: ${evidence}. This is a missing-seam signal, not N independent defects. The driver dispatched @explore to analyse which spec element (outcomes / scope boundaries / constraints / prior decisions / task breakdown / verification criteria) under-specifies the shared behaviour. Patching each instance would entrench the duplication rather than surface the root cause. Review explore's SDD analysis and revise the issue before re-running /work`;
    }
    case "explore-already-complete":
      return "explore concluded this issue is already done (e.g., satisfied by a prior PR or merged earlier). The driver halted before branch/develop ran — no code was written. Close the issue if you agree, or re-run /work with additional context if you believe there IS work to do";
    case "develop-incomplete-deliverables": {
      // #741 — the converge gate: the verify gate passed (the code builds),
      // but one or more plan deliverables are absent from the end-of-develop
      // diff. The missing deliverables ride on the cap event's evidence.
      const hit = lastCapHit(state, "develop-incomplete-deliverables");
      const evidence =
        (hit && "evidence" in hit ? hit.evidence : undefined) ?? "(no detail recorded)";
      const partials = (state.pipelineState.convergeEvidence?.deliverables ?? [])
        .filter((d) => d.status === "partial")
        .map((d) => `${d.id} (${d.reason})`);
      const noDiff = (state.pipelineState.convergeEvidence?.deliverables ?? [])
        .filter((d) => d.status === "no-diff")
        .map((d) => `${d.id} (${d.reason})`);
      const partialWarning =
        partials.length > 0
          ? `\n\nPartial deliverables (warning, non-blocking):\n${partials.map((p) => `  - ${p}`).join("\n")}`
          : "";
      const noDiffWarning =
        noDiff.length > 0
          ? `\n\nNo-diff deliverables (not blocking — no diff by design):\n${noDiff.map((p) => `  - ${p}`).join("\n")}`
          : "";
      return `the converge gate found the end-of-develop diff INCOMPLETE: ${evidence}. The verify gate passed — the code builds and tests; what is missing is declared plan work the diff never contained. The driver already spent its one-shot corrective re-dispatch on these deliverables; re-running /work re-enters the gate with a fresh corrective budget, or implement the missing deliverables on the branch directly.${partialWarning}${noDiffWarning}`;
    }
    case "intent-park":
      return explainPrSteps(cap, state);
    case "lens-diff-unreadable":
      return explainLens(cap, state);
    case "adversarial-infra-failure":
      return explainOther(cap, state);
    case "awaiting-human-merge": {
      const hold = state.pipelineState.mergeHold;
      const pr = state.pipelineState.prNumber;
      const base = explainMergeHold(
        {
          granted: hold?.authorityGranted ?? false,
          source: hold?.authoritySource ?? "none",
          ...(hold?.authorityQuote ? { quote: hold.authorityQuote } : {}),
        },
        hold?.evidenceReason || hold?.evidenceFailureKind
          ? {
              ok: false,
              reason: hold?.evidenceReason,
              failing: [],
              inconclusive: [],
              ...(hold.evidenceFailureKind ? { failureKind: hold.evidenceFailureKind } : {}),
            }
          : undefined,
        pr,
      );
      const skipped =
        hold?.inconclusive && hold.inconclusive.length > 0
          ? `\n\nRequired checks reporting \`skipped\`/\`neutral\`: ${hold.inconclusive.join(", ")}. GitHub counts those as success; this driver does not, because a required workflow that can be skipped is a gate that cannot fail.`
          : "";
      return `${base}${skipped} All the work is done and pushed — only the merge is held.`;
    }
    case "repo-root-residue": {
      const hit = lastCapHit(state, "repo-root-residue");
      const paths = hit?.evidence ?? "(no detail recorded)";
      return `the branch step found uncommitted work at the repo root BEFORE any development dispatch: ${paths}. This is residue from a previous cycle or the operator's own in-progress work — NOT a defect in this cycle's diff. The driver preserved it (nothing was deleted or stashed) and halted before paying for a develop dispatch that would only fail at the verification gate roughly 50 minutes later. Inspect the paths (\`git status\` at the repo root), clear them (commit, move, or add to .gitignore), and re-run the cycle.`;
    }
    case "cross-group-conflict": {
      const hit = lastCapHit(state, "cross-group-conflict");
      const ev = hit?.evidence ?? "";
      const siblingMatch = ev.match(/issue #(\d+)/);
      const siblingIssue = siblingMatch ? siblingMatch[1] : "(see evidence)";
      return `this cycle's declared paths overlap with issue #${siblingIssue}'s active claim — two cycles cannot edit the same files in parallel. The overlapping paths are in the event log evidence field. Coordinate with the other cycle's owner or re-plan with disjoint file sets.`;
    }
    case "existing-pr-detected": {
      const pr = state.pipelineState.existingPr;
      const via =
        pr?.matchedBy === "branch"
          ? `its head branch \`${pr.headRefName}\` names the issue`
          : "its body carries a closing keyword for the issue";
      return `PR #${pr?.number ?? "(unknown)"} is already open for this issue — ${via}. The driver halted at the branch step BEFORE any dispatch, so no tokens were spent and nothing was written. \`--restart\` wipes the driver's state file but not GitHub, which is how issue #5 got rebuilt from scratch and shipped as a duplicate (#358 left orphaned by #359). Decide whether to resume that PR's branch, close it, or retarget it — the driver will not attach new commits to a PR whose head is a different branch`;
    }
    case "explore-needs-clarification": {
      // #830 — when the driver recorded WHY (the no-signal branch now carries
      // `evidence: "no verdict and no spec parsed"`), name it. The generic
      // sentence stays as the fallback for caps fired before the field existed
      // or by a path that did not set it.
      const hit = lastCapHit(state, "explore-needs-clarification");
      const evidence = hit?.evidence;
      const why = evidence
        ? `the driver recorded: ${evidence} — the reply did not contain a verdict the driver could route on, nor a spec section it could extract`
        : "the issue may be ambiguous, missing acceptance criteria, or contradictory";
      return `explore could not determine concrete work to do — ${why}. The driver halted before plan ran. Clarify the issue body (or fix the reply shape) and re-run /work`;
    }
    case "explore-bodies-empty": {
      const failed = state.pipelineState.emptyBodyIssues ?? [];
      const which =
        failed.length > 0 ? failed.map((f) => `#${f.issue}`).join(", ") : "one or more issues";
      return `\`gh issue view\` returned empty/error for ${which} on every attempt (the fetch is retried with backoff, so a one-off blip is already ruled out) — the driver cannot reliably classify work that hasn't been read. Most likely causes: gh version with projectCards GraphQL deprecation, gh extension hijacking stdout, expired auth (\`gh auth status\`), or a persistent network fault. Fix the gh setup and re-run /work; the body fetch is a load-bearing pre-condition`;
    }
    case "step-back-revise-spec":
      return explainOther(cap, state);
    case "commit-pr-incomplete-consolidation": {
      const missing = missingWorkstreamsFromConsolidation(
        state.pipelineState.incompleteConsolidation,
      );
      const which =
        missing.length > 0
          ? missing.map((m: { id: string }) => m.id).join(", ")
          : "one or more workstreams";
      // #540 — the PRESENT side of the verdict: what the committed diff
      // actually contains, so the operator can tell a true partial commit
      // (files present, one workstream's slice absent) from a hollow
      // commit (an empty committed diff). Absent on pre-#540 state files
      // (the field was a bare array then) — say nothing rather than
      // render a hollow list.
      const filesPresent = filesPresentFromConsolidation(
        state.pipelineState.incompleteConsolidation,
      );
      const presentBlurb =
        filesPresent.length > 0
          ? ` The committed diff contains ${filesPresent.length} file(s): ${filesPresent.slice(0, 5).join(", ")}${filesPresent.length > 5 ? ` and ${filesPresent.length - 5} more` : ""} — the missing workstreams' files are the difference.`
          : "";
      // #500 — the recorded repoRoot state, when the inspection ran. The
      // pre-#500 silence (nothing recorded, nothing rendered) is the defect:
      // a conflicted root wedges every later cycle at integrate()'s
      // dirty-preflight, and the handoff used to say nothing about why.
      // Cap-gated: this cap is the ONLY one whose recovery commands render
      // the `git apply` path the blurb references, so the blurb must not leak
      // into caps whose recovery commands differ.
      const rootBlurb = commitPrRootBlurb(
        state.pipelineState.commitPrRoot,
        state.pipelineState.commitPrRootError,
        "the recovery commands below apply as-is",
      );
      return `commit-pr's post-dispatch consolidation gate detected that the committed diff is missing files from these workstreams: ${which}. Ops committed a partial slice — the developers' work in the missing worktrees is uncommitted on disk. Pre-PR14 this would have merged silently (v0.12.13 /work 577 closed an issue with 1 of 3 workstreams' changes shipped). The driver halted before merge; recover by collecting the missing diffs from \`.worktrees/issue-N-<id>\` and re-running, or take over the integration manually.${presentBlurb}${rootBlurb}`;
    }
    case "verify-failed:commit-pr":
      return explainConsolidation(cap, state);
    case "integration-verify-failed":
      return explainConsolidation(cap, state);
    case "consolidated-verify-consolidation-created": {
      // #777 — the develop-time consolidated verify failed on a SPECIFIC
      // assertion that neither workstream tripped alone (per-workstream
      // pass, combined fail). The failure message in verifyEvidence carries
      // the classification label, the specific assertion, and both workstream
      // ids. Distinct from consolidated-verify-conflict (a cherry-pick
      // conflict — decomposition error) and verify-failed:develop (generic
      // verify failure — the per-worktree failures are the primary evidence).
      // The operator gets the exact assertion + both workstream ids instead
      // of "consolidated tree fails verify" — the handoff names the
      // combination and the specific biome/tsc/test line.
      const hit = lastCapHit(state, "consolidated-verify-consolidation-created");
      const ev = hit?.evidence ?? "(no classification detail recorded)";
      const wts = state.pipelineState.worktrees ?? {};
      const wtList = Object.entries(wts)
        .map(([id, p]) => `${id}: ${p}`)
        .join(", ");
      return `the develop step's consolidated verify failed on a specific assertion that NEITHER workstream tripped alone — the combination created the defect (classification: consolidation-created). ${ev} Worktrees: ${wtList || "(none recorded)"}. This is NOT the same as a cherry-pick conflict or a per-workstream verify failure: the work builds in each worktree in isolation; the combination does not. The specific failing assertion is named in the evidence above — fix the interaction between the two workstreams (dedupe, adjust the scaffold expectation, or resolve the design conflict by hand) and re-run`;
    }
    case "consolidated-verify-conflict":
      return explainConsolidation(cap, state);
    case "lens-fix-not-integrated":
      return explainLens(cap, state);
  }
  // #844 — a local branch of the resolved name holds commits the freshly
  // fetched origin/<mainline> does not. Deliberate halt: only a human can
  // decide whether the unpushed work is live, stale, or a diverged shape.
  // The ahead count is in the cap's suffix (or `unknown` when the count or
  // the ancestry probe itself could not be read — #844 round-2: an unreadable
  // probe halts instead of resetting, and the count then rides in as
  // `unknown`, never a fabricated 0); the branch name is in evidence.
  if (cap.startsWith("branch-ahead:")) {
    const hit = lastCapHit(state, cap);
    const ev = hit?.evidence ?? "(no detail recorded)";
    const suffix = cap.split(":")[1] ?? "unknown";
    const ahead = suffix === "unknown" ? "an unknown number of" : `${suffix}`;
    return `the branch step found a local feature branch that is ${ahead} commit(s) ahead of the freshly-fetched origin/<mainline> — the branch holds unpushed work that a reset would destroy, and only a human can decide what to do with it: ${ev}. The driver reset NOTHING; the branch name is in the evidence above. Inspect the ahead commits (\`git log origin/<mainline>..<branch>\`), push them if they are live work, delete the branch if they are stale, then re-run the cycle`;
  }
  // #844 — the ops-fallback branch path's post-dispatch merge-base check
  // failed: the branch ops actually created does not sit on the
  // driver-resolved baseSha. Ops built off a stale local ref (the #830
  // shape) or the mainline did not actually advance. The operator must
  // reset the branch to the correct base and re-run the cycle.
  if (cap === "ops-merge-base-mismatch") {
    const hit = lastCapHit(state, cap);
    const ev = hit?.evidence ?? "(no detail recorded)";
    return `the branch step's ops fallback recorded a baseSha that does not match the branch's actual merge-base with origin/<mainline>: ${ev}. The branch was not built off the freshly-fetched base — ops likely created it from a stale local ref. Reset the branch to the correct base (\`git branch -f <branch> <correct-sha>\`) and re-run the cycle, or investigate the branch's commit history before proceeding`;
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
    // #841 — when the cap carries the persisted raw-output log paths
    // STRUCTURALLY (the consolidated verify's run1/run2 logs, recorded on
    // the cap-hit event's `logPaths` field by the gate's emit site), render
    // them here. The failure-string bullets above already name the path, but
    // the operator reads the closing sentence for WHERE to look; an empty
    // failures list (the "(evidence detail missing)" shape) otherwise leaves
    // the log path reachable only from the raw event. No prose scanning —
    // the paths ride on the event, never parsed out of it. Absent on
    // pre-#841 state files (say nothing rather than guess).
    let logLine = "";
    if (step === "develop") {
      const capHit = lastCapHit(state, `verify-failed:${step}`);
      const logPaths = capHit?.logPaths;
      if (logPaths && logPaths.length > 0) {
        logLine = `\nFull raw verify output: ${logPaths.join(", ")} (scratch dir — inspect it before re-dispatching)`;
      }
    }
    // #782 — the consolidated-verify gate re-runs the verify command once
    // before classifying. When the re-run happened, say so so the operator
    // can tell a genuine double failure from one that recovered; absent on
    // pre-#782 state files (treat absent as "no re-run", no suffix).
    let retryNote = "";
    if (evidence && (evidence.retries ?? 0) > 0) {
      const n = evidence.retries;
      const verb = n === 1 ? "retried once" : `retried ${n} times`;
      retryNote = evidence.recovered
        ? `\nNote: the verify command was ${verb} and RECOVERED — the recorded failure was a transient flake; inspect the worktree(s) to confirm nothing else changed.`
        : `\nNote: the verify command was ${verb} and still failed — this is a real failure, not a flake.`;
    }
    return `the driver's outcome-verification gate rejected the ${step} step's "done" claim — the claimed result is not backed by executed evidence:${findings}${retryNote}${logLine}\nNo LLM judged this; the driver ran the checks itself (git diff/rev-list, the project's verify command, gh pr view). Inspect the worktree(s), fix or re-dispatch, and re-run. Set PI_ENSEMBLE_VERIFY=0 to disable the gate (not recommended)`;
  }
  // #753 — deferred worktree-creation failure. Its own sentence, because
  // `step-failed:develop` would be a mislabel (the dispatch itself never
  // failed; the DEPENDENT's deferred worktree creation was refused or
  // errored). The handoff's aborted-vs-handoff status keys off the
  // `step-failed:` prefix, so this cap is named `deferred-creation:develop`
  // (not `step-failed:…`) so a deliberate, well-explained park is
  // terminalized as a handoff, not as a mid-flight crash. The check sits
  // ABOVE the `step-failed:` prefix block on purpose — inside it the branch
  // was dead code and this cap fell through to the generic fallback.
  if (cap === "deferred-creation:develop") {
    // #753 — the leftover path rides on the failed workstream's branch-completed
    // event (the `dirty-leftover` failure record); naming it here keeps the
    // operator from having to dig for it. `leftoverPath` is a discriminant-
    // narrowed field (present only on the `dirty-leftover` member of
    // DeferredCreationFailure); read it after an explicit class check — no
    // cast, no suppression.
    const bc = state.eventLog
      .slice()
      .reverse()
      .find((e): e is Extract<WorkEvent, { kind: "branch-completed" }> => {
        if (e.kind !== "branch-completed" || e.ok !== false) return false;
        return e.deferredCreation?.failure.class === "dirty-leftover";
      });
    const frag = bc?.deferredCreation;
    const path =
      frag && frag.failure.class === "dirty-leftover" ? frag.failure.leftoverPath : undefined;
    return `a DEPENDENT workstream's deferred worktree creation was refused or failed (a dirty same-issue leftover at the target path, or a git error on the add) — the cycle parked so the leftover is inspected and salvaged rather than force-removed${path ? `; the leftover is at ${path}` : ""}; the failed workstream's branch-completed event carries the git detail`;
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
  // Should be unreachable when the WorkEvent union is exhaustively
  // covered above; if we land here, surface the raw cap so the user
  // can still grep the state file.
  return `step failed: ${String(cap)} — see state-file event log`;
}

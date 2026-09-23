/**
 * work-driver-explain-consolidation — cap-hit explanations for the
 * commit-pr / integration / consolidated-verify family. Split from
 * work-driver-explain.ts so that file sits under the 500-line cap with
 * headroom for new caps; the content here is the verbatim former case
 * bodies of work-driver-explain.ts.
 */

import { commitPrRootBlurb } from "./work-driver-commit-inspect.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/**
 * Explains the consolidation/verify-conflict family of caps
 * (`verify-failed:commit-pr`, `integration-verify-failed`,
 * `consolidated-verify-consolidation-created`,
 * `consolidated-verify-conflict`); the dispatch is exhaustive, so an
 * unknown cap can never land here.
 */
export function explainConsolidation(cap: Cap, state: WorkState): string {
  switch (cap) {
    case "verify-failed:commit-pr": {
      // #500 — the outcome gate fires on the same commit-pr step as the
      // incomplete-consolidation cap, so the recorded repoRoot state applies
      // to its recovery too. The blurb stays cap-scoped: it only appends from
      // the cases whose recovery commands reference the recorded state.
      const rootBlurb = commitPrRootBlurb(
        state.pipelineState.commitPrRoot,
        state.pipelineState.commitPrRootError,
        "the recovery commands below apply as-is",
      );
      return `the driver's outcome-verification gate rejected the commit-pr step's "done" claim — the committed + pushed + PR-opened claim is not backed by executed evidence. The per-check findings are in the handoff body; inspect the recorded repoRoot state there and re-run.${rootBlurb}`;
    }
    case "integration-verify-failed": {
      const base =
        "the consolidated tree failed the project's verify command, so nothing was pushed. Each workstream passed its own develop gate in its own worktree; the combination does not build — which is a defect integration CREATED, and the only place it can be caught. The failing output is in the plumb-report above. Recover by fixing the interaction (typically one workstream renamed or moved something another still refers to) and re-running";
      // #500 — this cap fires BEFORE the PR is created, but a failed
      // mechanized attempt can leave repoRoot dirty, and the operator's next
      // step (re-running) re-hits integrate()'s dirty preflight. The recorded
      // state + clearing command is the difference between "re-run" and
      // "re-run and get wedged again".
      const rootBlurb = commitPrRootBlurb(
        state.pipelineState.commitPrRoot,
        state.pipelineState.commitPrRootError,
        "clear it with the recorded command so re-running does not wedge at integrate()'s dirty preflight",
      );
      return `${base}.${rootBlurb}`;
    }
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
      const hit = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "cap-hit" }> =>
            e.kind === "cap-hit" && e.cap === "consolidated-verify-consolidation-created",
        );
      const ev = hit?.evidence ?? "(no classification detail recorded)";
      const wts = state.pipelineState.worktrees ?? {};
      const wtList = Object.entries(wts)
        .map(([id, p]) => `${id}: ${p}`)
        .join(", ");
      return `the develop step's consolidated verify failed on a specific assertion that NEITHER workstream tripped alone — the combination created the defect (classification: consolidation-created). ${ev} Worktrees: ${wtList || "(none recorded)"}. This is NOT the same as a cherry-pick conflict or a per-workstream verify failure: the work builds in each worktree in isolation; the combination does not. The specific failing assertion is named in the evidence above — fix the interaction between the two workstreams (dedupe, adjust the scaffold expectation, or resolve the design conflict by hand) and re-run`;
    }
    case "consolidated-verify-conflict": {
      // #669 — the develop-time consolidated verify (cherry-picking every
      // workstream's commit onto the integration branch so the verify
      // command sees the COMBINED tree) hit a real file-level conflict. The
      // evidence (which cherry-pick / apply failed, and any preserved patch
      // path) lives on the cap-hit's `evidence` field; the worktrees are the
      // operator's inspection targets. Distinct from verify-failed:develop:
      // the work may be individually fine — a two-workstream overlap is a
      // re-planning problem, not a retry-the-verify-command problem.
      // #794 — a STACKED cycle (dependsOn present) is a different shape: the
      // cherry-pick machinery now selects each workstream's OWN range
      // (against its dependency's tip), so an ancestor commit is never
      // re-picked on top of its content; a conflict that STILL fires is a
      // genuine overlap (or a diverged dependency tip), and re-splitting was
      // never the fix for a replay — so the prose below no longer asserts
      // the decomposition as incoherent.
      const hit = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "cap-hit" }> =>
            e.kind === "cap-hit" && e.cap === "consolidated-verify-conflict",
        );
      const ev =
        hit?.evidence ??
        "(no conflict detail recorded — inspect the worktrees to see which files both workstreams edited)";
      const wts = state.pipelineState.worktrees ?? {};
      const wtList = Object.entries(wts)
        .map(([id, p]) => `${id}: ${p}`)
        .join(", ");
      // #794 — stacked cycle: the pick is OWN-range (each workstream's
      // commits against its dependency's tip), so a conflict here is a
      // genuine overlap or a diverged dependency tip, never an ancestor
      // re-apply — the pre-#794 text's "decomposition is incoherent" /
      // "re-split" diagnosis is exactly wrong for a stack.
      const stacked = Object.values(state.pipelineState.workstreams ?? {}).some(
        (ws) => ws && Array.isArray(ws.dependsOn) && ws.dependsOn.length > 0,
      );
      if (stacked) {
        return `the develop step's consolidated verify could not combine the workstreams' commits into a single tree — a cherry-pick / patch-apply conflict, even though each workstream's own range was picked against its dependency's tip (stacked cycle: ancestor commits are NOT re-picked). ${ev} Worktrees: ${wtList || "(none recorded)"}. Do NOT re-split on this alone: the conflict is either a genuine content overlap between workstreams (two workstreams editing the same lines) or a dependency whose tip diverged from the SHA the dependent's worktree was based on. Inspect the conflicting file, resolve it by hand, and re-run; check the dependency tips only if the conflicting lines belong to a dependency's own work`;
      }
      return `the develop step's consolidated verify could not combine the workstreams' commits into a single tree — a cherry-pick / patch-apply conflict means two workstreams edited the same lines, so the work is individually plausible but the decomposition is incoherent. ${ev} Worktrees: ${wtList || "(none recorded)"}. This is NOT the same as a verify failure: the fix is to re-split the work into non-overlapping file sets (or resolve the overlap by hand), not to retry the verify command`;
    }
    default:
      return `unhandled consolidation cap: ${cap}`;
  }
}

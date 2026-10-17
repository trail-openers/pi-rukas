/**
 * work-driver-explain-consolidation — cap-hit explanations for the
 * commit-pr / integration / consolidated-verify family. Split from
 * work-driver-explain.ts so that file sits under the 500-line cap with
 * headroom for new caps; the content here is the verbatim former case
 * bodies of work-driver-explain.ts.
 */

import { describeSiblingFenceViolations } from "./work-develop-fence-verdicts.ts";
import { commitPrRootBlurb } from "./work-driver-commit-inspect.ts";
// #875 blurb (moved here from work-driver-explain.ts for the 500-line gate).
import { cherryPickRecoveryFor } from "./work-driver-handoff-cherry-pick.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/**
 * Explains the consolidation/verify-conflict family of caps
 * (`integration-verify-failed`,
 * `consolidated-verify-consolidation-created`,
 * `consolidated-verify-conflict`); the dispatch is exhaustive, so an
 * unknown cap can never land here.
 */
export function explainConsolidation(cap: Cap, state: WorkState): string {
  switch (cap) {
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
        // #814 — the stacked prose below no longer asserts incoherence, so
        // the fence override must run BEFORE it. When the driver recorded
        // a sibling-declared fence violation, the conflict is the fence
        // materialising at consolidation — name the attribution instead of
        // the stacked-overlap prose (same distinction as the flat case
        // below; the fence records are the same on either shape).
        const fence = state.pipelineState.verifyEvidence?.fenceViolations ?? [];
        const fenceText = fenceAttribution(fence);
        if (fenceText) return fenceText;
        return `the develop step's consolidated verify could not combine the workstreams' commits into a single tree — a cherry-pick / patch-apply conflict, even though each workstream's own range was picked against its dependency's tip (stacked cycle: ancestor commits are NOT re-picked). ${ev} Worktrees: ${wtList || "(none recorded)"}. Do NOT re-split on this alone: the conflict is either a genuine content overlap between workstreams (two workstreams editing the same lines) or a dependency whose tip diverged from the SHA the dependent's worktree was based on. Inspect the conflicting file, resolve it by hand, and re-run; check the dependency tips only if the conflicting lines belong to a dependency's own work`;
      }
      // #814 — fence attribution takes precedence over any conflict guess:
      // when the driver recorded a sibling-declared fence violation
      // (workstream W touched a file sibling S declared), the conflict is the
      // FENCE materialising at consolidation — the declared paths were
      // DISJOINT, so the plan was fine and re-splitting fixes nothing. The
      // structured records on `verifyEvidence` carry the attribution
      // (violating workstream, file, declaring sibling); read them (not
      // `failures`) for that, and fall back to the #813 observed-conflict
      // text when they are absent or empty.
      const fence = state.pipelineState.verifyEvidence?.fenceViolations ?? [];
      const fenceText = fenceAttribution(fence);
      if (fenceText) return fenceText;
      // #813 — no fence record: state what the driver OBSERVED (the cap's
      // own evidence, plus which pick failed if that was recorded) rather
      // than asserting the decomposition is incoherent. The old text told
      // the operator to re-split, which #1005 makes the wrong advice for a
      // type-coupled pair with disjoint declared paths.
      return describeObservedConsolidationConflict({
        lead: `the develop step's consolidated verify could not combine the workstreams' commits into a single tree`,
        observed: ev,
        worktrees: wtList || "(none recorded)",
        declaredPathsByWorkstream: declaredPathsFor(state),
      });
    }
    default:
      return `unhandled consolidation cap: ${cap}`;
  }
}

/**
 * #813 — the per-workstream declared paths, for the coupled-pair clause of
 * the no-fence conflict text. Reads the plan's `paths` (already on state);
 * an absent plan yields `{}` and the neutral sentence.
 */
function declaredPathsFor(state: WorkState): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, ws] of Object.entries(state.pipelineState.workstreams ?? {})) {
    if (ws && Array.isArray(ws.paths) && ws.paths.length > 0) out[id] = ws.paths;
  }
  return out;
}

/**
 * #814 — the operator-facing fence attribution for the
 * `consolidated-verify-conflict` cap. When `verifyEvidence.fenceViolations`
 * carries at least one `sibling-declared` record, the conflict is the fence
 * materialising at consolidation: the declared paths were DISJOINT (the
 * plan was fine — the fence was violated), and the operator must be told
 * WHICH workstream touched WHICH file that WHICH sibling declared, not
 * that the decomposition is incoherent (re-splitting would not fix it).
 * Returns `undefined` when no sibling-declared record is present (absent,
 * empty, or undeclared-only records) — the caller then falls back to the
 * pre-#814 text, where the "incoherent" claim is still true for a genuine
 * declared-path overlap.
 */
function fenceAttribution(fence: FenceViolationRecord[]): string | undefined {
  const named = describeSiblingFenceViolations(fence);
  if (!named) return undefined;
  return `the develop step's consolidated verify could not combine the workstreams' commits into a single tree — a cherry-pick / patch-apply conflict that the develop scope fence ALREADY predicted: the declared paths were DISJOINT (the decomposition was fine), but the fence was violated — ${named}. Re-splitting the plan will NOT fix this conflict; it is the fence violation materialising at consolidation. Restore the fence boundary (the violating workstream's commit must not include that file — split the change so each file is touched by exactly one workstream) and re-run`;
}

/**
 * #813 — the no-fence-record conflict sentence, shared by both operator
 * surfaces (the develop gate's failure string and the
 * `consolidated-verify-conflict` cap explanation).
 *
 * The pre-#813 text asserted "two workstreams edited the same lines; the
 * decomposition is incoherent" whenever the driver had recorded no fence
 * violation. That is an inference, not an observation, and since #1005
 * merges genuinely coupled workstreams at plan time it is usually WRONG for
 * the pair that still collides: disjoint declared paths that couple through
 * TYPES (the #792 DeliverableStatus/ConvergeEvidence shape) collide at
 * consolidation without either workstream violating its fence, and
 * re-splitting is not the fix — #1005's merge-and-retry is.
 *
 * So the text now states only what the driver can see: the failure detail,
 * which pick failed, and which picks applied cleanly before it. Where the
 * failure names a file another workstream DECLARED, it says the workstreams
 * are likely coupled and points at the #1005 merge behaviour. The caller
 * keeps the fence-attribution branch first — this is the fallback.
 */
export function describeObservedConsolidationConflict(opts: {
  /** The conflict detail from the consolidated run (may be absent). */
  detail?: string;
  /**
   * A sentence naming what was observed, spliced in verbatim ahead of the
   * diagnosis. The cap renderer passes the cap's own `evidence` here (the
   * gate's failure string, which already names the failing pick); the
   * reporter leaves this absent and `detail` / the pick fields carry it.
   */
  observed?: string;
  /** The workstream whose pick failed, when the batch reported it. */
  conflictedWorkstream?: string;
  /** Workstreams whose picks applied cleanly before the aborting pick. */
  appliedBeforeConflict?: string[];
  /**
   * Declared paths by workstream id — used ONLY to recognise that a file
   * named in the failure belongs to a sibling, which is what licenses the
   * "likely coupled" wording. Empty/absent → the neutral sentence.
   */
  declaredPathsByWorkstream?: Record<string, string[]>;
  /**
   * Text scanned for a declared path (the cap evidence or the conflict
   * detail). Read as-is; no path inference beyond an exact substring hit.
   * Defaults to `observed ?? detail` when absent.
   */
  evidence?: string;
  /** Lead-in so both surfaces read in their own voice. */
  lead: string;
  /** Pre-rendered "id: path" list of the worktrees to inspect (cap renderer). */
  worktrees?: string;
}): string {
  const observed: string[] = [];
  const pickLine = (() => {
    if (!opts.conflictedWorkstream) return undefined;
    const before = (opts.appliedBeforeConflict ?? []).filter(
      (id) => id !== opts.conflictedWorkstream,
    );
    return before.length > 0
      ? `the pick for workstream '${opts.conflictedWorkstream}' failed after ${before.map((id) => `'${id}'`).join(" and ")} applied cleanly`
      : `the pick for workstream '${opts.conflictedWorkstream}' failed`;
  })();
  // #813 — the two surfaces state the observation in their own shape:
  // - the cap renderer passes `observed` (the gate's failure string, which
  //   already carries the detail) and no pick fields — render it verbatim.
  // - the reporter passes the structured pick fields and no `observed` —
  //   render the pick line, and fall back to `detail` when nothing was
  //   recorded about which pick failed.
  // The lead-in always carries the "could not combine" clause, so a bare
  // restatement of it in the detail adds nothing and is dropped.
  const restatesLead = /^\s*(consolidated verify|the develop step).*could not combine/i.test(
    (opts.observed ?? opts.detail ?? "").trim(),
  );
  const detailText = restatesLead ? "" : (opts.observed ?? opts.detail ?? "").trim();
  const evidenceText =
    opts.evidence ?? [opts.lead, opts.observed, opts.detail, pickLine].filter(Boolean).join("; ");
  if (pickLine) observed.push(pickLine);
  if (detailText) observed.push(detailText);
  const observedText =
    observed.length > 0
      ? observed.join("; ")
      : "which workstream's patch could not be combined was not recorded";
  // The scan text is what the diagnosis reads for a declared-path hit — the
  // cap evidence or the conflict detail, so a file named there (or in the
  // pick line) licenses the "likely coupled" wording.
  const coupled = coupledWorkstreamClause(evidenceText, opts.declaredPathsByWorkstream ?? {});
  // #813 — the operator still needs the worktrees to inspect (the pre-#813
  // text carried them); rendered here so both surfaces state where to look.
  const where = opts.worktrees ? ` Worktrees: ${opts.worktrees}.` : "";
  const diagnosis = coupled
    ? `${coupled} The workstreams are likely COUPLED through that file or the types it declares — #1005 merges coupled workstreams at plan time and retries consolidation on the merged pair, so re-splitting the same split will not converge: merge the pair (or let the fence-recovery merge run) and re-run`
    : `Nothing here proves the decomposition is wrong, so do NOT re-split on this alone: inspect the file the pick could not apply, decide whether the workstreams are coupled (types, a shared symbol, a shared fixture), and if they are, #1005's merge-and-retry is the fix rather than a new split`;
  return `${opts.lead} — ${observedText}.${where} ${diagnosis}`;
}

/**
 * #813 — the "these workstreams are likely coupled" clause, or `undefined`
 * when the failure names no file any workstream declared. Matching is an
 * exact substring test on the NORMALISED declared path, so a plan annotation
 * ("src/a.ts (new)") cannot hide a hit and a coincidental word in the
 * failure prose cannot manufacture one.
 */
export function coupledWorkstreamClause(
  evidence: string,
  declaredPathsByWorkstream: Record<string, string[]>,
): string | undefined {
  if (!evidence) return undefined;
  for (const [id, paths] of Object.entries(declaredPathsByWorkstream)) {
    for (const raw of paths) {
      const file = normaliseConsolidationPath(raw);
      if (file.length > 0 && evidence.includes(file)) {
        return `the conflict names \`${file}\`, which workstream ${id} declared`;
      }
    }
  }
  return undefined;
}

/** #813 — same shape as `normaliseDeclaredPath`, kept local to avoid a cycle. */
function normaliseConsolidationPath(raw: string): string {
  return raw
    .trim()
    .replace(/\s*\([^()]*\)\s*$/, "")
    .replace(/^[`*\s]+|[`*\s]+$/g, "")
    .replace(/^\.\//, "")
    .trim();
}

/**
 * #875 — the "missing workstreams" blurb for the
 * `commit-pr-incomplete-consolidation` cap. Reads ONLY the persisted
 * per-verdict `dirty` flag (no git calls) — dirty=true or flag absent
 * (legacy) → "uncommitted on disk"; dirty=false → cherry-pick recovery.
 *
 * Moved verbatim out of work-driver-explain.ts (the 500-line gate; the same
 * seam this module already is — "so that file sits under the cap with headroom
 * for new caps"). It belongs here rather than in the parent because it is the
 * consolidation family's own prose: the cherry-pick recovery it emits is the
 * one this family of caps names.
 */
export function commitPrConsolidationBlurb(
  state: WorkState,
  opts: { missingIds: string[]; filesPresent: string[] },
): string {
  const ps = state.pipelineState;
  const which = opts.missingIds.length > 0 ? opts.missingIds.join(", ") : "one or more workstreams";
  const ic = ps.incompleteConsolidation;
  const verdicts = Array.isArray(ic) ? [] : (ic?.verdicts ?? []);
  const wts = ps.worktrees ?? {};
  const lines: string[] = [`the committed diff is missing declared files from: ${which}.`];
  for (const id of opts.missingIds) {
    const v = verdicts.find((x) => x.id === id);
    const isClean = !Array.isArray(ic) && !!v && v.status === "uncovered" && v.dirty === false;
    const wtSuffix = wts[id] ? ` (${wts[id]})` : "";
    if (!isClean) {
      lines.push(
        `  - ${id}: the developers' work in the missing worktree${wtSuffix} is uncommitted on disk.`,
      );
      continue;
    }
    const pick = cherryPickRecoveryFor(state.issue, id, {
      worktree: wts[id],
      baseSha: ps.baseSha,
      ownBase: ps.workstreamBaseShas?.[id],
      headSha: ps.commitShas?.[id],
    });
    const pickText = pick.kind === "command" ? `cherry-pick it: \`${pick.line}\`` : pick.line;
    lines.push(
      `  - ${id}: nothing uncommitted — the work is COMMITTED in its worktree${wtSuffix}. If ${v.uncoveredPaths.join(", ")} genuinely needed a change, ${pickText}; otherwise the declaration was over-broad and the fix is a restart.`,
    );
  }
  if (opts.filesPresent.length > 0) {
    const shown = opts.filesPresent.slice(0, 5).join(", ");
    lines.push(
      ` The committed diff contains ${opts.filesPresent.length} file(s): ${shown}${opts.filesPresent.length > 5 ? ` and ${opts.filesPresent.length - 5} more` : ""} — the missing workstreams' files are the difference.`,
    );
  }
  return lines.join(" ");
}

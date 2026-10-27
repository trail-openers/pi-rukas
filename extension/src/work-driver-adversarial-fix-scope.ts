/**
 * work-driver-adversarial-fix-scope — the fence an adversarial fix pass runs
 * under (#1114). Fails closed: every read the fence needs either succeeds or
 * becomes a named park reason, and nothing falls back to repoRoot or to an
 * empty set. The widened scope lives in an overlay the develop step receives
 * as a parameter; it is never written into the persisted pipeline state.
 *
 * Widening is bounded by three conditions, and only these: a finding-named path
 * widens the fence when it is tracked at base OR already changed by this cycle
 * (#1698 — the committed diff from `baseSha` to the worktree's head before the
 * pass, so a file the cycle's own earlier round created is reachable), not
 * protected per `protectedPathsIn` (the single source of protected paths), and
 * in the same non-root directory as a declared or already-changed path. There
 * is no list of project-specific modules: the /work driver runs on other
 * repositories too. A driver module is therefore no more editable in a fix pass
 * than on a first develop pass, which has the same fence and the same gates.
 *
 * #1698(b): a corrective round the driver dispatches INSIDE a fix pass edits
 * the files its own evidence lines name; those files are admitted from the
 * stray set because the driver ordered the edit. The rule, its three
 * conditions and its cap live in work-driver-corrective-admission.ts; this
 * fence asks it the question AFTER the fence and the protected-path gate have
 * answered, so neither can be overridden from below.
 *
 * #1557 adds the one thing that rule could not reach: a file that does not
 * exist yet. A spec deliverable's PATTERN slot (`review-ledger-*.ts`,
 * `work-driver-<name>.ts`) is an authorisation to CREATE a matching file, and
 * the plan is forbidden from declaring such a slot (`plannedPathProblem`), so
 * the only record that the file was in scope is the spec itself. It is read
 * from driver state and judged by the converge gate's own segment-anchored
 * matcher — see work-driver-spec-slot-admission.ts. The fence still wins over
 * the slot (an `outOfScope` entry is never unfenced by a spec pattern) and a
 * protected path still halts.
 */

import {
  type FixExec,
  type GitRead,
  type TreeChanges,
  committedChanges,
  headOf,
  trackedPaths,
  treeChanges,
} from "./work-driver-adversarial-fix-git.ts";
import { unchangedPlans } from "./work-driver-adversarial-fix-noop.ts";
import {
  correctiveRoundFor,
  createCorrectiveAdmission,
} from "./work-driver-corrective-admission.ts";
import {
  anchorDirs,
  dirOfPath,
  entryPath,
  fenceMatches,
  pathTokenIn,
} from "./work-driver-declared-path.ts";
import { protectedPathsIn } from "./work-driver-doctrine.ts";
import {
  type FixPassFence,
  coupledTestAdmitted,
  fixPassAdmissionNote,
  fixPassFence,
  fixPassFenceLines,
  fixPassHelperDirs,
  gateFenceView,
} from "./work-driver-fix-pass-admission.ts";
import { type FixPassFileGate, admitFixPassEntry } from "./work-driver-fix-pass-admit-file.ts";
import { passFanoutRefusal } from "./work-driver-fix-pass-ceiling.ts";
import { namedPaths } from "./work-driver-fix-pass-named.ts";
import { type Stray, listed, strayReason } from "./work-driver-fix-pass-park-reason.ts";
import { fanoutLimitFor } from "./work-driver-scope-fanout.ts";
import {
  type Admission,
  type AdmissionRefusal,
  type SpecAdmitter,
  type SpecPatternSlot,
  admissionNote,
  createSpecAdmitter,
  specPatternSlots,
} from "./work-driver-spec-slot-admission.ts";
import type { CorrectiveRoundEvent } from "./workflow-state-events-corrective.ts";
import type { PipelineState, Workstream } from "./workflow-state-schema.ts";

export interface FixRequest {
  workstreamId: string;
  findings: string;
}

/** One workstream's pre-pass state: what the fence is judged against. */
export interface PassPlan {
  id: string;
  worktree: string;
  findings: string;
  headBefore: string;
  /** Changes against the base commit before the pass (the N=1 baseline). */
  before: TreeChanges;
  declared: string[];
  /** Unprotected paths a finding names, tracked at base or already changed by this cycle, in an anchor's directory (see namedPaths). */
  named: string[];
  /** Named paths that widen a declared fence for this pass only. */
  widened: string[];
  /** The workstream's own out-of-scope fence, normalised — it beats a spec slot. */
  outOfScope: string[];
  /**
   * #1557 — the PATTERN slots of the cycle's spec deliverables, read from
   * driver state (`pipelineState.normalisedSpec`) and never from issue prose.
   * A new file the spec authorised is in scope; `namedPaths` could never see
   * it, because that widening reads the tree tracked AT base.
   */
  specSlots: SpecPatternSlot[];
  /**
   * #1760 — route (a)'s candidate set: `trackedPaths(base) ∪
   * committedChanges(base..headBefore)`. Stored, not recomputed, so the
   * corrective route judges a file against the SAME provenance the finding route
   * did — two readings of "what this cycle owns" is how one fence gets two
   * answers.
   */
  candidates: ReadonlySet<string>;
  /** Route (a)'s anchor directories (`anchorDirs`), kept for the same reason. */
  dirs: ReadonlySet<string>;
  /**
   * #1846 — the fence the pass is judged against AND the fix prompt prints,
   * computed once at plan time from `fixPassSubjects` (declared ∪ already-changed
   * ∪ finding-named) and the pass's fan-out ceiling. The prompt renders this
   * object and `postPassFault` reads it, so the set the fixer is told about and
   * the set it is refused by are the same value (PM decision #1846-5); the
   * coupled-test and anchored-helper routes are layered on it per file.
   */
  fence: FixPassFence;
}

const fenced = (reason: string): { ok: false; reason: string } => ({
  ok: false,
  reason: `scope could not be verified: ${reason}`,
});

/**
 * The pre-pass reads for every pending workstream. Any unreadable tree, base
 * or HEAD, or a workstream with no recorded worktree, is a park reason.
 */
export async function planFixPass(
  execFn: FixExec,
  repoRoot: string,
  ps: PipelineState,
  pending: readonly FixRequest[],
): Promise<GitRead<PassPlan[]>> {
  const tracked = await trackedPaths(execFn, repoRoot, ps.baseSha);
  if (!tracked.ok) return fenced(tracked.reason);
  // #1557 — one reading of the spec for the whole pass, from the persisted
  // pipeline state. Issue prose is untrusted input a workstream authors; the
  // validated spec is the cycle's contract, and it is the only thing allowed
  // to widen a fence here besides the finding-named rule.
  const specSlots = specPatternSlots(ps.normalisedSpec);
  const plans: PassPlan[] = [];
  for (const p of pending) {
    const worktree = ps.worktrees?.[p.workstreamId];
    if (!worktree) {
      return fenced(
        `no worktree is recorded for ${p.workstreamId} (the fix pass never falls back to repoRoot)`,
      );
    }
    const head = await headOf(execFn, worktree);
    if (!head.ok) return fenced(head.reason);
    const before = await treeChanges(execFn, worktree, ps.baseSha ?? "");
    if (!before.ok) return fenced(before.reason);
    // #1698(a) — "already changed by this cycle" is the COMMITTED diff from
    // base to the pass's head (treeChanges is worktree-vs-base and also
    // carries uncommitted/untracked residue; the committed read is the
    // precise record of what the cycle itself made).
    const cycle = await committedChanges(execFn, worktree, ps.baseSha ?? "", head.value);
    if (!cycle.ok) return fenced(cycle.reason);
    const declared = (ps.workstreams?.[p.workstreamId]?.paths ?? []).map(entryPath);
    // Widening anchors: the declared fence, and what the workstream already changed.
    // Widening candidates: tracked at base OR already changed by this cycle.
    // #1760 — both are computed ONCE here and kept on the plan, because the
    // corrective route judges a file against the SAME provenance and the SAME
    // anchors; a second reading of either is how one fence gets two answers.
    const candidates = [...new Set([...tracked.value, ...cycle.value])];
    const anchors = [...declared, ...before.value.names];
    const named = namedPaths(p.findings, candidates, anchors);
    plans.push({
      id: p.workstreamId,
      worktree,
      findings: p.findings,
      headBefore: head.value,
      before: before.value,
      declared,
      named,
      widened: declared.length > 0 ? named.filter((x) => !declared.includes(x)) : [],
      outOfScope: (ps.workstreams?.[p.workstreamId]?.outOfScope ?? []).map(entryPath),
      specSlots,
      candidates: new Set(candidates),
      dirs: anchorDirs(anchors),
      // #1846 — the ceiling basis (admitting slots) is only known after the
      // pass runs, so the plan-time view is built with zero slots and the
      // ceiling is recomputed against the pass's own slot count below.
      fence: fixPassFence(
        {
          id: p.workstreamId,
          declared,
          named,
          alreadyChanged: before.value.names,
          outOfScope: ps.workstreams?.[p.workstreamId]?.outOfScope ?? [],
          admittingSlots: 0,
        },
        fanoutLimitFor,
      ),
    });
  }
  return { ok: true, value: plans };
}

/**
 * The workstreams as the develop step sees them for this pass: declared paths
 * plus the named widening, the findings the developer must resolve, and —
 * #1846 — the rendered fence the pass will actually be judged against. Only
 * ever passed as a parameter; the persisted pipeline keeps the originals.
 */
export function overlayWorkstreams(
  originals: Record<string, Workstream> | undefined,
  plans: readonly PassPlan[],
): Record<string, Workstream> {
  const out: Record<string, Workstream> = { ...(originals ?? {}) };
  for (const plan of plans) {
    const orig = originals?.[plan.id];
    const paths = [...plan.declared, ...plan.widened];
    // #1846 — the fence block is rendered from `plan.fence`, the same object
    // `postPassFault` reads per file, so the two sides of the contract are one
    // value and a test can assert equality rather than mere presence.
    const fixFenceLines = fixPassFenceLines(plan.fence);
    out[plan.id] = orig
      ? { ...orig, paths, fixFindings: plan.findings, fixFenceLines }
      : {
          id: plan.id,
          scope: "",
          paths,
          outOfScope: [],
          fixFindings: plan.findings,
          fixFenceLines,
        };
  }
  return out;
}

export {
  type PostPass,
  postPassFault,
} from "./work-driver-adversarial-fix-verify.ts";

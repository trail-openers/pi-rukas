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
} from "./work-driver-fix-pass-admission.ts";
import { type FixPassFileGate, admitFixPassEntry } from "./work-driver-fix-pass-admit-file.ts";
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

/**
 * Named paths a fix pass may widen its fence onto. Generic, not a project list:
 * a finding-named path qualifies only if it is (a) in `candidates` — the union
 * of the tree tracked at base and the files this cycle already committed
 * (#1698: a file the cycle's own round created is never tracked at base, so
 * the tracked-at-base reading alone made it un-nameable by construction),
 * (b) not protected per `protectedPathsIn` (the single source of protected
 * paths), and (c) in the same directory as an anchor — a declared path or a
 * file the workstream already changed. A directory entry (`src/foo/`) is its
 * own directory. The repo root is not an anchor: a root-level anchor would make
 * every root file widenable. Named as a whole path token (`data.txt` does not
 * name `a.txt`).
 */
export function namedPaths(
  findings: string,
  candidates: readonly string[],
  anchors: readonly string[],
): string[] {
  const dirs = anchorDirs(anchors);
  return [...new Set(candidates)].filter(
    (p) => protectedPathsIn([p]).length === 0 && dirs.has(dirOfPath(p)) && pathTokenIn(findings, p),
  );
}

const fenced = (reason: string): { ok: false; reason: string } => ({
  ok: false,
  reason: `scope could not be verified: ${reason}`,
});

/** No anchors: the anchored-helper route admits nothing (see `postPassFault`). */
const EMPTY_DIRS: ReadonlySet<string> = new Set<string>();

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

export interface PostPass {
  /** Why the pass is not cleared, or undefined when the fence held. */
  reason?: string;
  /** Each workstream's post-pass diff against base (for the comment-retention check). */
  diffs: Record<string, string>;
  /**
   * #1725 round 3 — ONE disclosure note per admitted (workstream, file).
   * Surfaced where the pass's other notes surface; an authorisation the
   * operator never sees is a fence that widened invisibly.
   */
  admissions: string[];
  /**
   * #1846 — the workstream whose fence the strays belong to, when
   * {@link reason} is a stray refusal, and the strays themselves. Present
   * ONLY for the stray refusal the driver can act on: a fenced or protected
   * stray, a pass that changed nothing, or a fan-out breach carries no
   * `straysFor`, because the revert path must never touch those files (they
   * are the ones an admission rule may not lift, or the whole pass is the
   * problem). `untracked` is the same read's untracked set, which decides
   * removal vs checkout for each path.
   */
  straysFor?: string;
  /** See {@link PostPass.straysFor}. */
  strays?: Stray[];
  /** See {@link PostPass.straysFor} — the untracked paths of that workstream. */
  untracked?: string[];
}

/**
 * Does a FENCE entry cover `file`? The ONE fence predicate answers it
 * (#1725 round 3): `fenceMatches` is the same function the develop gate's
 * outOfScope blocking check and the admitter's `isFenced` run, so a fence
 * entry — `dir/**`, `dir/** (note)`, backticked markup, or a real glob like
 * `src/*.test.ts` — cannot refuse this fence and pass that gate. The two
 * fences used to read one entry through two grammars (`fenceDirPrefix` + a
 * `/` boundary here, a normalise-then-compare there); two answers from one
 * entry is the drift this closes. The exact-or-trailing-slash `allows()` that
 * used to answer this alongside it read `dir/**` as a literal path, so a
 * fenced directory failed to beat a spec slot and the slot silently unfenced a
 * fence the plan wrote on purpose; #1846 removed that second reader and the
 * whole fence now goes through `plan.fence` / `admitFixPassFile`.
 */
const fencedBy = (entry: string, file: string): boolean => fenceMatches(entry, file);

/**
 * The post-pass checks, in order: the pass changed something, every file it
 * changed is allowed (uncommitted and untracked included), and a declared
 * fence stays within its fan-out ceiling. The ceiling is computed from the
 * DECLARED paths, not the widened list — and what the spec authorised is added
 * to THAT count (#1557, #1725): a slot-admitted file stays in the numerator
 * and the declared denominator grows by the authorisation, so the ceiling
 * bounds what the workstream invented while the spec's own deliverable buys
 * real room. Deleting admitted files from the numerator instead (the previous
 * shape) meant a workstream could change an unbounded number of spec-named
 * files and present a numerator of zero.
 *
 * #1698(b): the gate owns its input. It takes the PASS-SCOPED
 * `corrective-round` records — the ones the fix pass's own event window
 * carries — and derives everything it admits from them, rather than reading a
 * caller-built string map. A file is admitted on the corrective route only
 * when all three hold: it is in the round's own target set (the paths its
 * evidence names), `git` says it changed AFTER the commit the round was
 * recorded at (so evidence alone cannot authorise a file the pass itself wrote
 * before the round started), and it is neither fenced nor protected. Admissions
 * #1698(b): the gate owns its input. It takes the PASS-SCOPED
 * `corrective-round` records — the ones the fix pass's own event window
 * carries — and derives everything it admits from them, rather than reading a
 * caller-built string map. The route's conditions, its cap and its refusal
 * texts all live in `work-driver-corrective-admission.ts`; this fence hands it
 * the SAME provenance set and anchor set route (a) was judged against (the
 * plan's `candidates` / `dirs`, computed once at plan time), and asks it ONE
 * question per candidate stray — see {@link CORRECTIVE_PRECEDES} for the
 * refusals the round may not speak over.
 */
export async function postPassFault(
  execFn: FixExec,
  plans: readonly PassPlan[],
  baseSha: string,
  corrective: readonly CorrectiveRoundEvent[] = [],
): Promise<PostPass> {
  const diffs: Record<string, string> = {};
  // #1725 round 3 — one disclosure note per admitted (workstream, file),
  // shared across plans; the caller surfaces them where the pass's other
  // notes surface. An authorisation the operator never sees is a fence that
  // widened invisibly.
  const admissions: string[] = [];
  const after: TreeChanges[] = [];
  for (const plan of plans) {
    const r = await treeChanges(execFn, plan.worktree, baseSha);
    if (!r.ok) return { reason: fenced(r.reason).reason, diffs, admissions };
    after.push(r.value);
    diffs[plan.id] = r.value.diff;
  }
  const unchanged = plans
    .filter(
      (p, i) =>
        after[i]?.diff === p.before.diff &&
        after[i]?.untracked.join("\n") === p.before.untracked.join("\n"),
    )
    .map((p) => p.id);
  if (unchanged.length > 0) {
    return {
      reason: `the diff of ${unchanged.join(", ")} is byte-identical to its pre-pass state — nothing was fixed`,
      diffs,
      admissions,
    };
  }
  for (const plan of plans) {
    const s = await treeChanges(execFn, plan.worktree, plan.headBefore);
    if (!s.ok) return { reason: fenced(s.reason).reason, diffs, admissions };
    // A file the pass created and never staged is in `untracked`, not in
    // `names` — git's porcelain has no entry for a path it has never seen, so
    // both reads are this pass's changes. Both go into the denominator AND
    // through the ladder: passing only `names` meant an untracked stray never
    // reached `admitFixPassEntry`, so the driver never saw it as a revertible
    // stray and parked on a file it could have reverted itself.
    const passFiles = [...new Set([...s.value.names, ...s.value.untracked])];
    // #1846 — the ONE fence view. The pre-#1846 shape rebuilt `allowed` here
    // while the prompt rendered `workstream.paths`, so the fixer was told one
    // set and refused by another. Both sides now read `plan.fence`.
    const fence = plan.fence;
    // #1698(b) — this workstream's corrective round: its conditions, its
    // post-round commit window, its cap and its disclosure all live in
    // work-driver-corrective-admission.ts, which is handed this plan's OWN
    // candidate set and anchor set so both widening routes judge a file against
    // one reading of what the cycle owns. NO ROUND, NO ROUTE: asking it anyway
    // would render "the round never named it" on a pass that ran no round, which
    // is a true-sounding explanation of a route that was never in play. The
    // FENCE still outranks it: the shared admitter is asked first and a `fenced`
    // / `protected` refusal is final, so the round can never unfence a path the
    // plan fenced.
    const round = correctiveRoundFor(corrective, plan.id);
    const admission = round
      ? createCorrectiveAdmission(execFn, round, {
          worktree: plan.worktree,
          candidates: plan.candidates,
          dirs: plan.dirs,
        })
      : undefined;
    // #1557 — a new file the spec's pattern slot authorises is in scope
    // exactly as a declared path is; the finding-named widening could never
    // have seen it (`namedPaths` reads the tree tracked AT base, and a file
    // this pass created is not in it). The FENCE is handed to the admitter as
    // input — it judges fenced / protected / slot / per-slot-cap in one
    // order for both gates, refuses with a named kind, traces ONE line and
    // emits ONE disclosure note per admitted pair: a fence that widened
    // silently is a fence nobody can audit.
    const admit = createSpecAdmitter({
      slots: plan.specSlots,
      source: "work-driver: fix pass",
      isFenced: (_id, file) => plan.outOfScope.some((entry) => fencedBy(entry, file)),
      onAdmit: (id, file, slot) => admissions.push(admissionNote(id, file, slot)),
    });
    // WHY a `continue` in the loop below is correct: it skips only the per-file
    // loop, never this plan's fan-out check, which runs after it and counts
    // EVERY file the pass changed — admitted ones included. An earlier shape of
    // this loop returned from inside it, and the ceiling check became
    // unreachable for a pass that reached an admission route; that is how a
    // bounded rule stops bounding anything.
    const strays: Stray[] = [];
    // #1846 — the helper route's anchor files, and the one ceiling's numerator
    // (`passChanged.length`): everything this pass changed, from every route,
    // against one denominator (PM decision #1846-3). The gate view is built once
    // per pass with the pass's own delta filled in, and every file of the
    // post-pass tree is put through `admitFixPassEntry` — the whole route ladder
    // lives there with its precedence stated in one place.
    const helperDirs = fixPassHelperDirs(
      plan.declared,
      plan.findings,
      plan.named,
      plan.dirs,
      round !== undefined,
    );
    // A file the pass created and never staged is in `untracked`, not in
    // `names` — git's porcelain has no rename entry for a path it has never
    // seen. Both reads are this pass's changes, so both go into the denominator
    // and both go through the ladder; the pre-#1846 shape passed only `names`,
    // which meant an untracked stray never reached `admitFixPassEntry` and so
    // was never recorded as a revertible stray for the driver to act on.
    const judging: FixPassFence = { ...fence, passChanged: passFiles, helperDirs };
    const gate: FixPassFileGate = {
      id: plan.id,
      declared: plan.declared,
      admitter: admit,
      fence: judging,
      ...(admission === undefined ? {} : { corrective: admission }),
    };
    // The pre-pass delta, so "already changed by this cycle" is the pass's own
    // work and not a sibling pass's.
    const passDelta = new Set(s.value.names);
    for (const file of passFiles) {
      const verdict = await admitFixPassEntry(file, gate, passDelta.has(file));
      if (verdict.admitted) {
        if (verdict.note !== undefined) admissions.push(`${plan.id}: ${verdict.note}`);
        continue;
      }
      strays.push(verdict.stray);
    }
    if (strays.length > 0) {
      const basis =
        plan.declared.length > 0
          ? "its declared paths and the files the findings name"
          : "the files it already changed and the files the findings name";
      // #1846 — the revert path acts on this refusal, so the record carries what
      // it needs: WHICH workstream, WHICH files, and WHICH of them are untracked
      // (a file in no commit is removed by unlink, not by `git rm`). A stray
      // refused as `fenced` or `protected`, or any protected path in the set, is
      // deliberately NOT offered: those are the files no admission rule may lift,
      // and silently reverting one would take the protected-path gate's decision
      // away from it.
      const revertible = strays.every((s) => s.refused !== "fenced" && s.refused !== "protected");
      return {
        reason: strayReason(plan, strays, basis),
        diffs,
        admissions,
        ...(revertible ? { straysFor: plan.id, strays, untracked: s.value.untracked } : {}),
      };
    }
    if (plan.declared.length > 0) {
      // #1725 round 3 — the ceiling grows by the number of distinct ADMITTING
      // SLOTS, never by the number of admitted files: one slot is one
      // authorisation (each capped at SPEC_SLOT_MAX_FILES inside the
      // admitter), so a workstream cannot multiply a single slot into an
      // unbounded ceiling. The numerator keeps every file the pass changed;
      // the park reason reports the denominator ACTUALLY used — declared
      // paths and admitting slots separately, because "9 files, 2 slots
      // authorised" is a different disclosure from "9 files".
      const slots = admit.admittedSlotCount(plan.id);
      const admittedList = admit.admittedFiles(plan.id);
      const limit = fanoutLimitFor(plan.declared.length + slots);
      // The NUMERATOR excludes a test the coupled-test route admitted. The
      // ceiling bounds how far a pass may WANDER from its declared scope, and a
      // test that proves the pass's own fix is the opposite of wandering — the
      // route exists precisely so a fix lands with its test. Charging the
      // ceiling for it parked passes in which every single file had been asked
      // for, and it punished exactly the behaviour the route was built to
      // encourage. Files admitted by any OTHER route still count.
      const counted = s.value.names.filter((f) => !coupledTestAdmitted(f, judging));
      if (counted.length > limit) {
        return {
          reason: `${plan.id} changed ${counted.length} files (${admittedList.length} of them admitted by ${slots} spec pattern slot(s): ${listed(admittedList)}) — over the fan-out limit ${limit} for its ${plan.declared.length} declared path(s) plus ${slots} admitting slot(s)`,
          diffs,
          admissions,
        };
      }
    }
  }
  return { diffs, admissions };
}

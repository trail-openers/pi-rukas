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
    });
  }
  return { ok: true, value: plans };
}

/**
 * The workstreams as the develop step sees them for this pass: declared paths
 * plus the named widening, and the findings the developer must resolve. Only
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
    out[plan.id] = orig
      ? { ...orig, paths, fixFindings: plan.findings }
      : { id: plan.id, scope: "", paths, outOfScope: [], fixFindings: plan.findings };
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
}

const allows = (entry: string, file: string): boolean =>
  file === entry || (entry.endsWith("/") && file.startsWith(entry));

/**
 * Does a FENCE entry cover `file`? The ONE fence predicate answers it
 * (#1725 round 3): `fenceMatches` is the same function the develop gate's
 * outOfScope blocking check and the admitter's `isFenced` run, so a fence
 * entry — `dir/**`, `dir/** (note)`, backticked markup, or a real glob like
 * `src/*.test.ts` — cannot refuse this fence and pass that gate. The two
 * fences used to read one entry through two grammars (`fenceDirPrefix` + a
 * `/` boundary here, a normalise-then-compare there); two answers from one
 * entry is the drift this closes. The exact-or-trailing-slash `allows()`
 * above still cannot answer this question: it reads `dir/**` as a literal
 * path, so a fenced directory failed to beat a spec slot and the slot
 * silently unfenced a fence the plan wrote on purpose.
 */
const fencedBy = (entry: string, file: string): boolean => fenceMatches(entry, file);

/**
 * A declared path may carry a planner annotation (`"src/a.ts (new)"`) or a
 * `./` prefix; the ONE entry-path reading in `work-driver-declared-path` strips
 * it, so a `./` path neither false-parks nor fails to widen a directory anchor.
 */
const cleaned = entryPath;

/**
 * #1557 / #1725 — does a spec deliverable's pattern slot admit `file`?
 *
 * The fence is judged FIRST, and it beats the slot: a fence the plan wrote
 * wins over a spec pattern, or a spec could unfence itself. The predicate is
 * passed INTO the shared admitter (`isFenced`), which refuses a fenced file
 * itself with kind `fenced` — so the fence question has ONE answer per
 * (entry, file) even if a future caller forgets to pre-check, and both gates
 * read it through `fenceMatches` (#1725 round 3; the old exact-or-trailing-
 * slash reading matched nothing for `extension/src/**`, so a slot silently
 * UNFENCED a directory the plan fenced on purpose — the HIGH finding).
 * The protected-path refusal, the per-workstream scope check and the per-slot
 * file cap are the shared admitter's too, so the develop gate and this fence
 * cannot drift on any of them; the returned `Admission` names the kind that
 * refused, and the park reason carries it.
 */
function specAdmitsFile(admit: SpecAdmitter, plan: PassPlan, file: string): Admission {
  return admit.admit(plan.id, file, plan.declared);
}

/**
 * The refusals that OUTRANK the corrective round, stated positively: each is a
 * guard's decision, not an absence. `fenced` is the fence the PLAN wrote and
 * `protected` is the protected-path gate's call — a round the driver dispatched
 * cannot unfence a path on purpose, and it certainly cannot reach a protected
 * path. `no-slot` and `slot-full` are NOT here: they say the spec never mentioned
 * the file, which is exactly the gap the corrective round exists to close.
 */
const CORRECTIVE_PRECEDES = ["fenced", "protected"] as const satisfies readonly AdmissionRefusal[];

/** May the corrective round be asked about a file this refusal covered? */
function outranksCorrective(refused: AdmissionRefusal): boolean {
  return (CORRECTIVE_PRECEDES as readonly AdmissionRefusal[]).includes(refused);
}

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
    const allowed =
      plan.declared.length > 0
        ? [...plan.declared.map(cleaned), ...plan.named]
        : [...plan.before.names, ...plan.named];
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
    const strays: Stray[] = [];
    for (const file of s.value.names) {
      if (allowed.some((a) => allows(a, file))) continue;
      const decision = specAdmitsFile(admit, plan, file);
      if (decision.admitted) continue;
      // The corrective route is reached only when the shared admitter's
      // precedence-bearing refusals did not fire — see {@link CORRECTIVE_PRECEDES}
      // — and then through ONE entry point, which judges the evidence, the
      // provenance, the anchor, the window and the cap in its own order.
      if (admission !== undefined && !outranksCorrective(decision.refused)) {
        const verdict = await admission.tryAdmit(file);
        if (verdict.admitted) {
          admissions.push(`${plan.id}: ${verdict.note}`);
          continue;
        }
        strays.push({ file, refused: decision.refused, correctiveNote: verdict.note });
        continue;
      }
      strays.push({ file, refused: decision.refused });
    }
    if (strays.length > 0) {
      const basis =
        plan.declared.length > 0
          ? "its declared paths and the files the findings name"
          : "the files it already changed and the files the findings name";
      return { reason: strayReason(plan, strays, basis), diffs, admissions };
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
      const counted = s.value.names;
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

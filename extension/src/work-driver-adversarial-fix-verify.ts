import { type FixExec, type TreeChanges, treeChanges } from "./work-driver-adversarial-fix-git.ts";
import { unchangedPlans } from "./work-driver-adversarial-fix-noop.ts";
import type { PassPlan } from "./work-driver-adversarial-fix-scope.ts";
import {
  type CorrectiveAdmission,
  correctiveRoundFor,
  createCorrectiveAdmission,
} from "./work-driver-corrective-admission.ts";
import { fenceMatches } from "./work-driver-declared-path.ts";
import {
  type FixPassFence,
  fixPassHelperDirs,
  gateFenceView,
} from "./work-driver-fix-pass-admission.ts";
import { type FixPassFileGate, admitFixPassEntry } from "./work-driver-fix-pass-admit-file.ts";
import { passFanoutRefusal } from "./work-driver-fix-pass-ceiling.ts";
/**
 * work-driver-adversarial-fix-verify — the post-pass scope check for an
 * adversarial / lens-fix fix pass, split from
 * `work-driver-adversarial-fix-scope.ts` for the AGENTS.md §12 500-line gate
 * (which measures whole files, so splitting is the fix, not compressing the
 * reasoning that lives in them).
 *
 * `planFixPass` and `postPassFault` are two halves of one rule and must be read
 * together, so they stay in one file: the pre-pass reads build the `PassPlan`
 * the post-pass refuses with, and a file admitted on a route the plan did not
 * compute is exactly the drift #1725 round 3 removed. What moved here is
 * therefore the *consumer* half, together with the `PostPass` shape it returns —
 * the pre-pass half (`planFixPass` / `overlayWorkstreams`) and the shared
 * `PassPlan` / `FixRequest` shapes stay with the module that defines them, and
 * this file imports them. Nothing in either file re-derives what the other owns.
 */
import { type Stray, strayReason } from "./work-driver-fix-pass-park-reason.ts";
import {
  type SpecPatternSlot,
  admissionNote,
  createSpecAdmitter,
} from "./work-driver-spec-slot-admission.ts";
import type { CorrectiveRoundEvent } from "./workflow-state-events-corrective.ts";

/** The result of the post-pass checks — everything the caller needs to act on. */
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
 * whole fence now goes through `plan.fence` / `admitFixPassEntry`.
 */
const fencedBy = (entry: string, file: string): boolean => fenceMatches(entry, file);

const fenced = (reason: string): { ok: false; reason: string } => ({
  ok: false,
  reason: `scope could not be verified: ${reason}`,
});

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
  /**
   * #1852 — skip the no-op check. It exists for the FIX PASS, whose whole point
   * is that the tree must differ from what the pass found: `plan.before` is
   * `treeChanges(worktree, baseSha)`, so "byte-identical" means the pass changed
   * nothing. A LENS FIX has the opposite shape — it is dispatched from a tip the
   * cycle already reached, so `plan.before` and the post-pass read are identical
   * BY CONSTRUCTION whenever the fixer's work is one commit at the tip, and the
   * check would refuse every lens fix that actually fixed something. The lens-fix
   * gate therefore measures its own delta (`committedChanges(roundTip, head)` plus
   * the tree's changes) and asks this function only the scope question.
   */
  opts: { noOp?: boolean } = {},
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
  const unchanged = opts.noOp === true ? [] : unchangedPlans(plans, after);
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
    //
    // #1849 item 9 — this is the ONE denominator for BOTH consumers: the ladder
    // below and the fan-out ceiling at the end of this iteration. The ceiling used
    // to take a separate `s.value.names` read, i.e. this set minus the untracked
    // files, so a pass that wandered into untracked files did not count against
    // the ceiling the fence had just been enforced with — one rule bounding a
    // smaller set than the one it was paired with is two rules.
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
    const admission: CorrectiveAdmission | undefined = round
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
    //
    // #1846 — the helper route's anchor files, and the one ceiling's numerator
    // (`passChanged`): everything this pass changed, from every route, against
    // ONE denominator (PM decision #1846-3). The gate view is built once per pass
    // by `gateFenceView` below and every file of the post-pass tree is put through
    // `admitFixPassEntry` — the whole route ladder lives there with its precedence
    // stated in one place.
    const helperDirs = fixPassHelperDirs(
      plan.declared,
      plan.findings,
      plan.named,
      plan.dirs,
      round !== undefined,
    );
    // #1849 item 9 — the slot term is read ONCE, before the view is built, and
    // feeds both surfaces that bound this pass: the helper route's ceiling (in
    // `gateFenceView`) and the pass-level ceiling check at the end of the
    // iteration. Before this, the ladder was handed the PLAN-TIME `ceiling`, which
    // `planFixPass` necessarily computed with zero admitting slots (a slot admits a
    // file only once the pass runs), while the pass-level check derived
    // `fanoutLimitFor(declared + counted)` — so a pass whose spec authorised a
    // pattern slot was refused a helper file by a ceiling the pass-level check had
    // already widened. Two rules bounding one pass, which is what decision #1846-3
    // removed. `ceiling` is derived inside `fixPassFence`, so it is re-derived
    // rather than assigned.
    const judging: FixPassFence = gateFenceView(
      fence,
      passFiles,
      helperDirs,
      admit.admittedSlotCount(plan.id),
    );
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
    const strays: Stray[] = [];
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
      const revertible = strays.every((x) => x.revertible);
      return {
        reason: strayReason(plan, strays, basis),
        diffs,
        admissions,
        ...(revertible ? { straysFor: plan.id, strays, untracked: s.value.untracked } : {}),
      };
    }
    // One ceiling over every route; its two easy-to-get-wrong rules (per-slot
    // denominator, coupled tests out of the numerator) are stated in
    // `work-driver-fix-pass-fanout.ts`, and the reason the slot term comes off
    // `judging` rather than the admitter is stated in
    // `work-driver-fix-pass-ceiling.ts`. The numerator is `passFiles` — the ONE
    // denominator this iteration computed, shared with the ladder above (#1849
    // item 9).
    const refusal = passFanoutRefusal(
      plan.id,
      plan.declared,
      passFiles,
      judging,
      admit.admittedFiles(plan.id),
    );
    if (refusal !== undefined) return { reason: refusal, diffs, admissions };
  }
  return { diffs, admissions };
}

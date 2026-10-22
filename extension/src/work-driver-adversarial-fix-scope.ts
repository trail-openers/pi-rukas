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

import path from "node:path";
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
  type CorrectiveRound,
  correctiveRoundFor,
  createCorrectiveAdmission,
} from "./work-driver-corrective-admission.ts";
import { fenceMatches } from "./work-driver-declared-path.ts";
import { protectedPathsIn } from "./work-driver-doctrine.ts";
import { fanoutLimitFor } from "./work-driver-scope-fanout.ts";
import {
  type Admission,
  type AdmissionRefusal,
  SPEC_SLOT_MAX_FILES,
  type SpecAdmitter,
  type SpecPatternSlot,
  admissionNote,
  createSpecAdmitter,
  specPatternSlots,
} from "./work-driver-spec-slot-admission.ts";
import { verifyTimeoutMs } from "./work-driver-verify-budget.ts";
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
}

/** The directory a repo-relative path lives in ("" at the root). */
function dirOfPath(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
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
  const dirs = new Set(
    anchors
      .map((a) => {
        const c = cleaned(a);
        return c.endsWith("/") ? c.slice(0, -1) : dirOfPath(c);
      })
      .filter((d) => d !== ""),
  );
  return [...new Set(candidates)].filter(
    (p) => protectedPathsIn([p]).length === 0 && dirs.has(dirOfPath(p)) && pathTokenIn(findings, p),
  );
}

function pathTokenIn(text: string, p: string): boolean {
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w./-])${escaped}(?![\\w/-]|\\.\\w)`).test(text);
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
    const declared = (ps.workstreams?.[p.workstreamId]?.paths ?? []).map(cleaned);
    // Widening anchors: the declared fence, and what the workstream already changed.
    // Widening candidates: tracked at base OR already changed by this cycle.
    const named = namedPaths(
      p.findings,
      [...tracked.value, ...cycle.value],
      [...declared, ...before.value.names],
    );
    plans.push({
      id: p.workstreamId,
      worktree,
      findings: p.findings,
      headBefore: head.value,
      before: before.value,
      declared,
      named,
      widened: declared.length > 0 ? named.filter((x) => !declared.includes(x)) : [],
      outOfScope: (ps.workstreams?.[p.workstreamId]?.outOfScope ?? []).map(cleaned),
      specSlots,
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
 * `./` prefix; normalised to the repo-relative form git emits, so a `./` path
 * neither false-parks nor fails to widen a directory anchor.
 */
const cleaned = (p: string): string =>
  path.posix.normalize(p.replace(/\s+\([^)]*\)$/, "").trim()).replace(/^\.\/+/, "");

const listed = (xs: readonly string[]): string => (xs.length > 0 ? xs.join(", ") : "none");

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
 * #1522 — the scope-fence park names the fence it checked (both sets), what
 * the findings said about each stray, where the change sits and how to clear
 * it. The bare clause left the operator to rebuild all of that from the state.
 */
function strayReason(plan: PassPlan, strays: readonly Stray[], basis: string): string {
  const fence =
    plan.declared.length > 0
      ? `declared paths: ${listed(plan.declared)}`
      : `files it already changed: ${listed(plan.before.names)}`;
  // #1522 — the park names every fence it checked, so the spec slots the pass
  // also honoured belong in the disclosure: without them an operator reading a
  // refusal for a *different* file cannot tell what the spec authorised.
  const spec = `spec pattern slots it admits: ${listed(plan.specSlots.map((s) => s.glob))}`;
  // #1725 round 3 — the refusal KIND rides the park reason: "why is this file
  // outside?" must be answerable from the handoff alone. `slot-full` tells the
  // operator the slot spent its file budget (re-split under another declared
  // location, or re-plan), instead of leaving the file's fate a mystery.
  const WHY: Record<AdmissionRefusal, string> = {
    fenced: "it sits behind this workstream's outOfScope fence, which the spec does not lift",
    protected: "it is a protected path — the protected-path gate owns that decision",
    "no-slot": "no spec pattern slot matches it",
    "slot-full": `the matching slot has already admitted its ${SPEC_SLOT_MAX_FILES} files — one slot is a bounded authorisation, not a skeleton key`,
  };
  const naming = strays
    .map((s) => {
      // #1698(b) — a corrective round named the file but the admission did not
      // hold; its own reason is more specific than the slot's, so it reads
      // first. Everything else takes the shared `WHY` clause: ONE source for
      // each refusal text, including `no-slot`.
      const why = s.correctiveNote ?? WHY[s.refused];
      return pathTokenIn(plan.findings, s.file)
        ? `A finding names ${s.file}, but it does not widen the fence (a named file widens only when it is tracked at base or already changed by this cycle, unprotected, and in the directory of a declared or already-changed non-root path); ${why}`
        : `No finding names ${s.file} — ${why}`;
    })
    .join("; ");
  const files = strays.map((s) => s.file).join(", ");
  return `${plan.id} changed ${files} — outside ${basis} (${fence}; ${spec}; finding-named files it admits: ${listed(plan.named)}). ${naming}. The change is still in ${plan.worktree}. To clear it: if a finding's fix needs ${files}, the declared scope is what is wrong — name ${files} in the issue's scope and re-run \`/work <issue> --restart\`; otherwise the pass overreached — revert ${files} in that worktree and land the rest by hand, or re-run \`/work <issue> --restart\``;
}

/**
 * #1698(b) — the corrective admission lives in its own module
 * (`work-driver-corrective-admission.ts`): its target set, its commit window,
 * its cap and its disclosure. The fence asks it the three questions in order
 * and keeps the guard order the shared admitter owns (fence → protected).
 */

/** What one stray file's refusal actually said, beyond the shared `WHY` table. */
interface Stray {
  file: string;
  refused: AdmissionRefusal;
  /** Set when a corrective round named the file but could not admit it. */
  correctiveNote?: string;
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
 * per workstream are capped at `CORRECTIVE_ADMIT_MAX`, and a round with no
 * usable `headAtRound` admits nothing.
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
    // #1698(b) — this workstream's corrective round: its own target set, its
    // post-round commit window, its cap and its disclosure all live in
    // work-driver-corrective-admission.ts. The FENCE still outranks it: the
    // shared admitter is asked first and a `fenced` / `protected` refusal is
    // final, so the round can never unfence a path the plan fenced.
    const admission = createCorrectiveAdmission(
      execFn,
      correctiveRoundFor(corrective, plan.id),
      plan.worktree,
      verifyTimeoutMs(),
    );
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
      // The corrective route is reached only for a file the round's own
      // evidence names, and only when the shared admitter's precedence-bearing
      // refusals did not fire: `fenced` and `protected` are answers the fence
      // and the protected-path gate own, and a round cannot override either.
      if (
        decision.refused !== "fenced" &&
        decision.refused !== "protected" &&
        admission.names(file)
      ) {
        const note = await admission.refusal(file);
        if (note === undefined) {
          admissions.push(admission.admit(plan.id, file));
          continue;
        }
        strays.push({ file, refused: decision.refused, correctiveNote: note });
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

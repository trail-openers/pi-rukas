/**
 * work-driver-adversarial-fix-scope — the fence an adversarial fix pass runs
 * under (#1114). Fails closed: every read the fence needs either succeeds or
 * becomes a named park reason, and nothing falls back to repoRoot or to an
 * empty set. The widened scope lives in an overlay the develop step receives
 * as a parameter; it is never written into the persisted pipeline state.
 *
 * Widening is bounded by three conditions, and only these: a finding-named path
 * widens the fence when it is tracked at base, not protected per
 * `protectedPathsIn` (the single source of protected paths), and in the same
 * non-root directory as a declared or already-changed path. There is no list of
 * project-specific modules: the /work driver runs on other repositories too. A
 * driver module is therefore no more editable in a fix pass than on a first
 * develop pass, which has the same fence and the same gates.
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
import { trace } from "./trace.ts";
import {
  type FixExec,
  type GitRead,
  type TreeChanges,
  headOf,
  trackedPaths,
  treeChanges,
} from "./work-driver-adversarial-fix-git.ts";
import { protectedPathsIn } from "./work-driver-doctrine.ts";
import { fanoutLimitFor } from "./work-driver-scope-fanout.ts";
import {
  type SpecPatternSlot,
  specPatternSlots,
  specSlotAdmitting,
} from "./work-driver-spec-slot-admission.ts";
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
  /** Tracked, unprotected paths a finding names in an anchor's directory (see namedPaths). */
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
 * a finding-named path qualifies only if it is (a) tracked at base, (b) not
 * protected per `protectedPathsIn` (the single source of protected paths), and
 * (c) in the same directory as an anchor — a declared path or a file the
 * workstream already changed. A directory entry (`src/foo/`) is its own
 * directory. The repo root is not an anchor: a root-level anchor would make every
 * root file widenable. Named as a whole path token (`data.txt` does not name `a.txt`).
 */
export function namedPaths(
  findings: string,
  tracked: readonly string[],
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
  return tracked.filter(
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
    const declared = (ps.workstreams?.[p.workstreamId]?.paths ?? []).map(cleaned);
    // Widening anchors: the declared fence, and what the workstream already changed.
    const named = namedPaths(p.findings, tracked.value, [...declared, ...before.value.names]);
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
}

const allows = (entry: string, file: string): boolean =>
  file === entry || (entry.endsWith("/") && file.startsWith(entry));

/**
 * A declared path may carry a planner annotation (`"src/a.ts (new)"`) or a
 * `./` prefix; normalised to the repo-relative form git emits, so a `./` path
 * neither false-parks nor fails to widen a directory anchor.
 */
const cleaned = (p: string): string =>
  path.posix.normalize(p.replace(/\s+\([^)]*\)$/, "").trim()).replace(/^\.\/+/, "");

const listed = (xs: readonly string[]): string => (xs.length > 0 ? xs.join(", ") : "none");

/**
 * #1557 — does a spec deliverable's pattern slot admit `file`? Two things
 * still refuse it, in this order, and they belong to THIS fence rather than to
 * the matcher: the workstream's own `outOfScope` fence (a fence the plan wrote
 * beats a spec slot — otherwise a spec could unfence itself), and a protected
 * path (the protected-path gate must halt the cycle, and admitting the file
 * here would only rename that halt as a scope pass). Then, and only then, the
 * segment-anchored slot matcher answers.
 */
function specAdmitsFile(plan: PassPlan, file: string): SpecPatternSlot | undefined {
  if (plan.outOfScope.some((entry) => allows(entry, file))) return undefined;
  if (protectedPathsIn([file]).length > 0) return undefined;
  return specSlotAdmitting(plan.specSlots, file);
}

/**
 * #1522 — the scope-fence park names the fence it checked (both sets), what
 * the findings said about each stray, where the change sits and how to clear
 * it. The bare clause left the operator to rebuild all of that from the state.
 */
function strayReason(plan: PassPlan, strays: readonly string[], basis: string): string {
  const fence =
    plan.declared.length > 0
      ? `declared paths: ${listed(plan.declared)}`
      : `files it already changed: ${listed(plan.before.names)}`;
  // #1522 — the park names every fence it checked, so the spec slots the pass
  // also honoured belong in the disclosure: without them an operator reading a
  // refusal for a *different* file cannot tell what the spec authorised.
  const spec = `spec pattern slots it admits: ${listed(plan.specSlots.map((s) => s.glob))}`;
  const naming = strays
    .map((f) =>
      pathTokenIn(plan.findings, f)
        ? `A finding names ${f}, but it does not widen the fence (a named file widens only when it is tracked at base, unprotected, and in the directory of a declared or already-changed non-root path)`
        : `No finding names ${f}`,
    )
    .join("; ");
  const files = strays.join(", ");
  return `${plan.id} changed ${files} — outside ${basis} (${fence}; ${spec}; finding-named files it admits: ${listed(plan.named)}). ${naming}. The change is still in ${plan.worktree}. To clear it: if a finding's fix needs ${files}, the declared scope is what is wrong — name ${files} in the issue's scope and re-run \`/work <issue> --restart\`; otherwise the pass overreached — revert ${files} in that worktree and land the rest by hand, or re-run \`/work <issue> --restart\``;
}

/**
 * The post-pass checks, in order: the pass changed something, every file it
 * changed is allowed (uncommitted and untracked included), and a declared
 * fence stays within its fan-out ceiling. The ceiling is computed from the
 * DECLARED paths, not the widened list — and files a spec pattern slot admits
 * count as declared for it (#1557): the ceiling bounds what the workstream
 * invented, not what the spec authorised.
 */
export async function postPassFault(
  execFn: FixExec,
  plans: readonly PassPlan[],
  baseSha: string,
): Promise<PostPass> {
  const diffs: Record<string, string> = {};
  const after: TreeChanges[] = [];
  for (const plan of plans) {
    const r = await treeChanges(execFn, plan.worktree, baseSha);
    if (!r.ok) return { reason: fenced(r.reason).reason, diffs };
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
    };
  }
  for (const plan of plans) {
    const s = await treeChanges(execFn, plan.worktree, plan.headBefore);
    if (!s.ok) return { reason: fenced(s.reason).reason, diffs };
    const allowed =
      plan.declared.length > 0
        ? [...plan.declared.map(cleaned), ...plan.named]
        : [...plan.before.names, ...plan.named];
    // #1557 — a new file the spec's pattern slot authorises is in scope
    // exactly as a declared path is; the finding-named widening could never
    // have seen it (`namedPaths` reads the tree tracked AT base, and a file
    // this pass created is not in it). One trace line per admitted path: a
    // fence that widened silently is a fence nobody can audit.
    const strays: string[] = [];
    const specAdmitted = new Set<string>();
    for (const file of s.value.names) {
      if (allowed.some((a) => allows(a, file))) continue;
      const slot = specAdmitsFile(plan, file);
      if (!slot) {
        strays.push(file);
        continue;
      }
      specAdmitted.add(file);
      trace(
        `work-driver: fix pass ${plan.id} admitted ${file} — the spec's deliverable ${slot.deliverableId} declares the pattern slot ${slot.slot}`,
      );
    }
    if (strays.length > 0) {
      const basis =
        plan.declared.length > 0
          ? "its declared paths and the files the findings name"
          : "the files it already changed and the files the findings name";
      return { reason: strayReason(plan, strays, basis), diffs };
    }
    if (plan.declared.length > 0) {
      const limit = fanoutLimitFor(plan.declared.length);
      const counted = s.value.names.filter((f) => !specAdmitted.has(f));
      if (counted.length > limit) {
        return {
          reason: `${plan.id} changed ${counted.length} files — over the fan-out limit ${limit} for its ${plan.declared.length} declared path(s)`,
          diffs,
        };
      }
    }
  }
  return { diffs };
}

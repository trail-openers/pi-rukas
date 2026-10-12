/**
 * work-driver-adversarial-fix-scope — the fence an adversarial fix pass runs
 * under (#1114). Fails closed: every read the fence needs either succeeds or
 * becomes a named park reason, and nothing falls back to repoRoot or to an
 * empty set. The widened scope lives in an overlay the develop step receives
 * as a parameter; it is never written into the persisted pipeline state.
 */

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
}

/** The directory a repo-relative path lives in ("" at the root). */
function dirOfPath(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/**
 * The driver's own gate modules (verify, verdict, retention, marker parsing).
 * They share `extension/src/` with ordinary code, so the directory rule alone
 * would let a finding widen a fence onto them. Never widenable.
 */
const DRIVER_OWNED =
  /^extension\/src\/(work|adversarial|comment-|reply-markers|review-threshold|lens-)/;
const driverOwned = (p: string): boolean => DRIVER_OWNED.test(p);

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
    (p) =>
      protectedPathsIn([p]).length === 0 &&
      !driverOwned(p) &&
      dirs.has(dirOfPath(p)) &&
      pathTokenIn(findings, p),
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
    const declared = ps.workstreams?.[p.workstreamId]?.paths ?? [];
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

/** A declared path may carry a planner annotation (`"src/a.ts (new)"`). */
const cleaned = (p: string): string => p.replace(/\s+\([^)]*\)$/, "").trim();

/**
 * The post-pass checks, in order: the pass changed something, every file it
 * changed is allowed (uncommitted and untracked included), and a declared
 * fence stays within its fan-out ceiling. The ceiling is computed from the
 * DECLARED paths, not the widened list.
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
    const strays = s.value.names.filter((f) => !allowed.some((a) => allows(a, f)));
    if (strays.length > 0) {
      const basis =
        plan.declared.length > 0
          ? "its declared paths and the files the findings name"
          : "the files it already changed and the files the findings name";
      return { reason: `${plan.id} changed ${strays.join(", ")} — outside ${basis}`, diffs };
    }
    if (plan.declared.length > 0) {
      const limit = fanoutLimitFor(plan.declared.length);
      if (s.value.names.length > limit) {
        return {
          reason: `${plan.id} changed ${s.value.names.length} files — over the fan-out limit ${limit} for its ${plan.declared.length} declared path(s)`,
          diffs,
        };
      }
    }
  }
  return { diffs };
}

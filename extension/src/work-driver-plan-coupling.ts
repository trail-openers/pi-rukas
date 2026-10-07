/**
 * work-driver-plan-coupling — #1005: detect coupled workstreams after
 * planning and before develop starts, and merge them.
 *
 * The invariant (#1005): **every workstream, applied alone to its base
 * commit, passes all of the project's quality gates.** A combined run that
 * passes does not excuse a workstream that fails on its own. The split
 * pressure the planning prompt used to carry ("bias toward MORE workstreams")
 * put coupled halves — a type change and every place that uses it — into
 * separate worktrees that could not each pass the gate. The merge here is the
 * deterministic backstop for when the prompt doctrine is not enough: the
 * planner splits two halves that the driver can see are coupled, and the
 * driver merges them before a single developer is dispatched.
 *
 * Two workstreams are COUPLED when ANY of the following hold:
 *
 *   1. Their file lists overlap (Jaccard ≥ 0.5, the same measure grouping R2
 *      uses in work-driver-grouping.ts). A Jaccard of 0.5 or more means the
 *      two workstreams share enough of their declared files that running them
 *      independently would put the same code in two worktrees that cannot
 *      see each other's commits.
 *
 *   2. One is declared as depending on the other (`dependsOn`). This is the
 *      explicit case: the planner said "B builds on A", which means B cannot
 *      pass its own gate without A's commit.
 *
 *   3. A symbol from one workstream's files is referenced in the other's
 *      (driver-native grep via `grep -l -w`, argv form — the planner's
 *      paths are data, never shell arguments). This is the implicit case:
 *      the planner did not declare a dependency, but the code says the two
 *      halves are coupled. A false positive (a shared utility name that is
 *      genuinely independent) is harmless — the merge is the safe direction,
 *      and the acceptance criterion "genuinely separate work is still split"
 *      is protected by requiring the symbol to appear in BOTH workstreams'
 *      files, not just one.
 *
 * The merge reuses the shared fold (workstream-fold.ts, the same helper the
 * MAX_WORKSTREAMS ceiling fold and the develop fence merge-and-retry use):
 * union of paths, union of outOfScope MINUS the merged paths (the absorbed
 * half's files are now the merged workstream's own scope — keeping them in
 * the fence would self-fence it), scope annotated, dependsOn re-pointed.
 *
 * The function is idempotent: running it twice on the same input returns the
 * same output (a second pass finds no more coupled pairs to merge).
 */

import { trace } from "./trace.ts";
import type { Workstream } from "./workflow-state-schema.ts";
import { foldWorkstream } from "./workstream-fold.ts";

/**
 * The workstream shape the coupling check inspects — `Workstream` (the
 * schema type), so the merge result is a `Record<string, Workstream>` and
 * the callers keep their types without a cast that hides field loss.
 */
export type CouplingWorkstream = Workstream;

/**
 * The result of a coupling pass: the merged workstreams map and a list of
 * merge actions (each names the workstream that was absorbed, the workstream
 * it was merged into, and the reason — used for the event log and the trace
 * line the operator can see in the transcript).
 */
export interface CouplingResult {
  /** The merged workstreams map (a new object; the input is not mutated). */
  workstreams: Record<string, CouplingWorkstream>;
  /** The merge actions taken (empty when no coupling was found). */
  merges: Array<{
    into: string;
    from: string;
    reason: string;
  }>;
  /** True when at least one merge was performed. */
  changed: boolean;
}

/** #1005 — the argv-form grep seam (planner-controlled paths, no shell). */
type GrepExecFn = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; argv?: string[] },
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * Jaccard overlap of two path sets (same measure as grouping R2 in
 * work-driver-grouping.ts:271). Returns 0 when either set is empty.
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const p of a) {
    if (b.has(p)) inter++;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Determine whether two workstreams are coupled by rules 1–2. Returns a
 * reason string when coupled, undefined when independent (rule 3, which
 * needs the exec seam, is checked in `mergeCoupledWorkstreams`).
 */
function couplingReason(a: CouplingWorkstream, b: CouplingWorkstream): string | undefined {
  // Rule 1 — file overlap (Jaccard ≥ 0.5).
  const setA = new Set(a.paths.map((p) => p.trim()).filter(Boolean));
  const setB = new Set(b.paths.map((p) => p.trim()).filter(Boolean));
  const j = jaccard(setA, setB);
  if (j >= 0.5) {
    return `file overlap (jaccard=${j.toFixed(2)} ≥ 0.5): shared files — the two halves would be developed in separate worktrees that cannot see each other's commits`;
  }
  // Rule 2 — the explicit depends-on edge. The reason names the ACTUAL
  // directed edge (a → b or b → a), not every dependsOn entry in the
  // two-workstream union (the pre-#1005 wording printed both halves'
  // complete dependsOn lists, so a pair coupled by a→b read as
  // "a, b, c" when a also depended on c).
  const edge: [string, string] | undefined = (a.dependsOn ?? []).includes(b.id)
    ? [a.id, b.id]
    : (b.dependsOn ?? []).includes(a.id)
      ? [b.id, a.id]
      : undefined;
  if (edge) {
    return `explicit depends-on edge: ${edge[0]} → ${edge[1]} — one workstream is declared to build on the other, so it cannot pass its own gate without the other's commit`;
  }
  return undefined;
}

/**
 * #1005 — run the coupling check over the workstreams map. Merges coupled
 * pairs into a single workstream (the shared fold in workstream-fold.ts:
 * union of paths, outOfScope union minus the merged paths, scope annotated,
 * dependsOn re-pointed).
 *
 * The merge is one-pass: after merging A into B, the pass continues with the
 * remaining workstreams. This is safe because the merge is idempotent — a
 * second call on the result returns the same result (no more coupled pairs).
 *
 * `execFn` is the driver's exec function (for the symbol grep, rule 3).
 * When it is undefined (e.g. a test that only exercises rules 1 and 2),
 * rule 3 is skipped.
 */
export async function mergeCoupledWorkstreams(
  workstreams: Record<string, CouplingWorkstream>,
  execFn?: GrepExecFn,
): Promise<CouplingResult> {
  // Start with a copy; the input is not mutated.
  const ws: Record<string, CouplingWorkstream> = {};
  for (const [id, w] of Object.entries(workstreams)) {
    ws[id] = { ...w, paths: [...w.paths], outOfScope: [...w.outOfScope] };
  }
  const merges: CouplingResult["merges"] = [];
  const ids = Object.keys(ws);

  // Find coupled pairs; record each (absorbed workstream, reason) PAIR and
  // keep the absorbed half out of later pair checks. The folds themselves
  // are applied AFTER the pair loop (one fold per merge), so the pair loop
  // never reads a workstream that a fold already deleted: the absorbed
  // value is captured in the pair (the pre-#1005 apply-loop re-read it from
  // the original input after deleting it from the working copy — the M5
  // shape), and a fold reads the surviving half from the CURRENT map, so
  // chained folds (a absorbs b, then c folds into the union) compose
  // correctly.
  let wsMap: Record<string, CouplingWorkstream> = ws;
  const toMerge: Array<{
    into: string;
    from: string;
    absorbed: CouplingWorkstream;
    reason: string;
  }> = [];
  const mergedIds = new Set<string>();
  for (let i = 0; i < ids.length; i++) {
    const aId = ids[i] as string;
    const a = ws[aId];
    if (!a) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const bId = ids[j] as string;
      const b = ws[bId];
      if (!b) continue;
      if (mergedIds.has(aId) || mergedIds.has(bId)) continue;
      // Rule 1 and 2 (synchronous).
      let reason: string | undefined = couplingReason(a, b);
      // Rule 3 — symbol cross-reference (async). Only runs when execFn is
      // available and rules 1–2 did not already couple the pair.
      if (!reason && execFn) {
        reason = await symbolCrossReference(a, b, execFn);
      }
      if (reason) {
        toMerge.push({ into: aId, from: bId, absorbed: b, reason });
        mergedIds.add(bId);
        delete ws[bId];
        trace(`work-driver: plan coupling — merged ${bId} into ${aId}: ${reason}`);
      }
    }
  }

  if (toMerge.length === 0) {
    return { workstreams: ws, merges: [], changed: false };
  }

  // Apply the folds (the shared helper: union, fence minus merged paths,
  // scope annotation, dependsOn re-point of the surviving half AND of every
  // sibling that depended on the absorbed half). Each fold returns a NEW
  // map; the fold reads the surviving half from the CURRENT map, so chained
  // folds (a absorbs b, then c folds into the union) compose correctly.
  for (const m of toMerge) {
    wsMap = foldWorkstream(wsMap, m.into, m.from, m.absorbed);
  }

  return {
    workstreams: wsMap,
    merges: toMerge.map(({ into, from, reason }) => ({ into, from, reason })),
    changed: true,
  };
}

/**
 * Rule 3 — symbol cross-reference check. For each symbol name (a
 * workstream's path basenames, minus extension), greps the OTHER
 * workstream's declared files for a word-boundary occurrence:
 * `grep -l -w <name> <files…>`. A hit means the two workstreams share a
 * symbol and are coupled.
 *
 * The grep is ARGV-FORM (the `argv` seam on the exec function): the paths
 * are planner-controlled data, and a shell-built command would re-parse
 * them — a path containing `$(…)`, backticks or `;` would execute inside
 * the shell instead of being passed to grep verbatim (the H1 finding). In
 * argv form each path is ONE argument, passed to grep as-is; nothing is
 * evaluated.
 *
 * Bounded: at most 10 names and 10 files per workstream (the first 10
 * declared paths), word-boundary case-sensitive, 30-second timeout per
 * call (an unbounded grep over a huge worktree would otherwise hang the
 * plan step), and every failure is traced (an invisible rule-3 grep was
 * the M-timeout/LOW finding: a failing grep used to vanish in an empty
 * catch, indistinguishable from "no coupling").
 */
async function symbolCrossReference(
  a: CouplingWorkstream,
  b: CouplingWorkstream,
  execFn: GrepExecFn,
): Promise<string | undefined> {
  const basenames = (paths: string[]): string[] =>
    paths
      .map((p) => {
        const base = p.split("/").pop() ?? p;
        return base.replace(/\.[^.]+$/, "").trim();
      })
      .filter((s) => s.length >= 3) // skip very short names (false-positive prone)
      .slice(0, 10);

  const aNames = basenames(a.paths);
  const bNames = basenames(b.paths);

  const grepFor = async (
    name: string,
    files: string[],
    definer: string,
    referenced: string,
  ): Promise<string | undefined> => {
    if (files.length === 0) return undefined;
    try {
      const { stdout } = await execFn("grep", {
        argv: ["-l", "-w", "--", name, ...files],
        maxBuffer: 64 * 1024,
        timeout: 30_000,
      });
      if (stdout.trim().length > 0) {
        return `symbol cross-reference: '${name}' (defined in ${definer}) is referenced in ${referenced}'s files`;
      }
      return undefined;
    } catch (err) {
      // grep failed (file not found, timeout, missing binary) — not
      // evidence of coupling, but it is no longer invisible: the trace
      // line is what the operator sees in the transcript (the pre-#1005
      // catch was empty).
      trace(
        `work-driver: plan coupling rule 3 grep failed for '${name}' in ${referenced}'s files: ${(err as Error).message?.slice(0, 120)}`,
      );
      return undefined;
    }
  };

  // Check: does any symbol from A appear in B's files, or vice versa?
  for (const name of aNames) {
    if (bNames.includes(name)) continue; // same file in both — that's rule 1
    const hit = await grepFor(name, b.paths.slice(0, 10), a.id, b.id);
    if (hit) return hit;
  }
  for (const name of bNames) {
    if (aNames.includes(name)) continue;
    const hit = await grepFor(name, a.paths.slice(0, 10), b.id, a.id);
    if (hit) return hit;
  }
  return undefined;
}

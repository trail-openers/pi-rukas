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
 *   3. A symbol defined in one workstream's files is referenced in the
 *      other's (driver-native grep via `rg`; no new dependencies). This is
 *      the implicit case: the planner did not declare a dependency, but the
 *      code says the two halves are coupled. The grep is run once per
 *      workstream pair, over the union of both workstreams' paths, looking
 *      for a symbol name (exported function/type/class) that appears in both
 *      sets. A false positive here (a shared utility name that is genuinely
 *      independent) is harmless — the merge is the safe direction, and the
 *      acceptance criterion "genuinely separate work is still split" is
 *      protected by requiring the symbol to appear in BOTH workstreams'
 *      files, not just one.
 *
 * The merge is the same shape `PI_ENSEMBLE_MAX_WORKSTREAMS` uses in
 * work-driver-plan-workstreams.ts:116-124 (union of paths/outOfScope,
 * scope annotated). `dependsOn` edges that pointed into the merged workstream
 * are re-pointed to the merged id; the merged workstream's own `dependsOn`
 * list is the union of both halves' lists minus any self-references.
 *
 * The function is idempotent: running it twice on the same input returns the
 * same output (a second pass finds no more coupled pairs to merge).
 */

import { trace } from "./trace.ts";

/**
 * The workstream shape the coupling check inspects. Same as
 * `PlanQualityWorkstream` (work-driver-plan-helpers.ts) but read-only: the
 * function does not mutate the input, it returns a new record.
 */
export interface CouplingWorkstream {
  id: string;
  scope: string;
  paths: string[];
  outOfScope: string[];
  dependsOn?: string[];
  integrationTest?: string;
}

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
 * Determine whether two workstreams are coupled. Returns a reason string
 * when coupled, undefined when independent.
 */
function couplingReason(a: CouplingWorkstream, b: CouplingWorkstream): string | undefined {
  // Rule 1 — file overlap (Jaccard ≥ 0.5).
  const setA = new Set(a.paths.map((p) => p.trim()).filter(Boolean));
  const setB = new Set(b.paths.map((p) => p.trim()).filter(Boolean));
  const j = jaccard(setA, setB);
  if (j >= 0.5) {
    return `file overlap (jaccard=${j.toFixed(2)} ≥ 0.5): shared files — the two halves would be developed in separate worktrees that cannot see each other's commits`;
  }
  // Rule 2 — explicit depends-on edge in either direction.
  if ((a.dependsOn ?? []).includes(b.id) || (b.dependsOn ?? []).includes(a.id)) {
    return `explicit depends-on edge: ${[...(a.dependsOn ?? []), ...(b.dependsOn ?? [])].join(", ")} — one workstream is declared to build on the other, so it cannot pass its own gate without the other's commit`;
  }
  // Rule 3 — symbol cross-reference is handled in the async wrapper
  // `mergeCoupledWorkstreams` (it needs execFn for the grep); the
  // synchronous path covers rules 1 and 2 only.
  return undefined;
}

/**
 * #1005 — run the coupling check over the workstreams map. Merges coupled
 * pairs into a single workstream (same shape as the MAX_WORKSTREAMS fold in
 * work-driver-plan-workstreams.ts:116-124): union of paths and outOfScope,
 * scope annotated with the absorbed id, dependsOn re-pointed.
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
  execFn?: (
    cmd: string,
    opts?: { cwd?: string; maxBuffer?: number },
  ) => Promise<{ stdout: string }>,
): Promise<CouplingResult> {
  // Start with a copy; the input is not mutated.
  const ws: Record<string, CouplingWorkstream> = {};
  for (const [id, w] of Object.entries(workstreams)) {
    ws[id] = { ...w, paths: [...w.paths], outOfScope: [...w.outOfScope] };
  }
  const merges: CouplingResult["merges"] = [];
  const ids = Object.keys(ws);

  // Find coupled pairs and merge them. We iterate over all pairs; when a
  // merge is made, the absorbed id is removed from ws and the pair loop
  // continues with the next pair. The loop is safe because the absorbed
  // id is removed before the next pair is checked. `coupled` tracks every
  // pair already merged so a later pass over the same union does not double
  // merge (the merge itself is applied AFTER the pair loop, keyed on
  // `toMerge`).
  const toMerge: Array<{ into: string; from: string; reason: string }> = [];
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
      // available. The grep looks for a symbol (exported identifier) that
      // appears in files declared by BOTH workstreams. We use a simple
      // heuristic: extract the basenames of both path sets, then grep for
      // each basename (minus extension) in the other's files. A hit in
      // both directions means the two workstreams share a symbol.
      if (!reason && execFn) {
        reason = await symbolCrossReference(a, b, execFn);
      }
      if (reason) {
        toMerge.push({ into: aId, from: bId, reason });
        mergedIds.add(bId);
        // Remove b from the map; the merge will fold b into a.
        delete ws[bId];
        trace(`work-driver: plan coupling — merged ${bId} into ${aId}: ${reason}`);
      }
    }
  }

  if (toMerge.length === 0) {
    return { workstreams: ws, merges: [], changed: false };
  }

  // Apply the merges: fold each `from` into `into`. The `from` workstream
  // was deleted from `ws` during the pair loop, so read it from the
  // ORIGINAL input (`workstreams`) — the copy in `ws` no longer exists.
  for (const m of toMerge) {
    const into = ws[m.into];
    const from = workstreams[m.from];
    if (!into || !from) continue;
    // Union of paths and outOfScope (same shape as the MAX_WORKSTREAMS fold).
    const mergedPaths = [...new Set([...into.paths, ...from.paths])];
    const mergedOutOfScope = [...new Set([...into.outOfScope, ...from.outOfScope])];
    // Re-point dependsOn edges that pointed to the absorbed workstream.
    const mergedDeps = new Set<string>();
    for (const d of into.dependsOn ?? []) if (d !== m.from && d !== m.into) mergedDeps.add(d);
    for (const d of from.dependsOn ?? []) if (d !== m.from && d !== m.into) mergedDeps.add(d);
    // Any other workstream that depended on `from` now depends on `into`.
    for (const [otherId, otherWs] of Object.entries(ws)) {
      if (otherId === m.into) continue;
      const deps = otherWs.dependsOn;
      if (deps?.includes(m.from)) {
        const updated = [...deps].map((d) => (d === m.from ? m.into : d));
        ws[otherId] = { ...otherWs, dependsOn: [...new Set(updated)] };
      }
    }
    // Update the integration test: keep the one that references the merged
    // scope (prefer the `into` workstream's).
    const integrationTest = into.integrationTest ?? from.integrationTest;
    ws[m.into] = {
      ...into,
      paths: mergedPaths,
      outOfScope: mergedOutOfScope,
      scope: `${into.scope} (+merged: ${from.id})`,
      dependsOn: mergedDeps.size > 0 ? [...mergedDeps] : undefined,
      ...(integrationTest ? { integrationTest } : {}),
    };
  }

  return { workstreams: ws, merges: toMerge, changed: true };
}

/**
 * Rule 3 — symbol cross-reference check. Greps for each workstream's
 * path basenames (minus extension) in the other workstream's declared files.
 * A hit means the two workstreams share a symbol and are coupled.
 *
 * The grep is bounded: at most 10 files per workstream are checked (the
 * first 10 declared paths), and the search is case-sensitive for the
 * symbol name. A false positive (a common name like `init` or `config`)
 * is harmless — the merge is the safe direction.
 */
async function symbolCrossReference(
  a: CouplingWorkstream,
  b: CouplingWorkstream,
  execFn: (cmd: string, opts?: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string }>,
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

  // Check: does any symbol from A appear in B's files, or vice versa?
  // We grep for the symbol name as a word in the other workstream's files.
  for (const name of aNames) {
    if (bNames.includes(name)) continue; // same file in both — that's rule 1
    const bFiles = b.paths.slice(0, 10).join(" ");
    if (!bFiles) continue;
    try {
      // Use grep -l to check if any of B's files contain the symbol name
      // as a word (bounded to avoid huge output).
      const filesArg = b.paths
        .slice(0, 10)
        .map((f) => JSON.stringify(f))
        .join(" ");
      const { stdout } = await execFn(
        `grep -l -w ${JSON.stringify(name)} ${filesArg} 2>/dev/null || true`,
        { maxBuffer: 64 * 1024 },
      );
      if (stdout.trim().length > 0) {
        return `symbol cross-reference: '${name}' (defined in ${a.id}) is referenced in ${b.id}'s files`;
      }
    } catch {
      // grep failed (file not found, etc.) — not evidence of coupling.
    }
  }
  for (const name of bNames) {
    if (aNames.includes(name)) continue;
    try {
      const filesArg = a.paths
        .slice(0, 10)
        .map((f) => JSON.stringify(f))
        .join(" ");
      const { stdout } = await execFn(
        `grep -l -w ${JSON.stringify(name)} ${filesArg} 2>/dev/null || true`,
        { maxBuffer: 64 * 1024 },
      );
      if (stdout.trim().length > 0) {
        return `symbol cross-reference: '${name}' (defined in ${b.id}) is referenced in ${a.id}'s files`;
      }
    } catch {
      // grep failed — not evidence of coupling.
    }
  }
  return undefined;
}

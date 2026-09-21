/**
 * work-driver-scope-fanout — #285 develop scope/fanout gate.
 *
 * Extracted from work-driver-verify-develop.ts (file-size cap, AGENTS.md §12).
 *
 * Intentionally separate from the hollow-diff check: a changed worktree can
 * prove a developer wrote code while still showing the decomposition was too
 * broad. An empty paths list has no declared boundary, so preserve legacy
 * behaviour and report the skipped check rather than inventing one.
 *
 * #724 — FANOUT recalibration, derived from the recorded corpus (NOT
 * intuition). Method: replayed every develop-death cycle in the 52-file
 * `.pi/work-state/*.json` corpus (`.pi/work-state` schema v1, recorded
 * `verifyEvidence.failures` + `workstreams[].paths`), excluding the 10
 * pre-a6ed511 cycles whose counts reflect the three fixed derivation bugs.
 * Replay: for each recorded `scope fanout: N files changed vs M declared`
 * failure, N was the RAW changed count while the `Files:` list is the
 * undeclared count — the gate counted sibling-declared files against a
 * workstream that did not touch them (pre-#672 cumulative-union shape). On
 * the post-fix corpus, comparing the two counts gives:
 *   - 6 recorded fanout rejections (issues 602, 613, 654, 677 ×4) become
 *     passes: in every case the undeclared count is ≤ the old limit
 *     (e.g. #677: 3 undeclared < 6) — pure derivation artifacts.
 *   - 12 rejections stay failures with undeclared-only counts (e.g. #630:
 *     50/59; #679: 22-24/27-28 — a cohesive many-file driver refactor that
 *     legitimately exceeded even its plan-wide declared count).
 *   - #674 (18 raw / 15 undeclared vs 3 declared, limit 9) is the one case
 *     where a sibling (task-a) declared 14 of the 18 files. Sibling-declared
 *     files are therefore excluded from the NUMERATOR too — a file the plan
 *     assigned to a sibling is not this workstream's fanout, whatever the
 *     attribution — leaving 4 < 9, so #674 now passes. #679 keeps failing
 *     (undeclared-only 22 and 24 vs limit 15); that is correct: its
 *     undeclared files were genuinely beyond the plan (a cohesive many-file
 *     driver refactor that exceeded even its plan-wide declared count).
 * Env knobs PI_ENSEMBLE_SCOPE_GATE / _FANOUT_FACTOR / _FANOUT_MIN keep
 * identical semantics (factor × declared count vs floor).
 *
 * #725 — the fence's semantics on a dependsOn plan (documented decision):
 * a workstream's `outOfScope` fence is evaluated against THAT workstream's
 * own commits (the per-worktree diff against its effective base — see the
 * caller's diff-collection loop), and a hit is EXEMPTED when the fenced
 * path is declared in `paths` by a workstream in this one's `dependsOn`
 * list. The plan step deliberately cross-declares each workstream's
 * outOfScope to include the others' in-scope paths (#572 — a file appears
 * in exactly ONE workstream's paths and the OTHERS' outOfScope); that
 * contract is what keeps `findPathCollisions` (the structural "two
 * developers editing the same file" check) firing for genuinely independent
 * workstreams, so the plan step keeps cross-declaring and the fence honours
 * it. A dependent workstream's worktree is created FROM its dependency's
 * post-commit SHA (#679), so the dependency's files are legitimately baked
 * into the dependent's tree — "inherited, unmodified" is not a fence
 * violation; a dependent's OWN commit touching the dependency's file is,
 * and still fails. The exemption is `dependsOn`-gated: a sibling with no
 * dependency relation keeps the full fence. `findPathCollisions` is
 * untouched.
 */

import { couplesTo, isTestPath } from "./work-driver-plan-paths.ts";

/** #285 — escape hatch for the deterministic develop scope/fanout gate. */
function scopeGateEnabled(): boolean {
  const value = process.env.PI_ENSEMBLE_SCOPE_GATE;
  return value !== "0" && value !== "false";
}

/**
 * #285 — normalise a scope path like git would spell it.
 *
 * #784 — a trailing-parenthetical annotation is stripped before the ./
 * and trailing-slash normalisation. This module's normaliser owns BOTH the
 * in-scope `paths` side and the `outOfScope` fence side, and real state
 * files carry annotations on both ("...ts (new)", "...ts (no changes)").
 * The strip mirrors `normaliseDeclaredPath`'s trailing-annotation rule but
 * is extended for UNTERMINATED parentheticals that occur in real state files
 * (778.json shape: "...ts (any change to what consolidation stages — …"
 * with no closing paren). Two-pass: pass 1 strips a balanced trailing
 * "(…)", pass 2 strips a " (…" with no matching close. A parenthetical
 * INSIDE a real filename ("docs/notes (draft).md") survives — the annotation
 * must be at the END, and content after it (".md") disqualifies it.
 */
function normaliseScopePath(raw: string): string {
  const stripped = raw
    .trim()
    .replace(/\s*\([^()]*\)\s*$/, "") // pass 1: balanced trailing "(…)"
    .replace(/ \((?:[^()]*)$/, "") // pass 2: unterminated " (…" to end
    .trim();
  return stripped.replace(/^\.\//, "").replace(/\/+$/, "");
}

/** #285 — check whether a file path matches a declared scope path. */
function matchesScopePath(file: string, declared: string): boolean {
  return file === declared || file.startsWith(`${declared}/`);
}

/** #285 — scope/fanout gate tunables (PI_ENSEMBLE_SCOPE_FANOUT_FACTOR/_MIN). */
function scopeFanoutFactor(): number {
  const value = Number(process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR);
  if (!Number.isFinite(value) || value < 0) return 3;
  return value;
}
function scopeFanoutMinimum(): number {
  const value = Number(process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN);
  if (!Number.isFinite(value) || value < 0) return 6;
  return Math.floor(value);
}

/**
 * #285 — run the develop scope/fanout gate. Mutates `failures` and `notes`
 * in place. The FENCE's permitted set is the union of ALL workstreams'
 * declared paths in this plan, not just the current workstream's slice
 * (#672 sub-defect 2). Two things deliberately do NOT widen: (1) the
 * workstream's OWN `outOfScope` fence — modulo the #725 dependsOn
 * carve-out documented above — and (2) the fanout DENOMINATOR.
 *
 * #725 — `changedPathsByWorkstream` is each workstream's OWN effective-base
 * diff (the caller resolves the per-workstream base from
 * `workstreamBaseShas`), so a dependent workstream's inherited dependency
 * commits never appear in its changed set.
 */
export function runScopeFanoutGate(
  workstreams: Record<
    string,
    | {
        id: string;
        scope: string;
        paths: string[];
        outOfScope: string[];
        dependsOn?: string[];
      }
    | undefined
  >,
  changedPathsByWorkstream: Map<string, Set<string>>,
  failures: string[],
  notes: string[],
): void {
  if (!scopeGateEnabled()) {
    notes.push("PI_ENSEMBLE_SCOPE_GATE=0 — develop scope/fanout gate disabled");
    return;
  }
  const planDeclaredPaths = new Set<string>();
  for (const ws of Object.values(workstreams)) {
    for (const p of ws?.paths ?? []) {
      const n = normaliseScopePath(p);
      if (n.length > 0) planDeclaredPaths.add(n);
    }
  }
  // #725 — per-workstream, the union of the declared `paths` of the
  // workstreams this one depends on. A path in this set is exempt from the
  // outOfScope fence below: the cross-declaration contract (#572) puts it in
  // the dependent's outOfScope, and the dependent's worktree legitimately
  // contains it (created from the dependency's post-commit SHA).
  const dependencyOwnedBy = new Map<string, Set<string>>();
  for (const [id, ws] of Object.entries(workstreams)) {
    const depIds = ws?.dependsOn ?? [];
    if (depIds.length === 0) continue;
    const owned = new Set<string>();
    for (const depId of depIds) {
      for (const p of workstreams[depId]?.paths ?? []) {
        const n = normaliseScopePath(p);
        if (n.length > 0) owned.add(n);
      }
    }
    dependencyOwnedBy.set(id, owned);
  }
  for (const [id, changedPaths] of changedPathsByWorkstream) {
    const workstream = workstreams[id];
    const declaredPaths = (workstream?.paths ?? [])
      .map(normaliseScopePath)
      .filter((p) => p.length > 0);
    const outOfScope = (workstream?.outOfScope ?? [])
      .map(normaliseScopePath)
      .filter((p) => p.length > 0);
    const changedFiles = [...changedPaths].sort();
    // #725 — a hit is exempt when the fenced path is declared in `paths` by
    // a workstream in this one's `dependsOn` list (the cross-declaration
    // carve-out documented in the module header). The gate depends on
    // `dependsOn`, not a blanket exemption: a sibling without a dependency
    // relation touching the other's path still fails.
    // The Set→array spread is hoisted OUT of the per-file filter (the
    // review flagged the previous in-filter spread as C array allocations of
    // length K per workstream — gratuitous churn; one copy per workstream
    // is all the predicate needs).
    const depOwnedPaths = dependencyOwnedBy.get(id);
    const depOwnedArr = depOwnedPaths ? [...depOwnedPaths] : [];
    // #784 — a second, additive exemption: a fence hit is demoted to a NOTE
    // (not a failure, not silently dropped) when the fenced file is declared
    // in THIS workstream's OWN `paths` (self-fence). The plan step can list
    // the same file in a workstream's in-scope `paths` AND in that same
    // workstream's `outOfScope` fence — the plan contradicts itself ("this
    // file is yours" and "do not touch it"). The recorded #776 incident:
    // rc1's fence listed work-driver-integrate.ts as out-of-scope while
    // integrate.ts is exactly where rc1's fix lived, and the driver parked
    // on the fence. The exemption is SELF-fence only, NOT a plan-wide
    // widening: a path declared by an INDEPENDENT sibling still fails. Per-hit
    // granularity: each file is judged independently, so a workstream touching
    // two fenced files (one self-declared, one genuinely undeclared) emits one
    // demotion note AND one failure.
    const isSelfFenced = (file: string): boolean =>
      declaredPaths.some((declared) => matchesScopePath(file, declared));
    const outOfScopeHits = changedFiles.filter(
      (file) =>
        outOfScope.some((declared) => matchesScopePath(file, declared)) &&
        !depOwnedArr.some((declared) => matchesScopePath(file, declared)),
    );
    for (const file of outOfScopeHits) {
      if (isSelfFenced(file)) {
        notes.push(
          `fence hit demoted to warning: ${file} is declared in this workstream's own paths (self-fence)`,
        );
        continue;
      }
      failures.push(`developer touched out-of-scope path ${file} — declared fence violated`);
    }
    if (declaredPaths.length === 0) {
      notes.push(`scope fanout check skipped for ${id} — workstream has no declared paths`);
      continue;
    }
    const limit = Math.max(declaredPaths.length * scopeFanoutFactor(), scopeFanoutMinimum());
    // #672 (sub-defect 3) — the test-file exception: a changed path that
    // matches `isTestPath` is fence-permitted when its INFERRED SUBJECT
    // (via `couplesTo`) is in the plan-wide declared set. Inference-gated,
    // not a blanket exemption: an unrelated `test-bar.ts` whose stem names
    // nothing declared still fails. The exception counts the file as declared
    // for the fanout check — a test legitimately asked for alongside a
    // declared subject must not inflate the changed-file count.
    const isDeclaredOrExempt = (file: string): boolean =>
      declaredPaths.some((declared) => matchesScopePath(file, declared)) ||
      [...planDeclaredPaths].some((declared) => matchesScopePath(file, declared)) ||
      (isTestPath(file) &&
        [...planDeclaredPaths].some(
          (declared) => !isTestPath(declared) && couplesTo(file, declared),
        ));
    // #724 — the fanout NUMERATOR counts only this workstream's own
    // undeclared files. A file declared by a SIBLING workstream is the plan's
    // assignment to that sibling — it is not this workstream's fanout, even
    // when a developer's diff happens to reach it (the #674 shape: 15 of 18
    // files were task-a's, 4 were genuinely undeclared, 4 < limit 9). The
    // old raw count penalised this workstream for another workstream's plan
    // and, combined with the pre-#672 cumulative Set, judged every
    // multi-workstream cycle against an inflated number. `undeclaredFiles`
    // already implements exactly this set (own ∪ sibling ∪ coupled-test
    // exemption), so it is both the numerator and the failure listing.
    const undeclaredFiles = changedFiles.filter((file) => !isDeclaredOrExempt(file));
    if (undeclaredFiles.length > limit) {
      failures.push(
        `scope fanout: ${undeclaredFiles.length} undeclared file(s) changed vs ${declaredPaths.length} declared — likely mis-decomposition; split the work or update the plan. Files: ${undeclaredFiles.join(", ")}`,
      );
    }
  }
}

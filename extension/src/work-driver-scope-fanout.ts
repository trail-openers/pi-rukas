/**
 * work-driver-scope-fanout — #285 develop scope/fanout gate.
 *
 * Extracted from work-driver-verify-develop.ts (file-size cap, AGENTS.md §12).
 *
 * Intentionally separate from the hollow-diff check: a changed worktree can
 * prove a developer wrote code while still showing the decomposition was too
 * broad. An empty paths list has no declared boundary, so preserve legacy
 * behaviour and report the skipped check rather than inventing one.
 */

import { couplesTo, isTestPath } from "./work-driver-plan-paths.ts";

/** #285 — escape hatch for the deterministic develop scope/fanout gate. */
function scopeGateEnabled(): boolean {
  const value = process.env.PI_ENSEMBLE_SCOPE_GATE;
  return value !== "0" && value !== "false";
}

/** #285 — normalise a scope path like git would spell it. */
function normaliseScopePath(raw: string): string {
  return raw.trim().replace(/^\.\//, "").replace(/\/+$/, "");
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
 * workstream's OWN `outOfScope` fence, and (2) the fanout DENOMINATOR.
 */
export function runScopeFanoutGate(
  workstreams: Record<
    string,
    { id: string; scope: string; paths: string[]; outOfScope: string[] } | undefined
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
  for (const [id, changedPaths] of changedPathsByWorkstream) {
    const workstream = workstreams[id];
    const declaredPaths = (workstream?.paths ?? [])
      .map(normaliseScopePath)
      .filter((p) => p.length > 0);
    const outOfScope = (workstream?.outOfScope ?? [])
      .map(normaliseScopePath)
      .filter((p) => p.length > 0);
    const changedFiles = [...changedPaths].sort();
    const outOfScopeHits = changedFiles.filter((file) =>
      outOfScope.some((declared) => matchesScopePath(file, declared)),
    );
    for (const file of outOfScopeHits) {
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
    const undeclaredFiles = changedFiles.filter((file) => !isDeclaredOrExempt(file));
    if (changedFiles.length > limit) {
      const listedFiles = (undeclaredFiles.length > 0 ? undeclaredFiles : changedFiles).join(", ");
      failures.push(
        `scope fanout: ${changedFiles.length} files changed vs ${declaredPaths.length} declared — likely mis-decomposition; split the work or update the plan. Files: ${listedFiles}`,
      );
    }
  }
}

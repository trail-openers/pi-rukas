/**
 * work-driver-converge — the end-of-develop converge gate (issue #741, P2).
 *
 * The verify gate proves the diff BUILDS (tsc/tests); it says nothing about
 * whether the diff is COMPLETE. Measured on the 240-cycle corpus (#655,
 * PR #737): 53 of 90 verify-passing cycles (58.9%, upper bound) shipped
 * with ≥1 plan deliverable absent or partially present in the
 * end-of-develop diff — 12 cycles with 100% of their declared paths
 * missing. A diff that builds and tests green can silently implement 2 of
 * 3 deliverables; the converge gate is the deterministic check for exactly
 * that shape.
 *
 * The check is Spec Kit's converge pass, made driver-side: for each
 * deliverable in `normalisedSpec.deliverables`, classify the end-of-develop
 * diff (per-worktree committed diff name-sets against the workstream's
 * effective base — the same refs the develop verify gate reads — plus the
 * per-worktree uncommitted porcelain paths) as:
 *
 *   - `implemented`  — every declared path is in the diff
 *   - `partial`      — some but not all declared paths are in the diff
 *   - `absent`       — no declared path is in the diff
 *   - `unmeasurable` — no declared paths (prose deliverable); never blocks
 *   - `no-diff`      — plan-time marker + evidence: the absence is correct
 *                      by design (settings toggle, operator action); never
 *                      blocks, surfaced as an operator action
 *
 * Classification is DETERMINISTIC path presence — zero LLM calls (the
 * issue's stated baseline). A diff file "satisfies" a declared path when
 * it equals the normalised path or sits beneath it (a directory
 * declaration covers its contents). Paths are normalised with
 * `normaliseDeclaredPath` for the same reason the verify gate does: they
 * are planner prose, not `git` output, and `"src/a.ts (new)"` must read as
 * `src/a.ts`.
 *
 * The LLM-assisted content check the issue mentions lives at the
 * `buildConvergeCorrectivePrompt` seam: the driver classifies
 * deterministically (this module), and the one-shot corrective
 * re-dispatch carries the full normalised spec so the developer can
 * implement whatever a deterministic path-presence check cannot judge.
 *
 * Escape hatch: PI_ENSEMBLE_CONVERGE=0 disables the gate (consistent with
 * PI_ENSEMBLE_VERIFY / PI_ENSEMBLE_SCOPE_GATE / PI_ENSEMBLE_CLAIM_SCAN).
 */

import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { WorkState } from "./workflow-state.ts";

const execp = promisify(exec);

/** `PI_ENSEMBLE_CONVERGE=0` (or `false`) disables the gate. */
export function convergeGateEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_CONVERGE;
  return v !== "0" && v !== "false";
}

export type DeliverableStatus = "implemented" | "partial" | "absent" | "unmeasurable" | "no-diff";

export interface ConvergeDeliverableResult {
  id: string;
  status: DeliverableStatus;
  /** The normalised declared paths this deliverable declared. */
  paths: string[];
  /** Of those, which are present in the diff. */
  present: string[];
  /** Of those, which are missing from the diff (absent/partial only). */
  missing: string[];
  /** One-line, operator-readable reason (rendered in handoff + PR body). */
  reason: string;
  /**
   * The evidence string recorded at plan time for a `no-diff` deliverable
   * (a command to run, an API endpoint, or a settings URL). Surfaced verbatim
   * in the operator-actions render. `undefined` for all other statuses.
   */
  noDiffEvidence?: string;
}

export interface ConvergeVerdict {
  /**
   * Reserved for a future readable-but-incomplete diff reading (e.g. a
   * per-worktree partial failure the gate wants to surface). Today the
   * only unreadable path returns `null` before classification, so this is
   * always `false` — the gate degrades to pass rather than emitting a
   * half-classified verdict.
   */
  diffUnreadable: boolean;
  deliverables: ConvergeDeliverableResult[];
  absent: ConvergeDeliverableResult[];
  partial: ConvergeDeliverableResult[];
  /**
   * Deliverables classified `no-diff` — the gate checked and the absence
   * is correct by design (settings toggle, operator action, etc.). These
   * are NOT blockers; they are surfaced as operator actions in the
   * completion report and PR body. Distinct from `unmeasurable` (the gate
   * cannot check this) and from `absent` (the gate checked and the work
   * is missing).
   */
  noDiff: ConvergeDeliverableResult[];
}

/**
 * The end-of-develop diff name-set: every file in every worktree's committed
 * diff against that workstream's EFFECTIVE base (`workstreamBaseShas` entry,
 * falling back to the global baseSha — the same refs the develop verify gate
 * judges), plus every uncommitted (porcelain) path in each worktree (the
 * union keeps an all-uncommitted cycle measurable in every ordering).
 *
 * A worktree entry is skipped when it is neither an absolute path nor a
 * relative path rooted at the driver's repoRoot: the ops-fallback branch
 * shape `{ default: "repoRoot" }` (a placeholder string, not a path) or a
 * stale relative path from a different checkout must not pollute the
 * name-set — the `git status --porcelain` run there would read the WRONG
 * tree and could manufacture false "present" evidence. A worktree where
 * neither command succeeds contributes nothing (degrades to the other
 * worktrees); an all-fail returns `unreadable: true` (no false alarm —
 * same stance as the verify gate's no-worktree-assessable rule).
 */
export async function readEndOfDevelopDiff(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  state: WorkState,
  repoRoot: string,
): Promise<{ files: Set<string>; unreadable: boolean }> {
  const ps = state.pipelineState;
  const worktrees =
    Object.keys(ps.worktrees ?? {}).length > 0 ? (ps.worktrees ?? {}) : { default: "repoRoot" };
  const files = new Set<string>();
  let anySucceeded = false;
  for (const [wsId, cwd] of Object.entries(worktrees)) {
    // The ops-fallback `{ default: "repoRoot" }` placeholder is NOT a
    // directory — it means "the repo root checkout". Resolve it; anything
    // else relative must be rooted at the driver's repoRoot. An absolute
    // path that does NOT lie under repoRoot is the same stale-path class
    // and is skipped — shelling git with a cwd from the persisted map taken
    // verbatim would read an arbitrary directory tree.
    const dir =
      cwd === "repoRoot" ? repoRoot : path.isAbsolute(cwd) ? cwd : path.join(repoRoot, cwd);
    if (dir !== repoRoot && !dir.startsWith(`${repoRoot}${path.sep}`)) {
      trace(`work-driver: converge gate — skipping worktree ${wsId}: ${dir} is outside repoRoot`);
      continue;
    }
    const opts = { cwd: dir, maxBuffer: 4 * 1024 * 1024 };
    // Committed diff against this workstream's effective base (the per-
    // workstream entry wins over the global baseSha — the same fallback
    // the develop verify gate uses).
    const per = ps.workstreamBaseShas?.[wsId];
    const base = per ?? ps.baseSha;
    if (typeof base === "string" && /^[0-9a-f]{40}$/.test(base)) {
      try {
        const { stdout } = await execFn(`git diff --name-only ${base}..HEAD`, opts);
        for (const line of stdout.split("\n")) {
          const f = line.trim();
          if (f.length > 0) files.add(f);
        }
        anySucceeded = true;
      } catch {
        // Absent base in this worktree's history — not evidence either way.
      }
    }
    // Uncommitted (porcelain) paths — present in the diff before the
    // commit lands (the gate runs after the safety net, but in some
    // orderings the porcelain state still carries the truth). A per-
    // worktree failure is NOT evidence the whole diff is unreadable: the
    // committed diff name-set is the primary signal (a worktree whose tree
    // vanished between the branch step and now contributes nothing), so the
    // porcelain read is a best-effort UNION that never flips anySucceeded
    // off.
    try {
      const { stdout } = await execFn("git status --porcelain", opts);
      for (const line of stdout.split("\n")) {
        const l = line.trim();
        if (l.length === 0) continue;
        const entry = l.slice(3);
        const arrow = entry.indexOf(" -> ");
        const targets = arrow >= 0 ? [entry.slice(0, arrow), entry.slice(arrow + 4)] : [entry];
        for (const t of targets) {
          const clean = t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
          if (clean.length > 0) files.add(clean);
        }
      }
    } catch {
      // A worktree git error degrades to the committed diff name-set only.
    }
    // The committed diff is the primary signal; a worktree that produced a
    // diff (even an empty one) is assessable. Mark success here so a
    // vanished worktree tree does not poison the gate's readability.
    if (!anySucceeded) {
      try {
        await execFn("git rev-parse --verify HEAD", opts);
        anySucceeded = true;
      } catch {
        // This worktree is not a git repo at all — contributes nothing.
      }
    }
  }
  return { files, unreadable: !anySucceeded };
}

/**
 * The core classification. Pure over (deliverables, diff-file-set) so the
 * smoke test exercises the exact production predicate with no git at all.
 */
/**
 * The deliverable shape accepted by `classifyDeliverables`. Extends the
 * inline shape with the optional plan-time no-diff marker (issue #792):
 * `noDiff` flags a deliverable that produces no diff by design, and
 * `noDiffEvidence` carries the evidence string (command, API endpoint, or
 * settings URL) that makes the marker actionable. When `noDiff` is true but
 * `noDiffEvidence` is absent or empty, the marker is NOT honoured — the
 * deliverable classifies as it would without the marker (absent if it has
 * paths, unmeasurable if it does not). A contradictory case (both valid code
 * paths AND a no-diff marker) lets the code paths win: the marker is ignored
 * and the deliverable is classified by path presence.
 */
export interface ClassifyDeliverableInput {
  id: string;
  description: string;
  paths: string[];
  /** Plan-time marker: this deliverable produces no diff by design. */
  noDiff?: boolean;
  /** Evidence string required for the no-diff marker to be honoured. */
  noDiffEvidence?: string;
}

export function classifyDeliverables(
  deliverables: ClassifyDeliverableInput[],
  diffFiles: Set<string>,
): ConvergeVerdict {
  const results: ConvergeDeliverableResult[] = deliverables.map((d) => {
    const paths = [
      ...new Set((d.paths ?? []).map(normaliseDeclaredPath).filter((p) => p.length > 0)),
    ];

    // No-diff marker: honoured only when it carries a non-empty evidence
    // string AND the deliverable has no valid code paths (a contradictory
    // marker + paths lets the code paths win — deterministic, documented).
    if (d.noDiff && d.noDiffEvidence && d.noDiffEvidence.trim().length > 0 && paths.length === 0) {
      return {
        id: d.id,
        status: "no-diff",
        paths,
        present: [],
        missing: [],
        reason: `no diff by design — evidence: ${d.noDiffEvidence.trim()}`,
        noDiffEvidence: d.noDiffEvidence.trim(),
      };
    }

    if (paths.length === 0) {
      return {
        id: d.id,
        status: "unmeasurable",
        paths,
        present: [],
        missing: [],
        reason: "no declared paths (prose deliverable)",
      };
    }
    const present = paths.filter(
      (p) => diffFiles.has(p) || Array.from(diffFiles).some((f) => f.startsWith(`${p}/`)),
    );
    const missing = paths.filter((p) => !present.includes(p));
    let status: DeliverableStatus;
    let reason: string;
    if (missing.length === 0) {
      status = "implemented";
      reason = `all ${paths.length} declared path(s) in the diff`;
    } else if (present.length === 0) {
      status = "absent";
      reason = `none of ${paths.length} declared path(s) in the diff (${paths.join(", ")})`;
    } else {
      status = "partial";
      reason = `only ${present.length}/${paths.length} declared path(s) in the diff — missing: ${missing.join(", ")}`;
    }
    return { id: d.id, status, paths, present, missing, reason };
  });
  return {
    diffUnreadable: false,
    deliverables: results,
    absent: results.filter((r) => r.status === "absent"),
    partial: results.filter((r) => r.status === "partial"),
    noDiff: results.filter((r) => r.status === "no-diff"),
  };
}

/**
 * The end-of-develop converge gate. Runs at the end of the develop step,
 * after the existing verify gate has passed. Returns `null` when the gate
 * does not apply (disabled, no normalised spec, no deliverables, or an
 * unreadable diff — a git failure is not evidence a deliverable is absent).
 */
export async function runConvergeGate(
  ctx: DriverContext,
  state: WorkState,
): Promise<ConvergeVerdict | null> {
  if (!convergeGateEnabled()) return null;
  const spec = state.pipelineState.normalisedSpec;
  if (!spec || spec.deliverables.length === 0) return null;
  const execFn = ctx.verifyExecFn ?? execp;
  const { files, unreadable } = await readEndOfDevelopDiff(execFn, state, ctx.repoRoot);
  if (unreadable) {
    trace("work-driver: converge gate — diff unreadable, gate degraded to pass");
    return null;
  }
  const verdict = classifyDeliverables(spec.deliverables, files);
  if (verdict.absent.length > 0) {
    trace(
      `work-driver: converge gate — absent deliverable(s): ${verdict.absent.map((a) => a.id).join(", ")}`,
    );
  }
  if (verdict.noDiff.length > 0) {
    trace(
      `work-driver: converge gate — no-diff deliverable(s) (operator actions): ${verdict.noDiff.map((a) => a.id).join(", ")}`,
    );
  }
  return verdict;
}

/**
 * The one-shot corrective re-dispatch prompt (the plan-quality one-shot
 * pattern: a bounded corrective dispatch naming exactly what is missing,
 * never a loop). Names each missing deliverable with its description and
 * its missing paths, and carries the full normalised spec so the developer
 * can implement whatever the deterministic path-presence check could not
 * judge (the LLM-assisted seam the issue describes).
 */
export function buildConvergeCorrectivePrompt(state: WorkState, verdict: ConvergeVerdict): string {
  const spec = state.pipelineState.normalisedSpec;
  const issue = state.issue;
  const missingByOwner = new Map<string, string[]>();
  for (const a of verdict.absent) {
    const owner = workstreamsOwningPath(state, a.missing) ?? "the workstream(s) owning these paths";
    const list = missingByOwner.get(owner) ?? [];
    const desc = spec?.deliverables.find((d) => d.id === a.id)?.description ?? a.id;
    list.push(`- ${a.id}: ${desc} — missing path(s): ${a.missing.join(", ")}`);
    missingByOwner.set(owner, list);
  } // The owner key IS the attribution the corrective child needs (the fix
  // must land in the owning workstream's worktree) — emit it, grouped:
  const missingLines = [...missingByOwner.entries()].flatMap(([owner, list]) => [
    `  [workstream ${owner}]`,
    ...list,
  ]);
  const specBlock = spec
    ? [
        "",
        "The plan's normalised spec (what the cycle was told to build):",
        `- intent: ${spec.intent}`,
        "deliverables:",
        ...spec.deliverables.map(
          (d) => `  - ${d.id}: ${d.description} [paths: ${d.paths.join(", ")}]`,
        ),
        "acceptance criteria:",
        ...spec.acceptanceCriteria.map((a) => `  - ${a}`),
        "",
      ]
    : [];
  const lines = [
    "CONVERGE GATE — the end-of-develop diff is missing declared deliverables.",
    "The verify gate passed (the code builds); this is a COMPLETENESS gate: the plan's",
    `deliverables (issue #${issue}) are not all present in the diff. Implement the missing work`,
    "end-to-end, commit it in your worktree, and re-run the local quality gates.",
    "",
    "Missing deliverable(s):",
    ...missingLines,
    ...specBlock,
    "Do NOT touch anything outside your declared scope. When done, list the deliverable(s)",
    "you implemented and the files changed.",
  ];
  return lines.join("\n");
}

/** Which workstream(s) declared the missing paths (for prompt attribution). */
function workstreamsOwningPath(state: WorkState, missing: string[]): string | null {
  const workstreams = state.pipelineState.workstreams ?? {};
  const owners = new Set<string>();
  for (const [id, ws] of Object.entries(workstreams)) {
    const declared = (ws?.paths ?? []).map(normaliseDeclaredPath);
    if (missing.some((p) => declared.includes(p))) owners.add(id);
  }
  return owners.size > 0 ? [...owners].join(", ") : null;
}

/**
 * The FIRST workstream id that declared at least one of the missing paths
 * (the converge gate handler uses this to dispatch the corrective re-dispatch
 * with the owning worktree's cwd, so the fix lands where the deliverable
 * belongs). `null` when no workstream claims the paths (the caller falls
 * back).
 */
export function workstreamOwnsMissingPaths(
  state: WorkState,
  absent: ConvergeDeliverableResult[],
): string | null {
  const missing = new Set(absent.flatMap((a) => a.missing));
  if (missing.size === 0) return null;
  const workstreams = state.pipelineState.workstreams ?? {};
  for (const [id, ws] of Object.entries(workstreams)) {
    const declared = (ws?.paths ?? []).map(normaliseDeclaredPath);
    for (const p of missing) {
      if (declared.includes(p)) return id;
    }
  }
  return null;
}

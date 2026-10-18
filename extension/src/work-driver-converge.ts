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
 *   - `unmeasurable` — no declared path the gate can measure (a prose
 *                      deliverable, or paths that parse to no concrete or glob
 *                      alternative — #1155); never blocks
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
 * #1155 — a declared path is a LIST OF ALTERNATIVES, not a literal. The plan
 * writes prose, so `[paths: extension/src/verify.ts or new work-driver-<name>.ts]`
 * is one slot meaning two paths, and `<name>` is a template the planner left
 * rather than a filename. Before this, both read as one literal string no
 * `git diff --name-only` could contain, so the developers' real file
 * (`work-driver-acceptance-coverage.ts`) classified `absent`, the corrective
 * re-dispatch spent 76 min trying to create `work-driver-<name>.ts`, and a
 * 154-min cycle parked. The rule the operator decided: a deliverable counts as
 * delivered when ANY alternative matches the diff (segment-anchored glob for
 * templates); `partial` uses the same matching; a deliverable with NO concrete
 * or glob alternative at all is `unmeasurable` — a warning, never a cap — and
 * only a deliverable that has at least one measurable alternative and matches
 * none of them is `absent`. The grammar lives in
 * `work-driver-deliverable-paths.ts`, which the #819 plan-to-spec coverage gate
 * calls too, so the two gates cannot disagree about what a `[paths:]` slot
 * means.
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

import path from "node:path";
import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import {
  type ClassifyDeliverableInput,
  type ConvergeDeliverableResult,
  type ConvergeVerdict,
  type WorkstreamPathsMap,
  classifyDeliverables,
} from "./work-driver-converge-classify.ts";
import {
  declaredPathMatches,
  deliverablePathAlternatives,
} from "./work-driver-deliverable-paths.ts";
import { porcelainPaths } from "./work-driver-doctrine.ts";
import { developTestScopeLine } from "./work-driver-verify-fast.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { WorkState } from "./workflow-state.ts";

// The classification types and the pure classifier moved to
// `work-driver-converge-classify.ts` (#1155, AGENTS.md §12 file-size cap).
// Re-exported so the gate's consumers — the gate handler, the develop
// topological/merge-retry flows, and the smoke tests — keep their import
// paths and cannot drift to a second copy of the vocabulary.
export {
  type ClassifyDeliverableInput,
  type ConvergeDeliverableResult,
  type ConvergeVerdict,
  type DeliverableStatus,
  type WorkstreamPathsMap,
  classifyDeliverables,
} from "./work-driver-converge-classify.ts";

/** `PI_ENSEMBLE_CONVERGE=0` (or `false`) disables the gate. */
export function convergeGateEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_CONVERGE;
  return v !== "0" && v !== "false";
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
      // porcelainPaths slices each UNTRIMMED record: trimming a ` M path`
      // line first shifts the two-column status and costs the path its
      // first character (#1190).
      for (const p of porcelainPaths(stdout)) files.add(p);
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
 * The end-of-develop converge gate. Runs at the end of the develop step,
 * after the existing verify gate has passed. Returns `null` when the gate
 * does not apply (disabled, no normalised spec, no deliverables, or an
 * unreadable diff — a git failure is not evidence a deliverable is absent).
 */
export async function runConvergeGate(
  ctx: CycleContext,
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
  // #1137 d2 — build the workstream paths map for the `deliveredBy` field.
  const wsMap = state.pipelineState.workstreams ?? {};
  const workstreamPaths: WorkstreamPathsMap = {};
  for (const [id, ws] of Object.entries(wsMap)) {
    if (ws?.paths?.length) workstreamPaths[id] = ws.paths;
  }
  const verdict = classifyDeliverables(spec.deliverables, files, workstreamPaths);
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
  // #1155 — an unmeasurable deliverable is a WARNING the operator must see
  // while the cycle is running, not a line buried in the state file: the
  // planner wrote a `[paths:]` slot nobody can check, and the gate is passing
  // it rather than verifying it.
  if (verdict.unmeasurable.length > 0) {
    trace(
      `work-driver: converge gate — UNMEASURABLE deliverable(s), warning not cap: ${verdict.unmeasurable.map((a) => `${a.id} — ${a.reason}`).join("; ")}`,
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
export function buildConvergeCorrectivePrompt(
  state: WorkState,
  verdict: ConvergeVerdict,
  /** #1350 — `.pi/verify-cmd-fast`, when the project has one. */
  fastVerifyCmd?: string,
): string {
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
          // #1155 — print the alternatives the child can actually act on. The
          // pre-#1155 render joined the RAW slots, so a corrective child read
          // "missing path(s): extension/src/work-driver-verify.ts or new
          // work-driver-<name>.ts" and spent its dispatch trying to create a
          // file literally named `work-driver-<name>.ts`. The alternatives are
          // the same split the gate matched on, and a `<name>` template is now
          // labelled as one instead of being handed over as a filename.
          (d) =>
            `  - ${d.id}: ${d.description} [paths: ${d.paths.join(", ")}]${templateNote(d.paths)}`,
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
    "end-to-end and commit it in your worktree.",
    // #1350 — the old "re-run the local quality gates" sent the child into
    // repeated full-gate runs the driver repeats anyway on the result.
    ...(fastVerifyCmd
      ? [
          `Before committing, run the project's FAST verify tier — \`${fastVerifyCmd}\` — and make it pass.`,
        ]
      : []),
    developTestScopeLine(Boolean(fastVerifyCmd)),
    "Do NOT run the project's full verify command or full suite: the driver re-runs the full gate on your result.",
    "",
    "Missing deliverable(s):",
    ...missingLines,
    ...specBlock,
    "Do NOT touch anything outside your declared scope. When done, list the deliverable(s)",
    "you implemented and the files changed.",
  ];
  return lines.join("\n");
}

/**
 * #1155 — the template note appended to a spec line whose `[paths:]` slot left
 * a `<…>`/`*` placeholder. The corrective child must know a template is a shape
 * to satisfy, not a filename: the #1137 corrective burned 76 min on
 * `work-driver-<name>.ts`. Returns "" for an all-concrete deliverable.
 */
function templateNote(paths: readonly string[]): string {
  const templates = deliverablePathAlternatives(paths)
    .flatMap((slot) => slot.alternatives)
    .filter((alt) => alt.isGlob)
    .map((alt) => alt.raw);
  if (templates.length === 0) return "";
  return ` — NOTE: ${templates.map((t) => `\`${t}\``).join(", ")} is a TEMPLATE, not a filename: any file that matches it counts (the gate matches a template per path segment).`;
}

/**
 * Which workstream(s) declared the missing paths (for prompt attribution).
 *
 * #1155 — compared with the shared alternatives grammar, not `includes`: the
 * `missing` strings are now the planner's own `raw` forms, which may hold
 * several alternatives, and an exact `includes` against a workstream's
 * declaration would silently drop the attribution (and with it the corrective
 * child's cwd) for every either/or deliverable.
 */
function workstreamsOwningPath(state: WorkState, missing: string[]): string | null {
  const workstreams = state.pipelineState.workstreams ?? {};
  const owners = new Set<string>();
  for (const [id, ws] of Object.entries(workstreams)) {
    const declared = (ws?.paths ?? []).map(normaliseDeclaredPath);
    if (missing.some((p) => declaredPathMatches(p, EMPTY_DIFF_SET, declared))) owners.add(id);
  }
  return owners.size > 0 ? [...owners].join(", ") : null;
}

/** No diff files — the workstream-ownership reads match on declarations alone. */
const EMPTY_DIFF_SET: ReadonlySet<string> = new Set<string>();

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
      if (declaredPathMatches(p, EMPTY_DIFF_SET, declared)) return id;
    }
  }
  return null;
}

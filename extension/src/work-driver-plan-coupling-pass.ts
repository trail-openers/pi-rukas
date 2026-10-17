/**
 * work-driver-plan-coupling-pass — the plan step's coupling pass, in one call.
 *
 * #819 round-3 — extracted from `runPlan` (work-driver-plan.ts) for the
 * AGENTS.md §12 500-line gate. The body is byte-identical to the closure it
 * replaces, including the two facts the closure captured and this function now
 * takes as arguments: the port reference the #1322 fold reads, and the
 * worktrees map the coupling grep resolves each workstream's paths against
 * (empty at plan time in production — the branch step populates it later, so
 * the merge runs at `repoRoot`).
 *
 * Why a module and not a helper inside work-driver-plan.ts: the plan step
 * itself is the file at the cap, and this pass is a distinct concern (it owns
 * the fold + the contract-derived edges + the merge loop), so it splits along
 * the same seam as `work-driver-plan-coupling.ts` and
 * `work-driver-plan-contract.ts` rather than adding a fourth responsibility to
 * the step handler.
 */

import fs from "node:fs/promises";
import { trace } from "./trace.ts";
import { foldPortPlan, mergeWithContract } from "./work-driver-plan-contract.ts";
import { mergeCoupledWorkstreams } from "./work-driver-plan-coupling.ts";
import { unfenceIssueNamedPaths } from "./work-driver-plan-unfence.ts";
import { execp } from "./work-driver-verify.ts";
import type { Workstream } from "./workflow-state-schema.ts";
import type { WorkState } from "./workflow-state.ts";

/** The argv-form grep seam (planner-controlled paths, no shell) — the same
 * shape `mergeCoupledWorkstreams` takes; declared here because the coupling
 * module keeps it private. */
type GrepExecFn = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; argv?: string[] },
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * Fold a port plan into one workstream, then merge workstreams the coupling
 * rules say cannot be built independently. A single-workstream plan is a
 * no-op; a plan with no port reference and no coupling is returned unchanged.
 *
 * `execFn` is the rule-3 grep executor: `ctx.verifyExecFn` when a test supplies
 * one, `execp` otherwise (it honours `opts.argv` via execFile). The merge runs
 * at plan time, before the branch step, so the grep's cwd is `repoRoot`.
 */
export async function runPlanCouplingPass(
  raw: Record<string, Workstream>,
  opts: {
    port?: string;
    repoRoot: string;
    worktrees?: Record<string, string>;
    execFn?: GrepExecFn;
  },
): Promise<Record<string, Workstream>> {
  const ws = foldPortPlan(raw, opts.port);
  if (Object.keys(ws).length <= 1) return ws;
  const planExecFn = opts.execFn ?? execp;
  const coupling = await mergeWithContract(ws, (w) =>
    mergeCoupledWorkstreams(w, planExecFn, opts.worktrees, opts.repoRoot),
  );
  if (coupling.changed) {
    for (const m of coupling.merges) {
      trace(`work-driver: plan coupling merge — ${m.from} → ${m.into} (${m.reason})`);
    }
    return coupling.workstreams;
  }
  return ws;
}

/**
 * #1167 — the plan-time unfence pass, in the same position in the step as the
 * coupling pass above and for the same reason: both rewrite `outOfScope`, and
 * the order between them is load-bearing. This one runs SECOND because the
 * fold and the merge union fence lists (`foldTwo` drops the merged half's
 * paths from the fence, and the ceiling fold unions them) — an unfence that
 * ran before them can have its work reintroduced.
 *
 * It reads the issue body the explore step cached. A missing or unreadable
 * artifact is an EMPTY body: no decision sections, so nothing is extracted and
 * nothing is unfenced. A lost cache file must never widen a scope.
 *
 * `defaultToSingle` is the N=1 shape (the sole workstream owns the whole
 * issue, so a path the issue names belongs to it even with no shared
 * directory). With N>1 placement needs a real shared prefix — a path sharing
 * no directory with any workstream is left fenced rather than handed to an
 * arbitrary developer, which is how a removed fence becomes a scope fanout.
 */
export async function runPlanUnfencePass(
  workstreams: Record<string, Workstream>,
  state: WorkState,
  opts: { repoRoot: string; execFn?: GrepExecFn },
): Promise<Record<string, Workstream>> {
  const body = await readIssueBody(state);
  const result = await unfenceIssueNamedPaths(workstreams, body, {
    execFn: opts.execFn ?? execp,
    repoRoot: opts.repoRoot,
    ref: state.pipelineState.baseSha ?? "HEAD",
    defaultToSingle: Object.keys(workstreams).length === 1,
  });
  for (const note of [...result.notes, ...result.warnings]) trace(`work-driver: ${note}`);
  return result.workstreams;
}

/**
 * #1167 — the issue body the unfence pass reads, from the artifact explore
 * cached. An unreadable or missing artifact is an EMPTY body: no sections,
 * so nothing is extracted and nothing is unfenced. A memory problem or a
 * lost cache file must never widen a scope.
 */
async function readIssueBody(state: WorkState): Promise<string> {
  const artifact = state.pipelineState.issueBodyArtifact;
  if (!artifact) return "";
  try {
    return await fs.readFile(artifact, "utf8");
  } catch (err) {
    trace(
      `work-driver: plan unfence could not read issue body artifact: ${(err as Error).message?.slice(0, 120)}`,
    );
    return "";
  }
}

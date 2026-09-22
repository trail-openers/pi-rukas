/**
 * work-driver-verify-verify-cmd — the verify-command gate of the develop
 * verify (per-worktree run + consolidated run + classification), extracted
 * from work-driver-verify-develop.ts by #794 (500-line gate).
 *
 * #669/#750/#782 semantics live here unchanged: the per-worktree failures
 * are the verdict when the consolidated run cannot run (no valid baseSha or
 * nothing to combine); otherwise the CONSOLIDATED tree is the verdict and
 * per-worktree failures downgrade to notes on a consolidated pass. #782's
 * single bounded flake re-run is caller-gated (every per-worktree verify
 * passed + a genuine N>1 consolidation) and happens inside
 * runConsolidatedVerify. #794 threads `workstreamBaseShas` into the
 * consolidated run so a stacked workstream's OWN range is picked against
 * its dependency's tip (no ancestor replay — the #775 shape).
 */
import path from "node:path";
import { runConsolidatedVerify } from "./work-driver-consolidated-verify.ts";
import {
  buildPerWorktreeFailuresByWs,
  classifyConsolidatedVerifyFailure,
  consolidatedFailureMessage,
} from "./work-driver-consolidation-classify.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { provisionDepsHint } from "./work-driver-deps-hint.ts";
import { verifyCmdFor } from "./work-driver-verify-cmd.ts";
import { formatExecError, verifyTimeoutMs } from "./work-driver-verify-develop-helpers.ts";
import type { WorkState } from "./workflow-state.ts";
import { looksLikeMissingDeps } from "./worktree-provision.ts";

// #794 — the per-worktree + consolidated verify gate of the develop step
// (moved from work-driver-verify-develop.ts to keep that file under the
// 500-line gate; behaviour is a pure move, no logic change).
export async function runVerifyCommandGate(opts: {
  execFn: NonNullable<DriverContext["verifyExecFn"]>;
  cmd: string;
  ctx: DriverContext;
  state: WorkState;
  worktrees: Record<string, string>;
  baseSha: string | undefined;
  changedWorktrees: string[];
  workstreamBaseShas: Record<string, string> | undefined;
  failures: string[];
  notes: string[];
  onVerifyFlakeRecovered?: (evidenceTail?: string) => void;
}): Promise<void> {
  const {
    execFn,
    cmd,
    ctx,
    state,
    worktrees,
    baseSha,
    changedWorktrees,
    workstreamBaseShas,
    failures,
    notes,
    onVerifyFlakeRecovered,
  } = opts;
  const VALID_SHA_RE = /^[0-9a-f]{40}$/;
  const isValidSha = (s: string | undefined) => typeof s === "string" && VALID_SHA_RE.test(s);
  const perWorktreeVerifyFailures: string[] = [];
  for (const cwd of changedWorktrees) {
    try {
      await execFn(cmd, { cwd, timeout: verifyTimeoutMs(), maxBuffer: 4 * 1024 * 1024 });
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean };
      // A verify command that fails for want of `node_modules` reports the
      // same shape as one that fails on a real defect; development happens
      // in a fresh worktree, so this is the likelier of the two when it
      // matches — say so rather than implying the diff is at fault. The
      // consolidated run below decides whether this is a genuine per-
      // worktree defect (kept as a failure) or a cross-worktree artifact
      // (downgraded to evidence).
      const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
      const depsHint = looksLikeMissingDeps(output) ? provisionDepsHint(state, cwd) : "";
      perWorktreeVerifyFailures.push(
        formatExecError(
          e,
          `verify command \`${cmd}\` exceeded its ${Math.round(verifyTimeoutMs() / 60000)}-min timeout in ${cwd}`,
          `verify command \`${cmd}\` failed in ${cwd}${depsHint}`,
        ),
      );
    }
  }
  // #750 — the develop gate reads the CONSOLIDATED tree, not the isolated
  // worktrees: a per-worktree verify cannot see a file a sibling's commit
  // supplies (or deletes), and the #750 regression proves the combined
  // state is the only state worth testing. The combined tree is built from
  // every worktree that has commits ahead of baseSha, so the gate runs
  // when any committed worktree is non-trivial to consolidate — i.e. any
  // worktree with committed work exists and the root itself is not the
  // only worktree (N=1 with the root as the worktree is the combined tree).
  const consolidationNeeded = changedWorktrees.length > 0;
  // #750 — the consolidated run (which owns the dirty-root refusal at its
  // preflight) must run whenever there is ANY committed worktree: the
  // refusal fires even for the N=1 case where the only worktree is the
  // root itself, because operator residue on the root must not be swept
  // into the PR just because the combined tree is trivially the root.
  if (!consolidationNeeded || !isValidSha(baseSha)) {
    // No consolidation possible: the per-worktree results are the verdict.
    // The only reachable skip is "changed work exists but no valid baseSha"
    // (without it the combined tree cannot be built); with no changed
    // worktrees there is nothing to combine, so no note is recorded.
    failures.push(...perWorktreeVerifyFailures);
    if (consolidationNeeded && !isValidSha(baseSha)) {
      notes.push(
        "consolidated verify skipped — no valid baseSha to build the combined tree against, so the per-worktree evidence is the verdict",
      );
    }
    return;
  }
  const scratchDir = path.join(ctx.repoRoot, "tmp", `issue-${ctx.issue}`);
  // #782 — the consolidated-verify flake retry: fires ONLY when every
  // per-worktree verify passed, the consolidated run failed, and this is
  // a genuine consolidation (N>1). N=1 consolidation is a no-op (its
  // failure is a per-workstream defect) and per-worktree failures are
  // genuine defects the classifier names. The re-run happens inside
  // runConsolidatedVerify, BEFORE classification and BEFORE the restore.
  const flakeRetryPrecondition =
    perWorktreeVerifyFailures.length === 0 && Object.keys(worktrees).length > 1;
  const cons = await runConsolidatedVerify(execFn, {
    repoRoot: ctx.repoRoot,
    baseSha: baseSha as string,
    worktrees: state.pipelineState.worktrees ?? {},
    // #794 — own-range selection: a stacked workstream's range is
    // measured against its dependency's tip, so its ancestor commits are
    // not re-picked on top of their content (the #775 replay).
    workstreamBaseShas,
    scratchDir,
    verifyCmd: cmd,
    timeoutMs: verifyTimeoutMs(),
    retry: {
      canRetry: flakeRetryPrecondition,
      onRecover: (evidenceTail) => {
        notes.push(
          `consolidated verify RECOVERED after one bounded re-run (transient flake) — first-run failure preserved${evidenceTail ? `: ${evidenceTail}` : ""}`,
        );
        onVerifyFlakeRecovered?.(evidenceTail);
      },
    },
  });
  if (cons.status === "conflict") {
    // #725 — "conflict" has TWO causes: a genuine cherry-pick / patch-apply
    // conflict (a decomposition error) and the repoRoot-dirty preflight
    // refusal (operator residue — #668/#714). Routed on the structured
    // `kind`, not the detail prose; a dirty root is cleared with git status.
    if (cons.kind === "dirty-root") {
      failures.push(
        `consolidated verify was refused — repoRoot is dirty (${cons.detail}). Leftover residue from an earlier cycle, NOT a workstream conflict or verify failure: run \`git status\` at the repo root, clear the residue, and re-run the cycle`,
      );
    } else {
      failures.push(
        `consolidated verify could not combine the workstreams' commits — cherry-pick / apply conflict (${cons.detail}). Two workstreams edited the same lines; the decomposition is incoherent, which is distinct from a verify failure`,
      );
    }
  } else if (cons.status === "failed") {
    // #777 — classify the consolidated-tree failure (see the classifier
    // module docstring for the three-way distinction). #782 — when the
    // flake re-run happened (and also failed), the detail is the second
    // run's tail; a test that fails twice is not a flake, so the cycle
    // parks as today.
    const wsIds = Object.keys(worktrees);
    const verdict = classifyConsolidatedVerifyFailure(
      wsIds.length,
      wsIds,
      cons.detail,
      buildPerWorktreeFailuresByWs(worktrees, changedWorktrees, perWorktreeVerifyFailures),
    );
    failures.push(consolidatedFailureMessage(verdict, cmd));
  } else {
    notes.push(
      `consolidated verify passed — workstreams ${cons.applied.join(", ")} combined in one tree passed \`${cmd}\`; per-worktree verify failures are recorded as evidence, not failures, because the combined tree is the verdict for cross-worktree artifacts`,
    );
  }
  // Aggregation: a consolidated PASS downgrades per-worktree failures
  // to evidence; a consolidated FAILURE keeps them as failures.
  if (cons.status === "passed") {
    for (const f of perWorktreeVerifyFailures) notes.push(`per-worktree verify (evidence) — ${f}`);
  } else {
    failures.push(...perWorktreeVerifyFailures);
  }
}

// `verifyCmdFor` re-exported so the caller keeps its pre-#794 import
// surface (it already imports the symbol from work-driver-verify-cmd.ts;
// this re-export is a no-op safety net, kept for import-graph symmetry).
export { verifyCmdFor };

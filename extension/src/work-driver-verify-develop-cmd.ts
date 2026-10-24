import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import type { BaseHealthConsulted } from "./work-driver-verify-aggregate.ts";
/**
 * work-driver-verify-develop-cmd — the develop gate's verify-command chain.
 *
 * Extracted from `work-driver-verify-develop.ts` (AGENTS.md §12 file-size cap) in
 * the same per-gate shape #679's falsily-green check, #285's scope/fanout gate and
 * #451's ratchet/smoke gates established. It owns the three decisions that sit
 * between "a plan exists" and "the gate answered": the #1012 frontend-only skip,
 * the two-tier bound resolution, and the call into `runVerifyCommandGate` with
 * every out-parameter the develop gate threads.
 *
 * Two rules the extraction keeps deliberate:
 *
 *   - it takes `plan` and calls `plan.finish` itself, so the selected run's
 *     attribution record is written on the same path the run happened on and
 *     cannot be orphaned by a caller that returned early;
 *   - it writes NO state. The base-health verdict and the consultation record go
 *     out through `onBaseHealth`, which the caller owns — the background probe is
 *     a concurrent task, and a second writer of `pipelineState` would race the
 *     develop step.
 */
import type { VerifyCommandGateBaseHealth } from "./work-driver-verify-base-health-channels.ts";
import { developTierTimeouts } from "./work-driver-verify-budget.ts";
import { shouldSkipVerifyForFrontendOnly } from "./work-driver-verify-cmd.ts";
import type { VerifyDevelopOutcomeOptions } from "./work-driver-verify-develop-options.ts";
import type { SelectedVerifyPlan } from "./work-driver-verify-select-develop.ts";
import { runVerifyCommandGate } from "./work-driver-verify-verify-cmd.ts";
import type { BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";
import type { WorkState } from "./workflow-state.ts";

/** The two claims `aggregateVerifyOutcome` reports, owned by the caller. */
export interface DevelopBaselineLeg {
  red: boolean;
  established: boolean;
}

export async function runDevelopVerifyCommandChain(opts: {
  ctx: CycleContext;
  state: WorkState;
  execFn: NonNullable<DriverContext["verifyExecFn"]>;
  plan: SelectedVerifyPlan;
  worktrees: Record<string, string>;
  baseSha: string | undefined;
  changedWorktrees: string[];
  workstreamBaseShas: Record<string, string> | undefined;
  touchedPaths: string[];
  /** Read, not captured: the per-worktree loop above sets it as its git reads fail. */
  getGitReadFailed: () => boolean;
  failures: string[];
  notes: string[];
  options: VerifyDevelopOutcomeOptions;
  baselineLeg: DevelopBaselineLeg;
  onBaseHealth: (
    verdict: BaseHealthVerdict | undefined,
    consulted: BaseHealthConsulted | undefined,
  ) => void;
}): Promise<void> {
  const {
    ctx,
    state,
    execFn,
    plan,
    worktrees,
    baseSha,
    changedWorktrees,
    workstreamBaseShas,
    touchedPaths,
    getGitReadFailed,
    failures,
    notes,
    options,
    baselineLeg,
    onBaseHealth,
  } = opts;
  const {
    onVerifyFlakeRecovered,
    fenceViolations,
    onConsolidatedLogPath,
    onConsolidatedVerifySkipped,
    onBuildResidueOnly,
    walkProcessTree,
    hangSink,
    onGateRecorded,
  } = options;
  const cmd = plan.cmd;
  if (!cmd) {
    notes.push(
      "no verify command discoverable (.pi/verify-cmd, package.json scripts, Cargo.toml) — diff evidence only",
    );
  } else {
    // #1012 — frontend-only diffs skip the DERIVED verify chain (package.json
    // scripts, Cargo.toml cargo check): a CSS-only change must not trigger a
    // backend build. The skip is derived-only — an explicit .pi/verify-cmd is
    // operator intent and ALWAYS runs (same philosophy as PI_ENSEMBLE_VERIFY=0:
    // explicit intent beats auto-detection). Classification uses the CUMULATIVE
    // union of all worktrees' changed paths (porcelain + diff), already
    // normalised by porcelainPaths/diff parsing; an empty union (nothing
    // readable) or any non-frontend path falls back to the full chain — a
    // classification failure never skips a check. The skip-ratchet, smoke and
    // comment-retention gates below are unaffected and run unconditionally.
    // shouldSkipVerifyForFrontendOnly (work-driver-verify-cmd.ts) uses
    // fs.access (async) to check for an explicit .pi/verify-cmd — consistent
    // with verifyCmdFor's own file-access pattern (no sync fs in this gate).
    const skipDecision = await shouldSkipVerifyForFrontendOnly(
      ctx.repoRoot,
      touchedPaths,
      getGitReadFailed(),
    );
    if (skipDecision.skip) {
      notes.push(skipDecision.reason ?? "frontend-only skip");
    } else {
      // #1012 — a non-skip `reason` is diagnostic (git-failure suppression,
      // probe error, opt-in disabled): record it but still run the gate.
      // Only an actual skip suppresses the derived chain.
      if (skipDecision.reason) notes.push(skipDecision.reason);
      // #794 — the per-worktree loop, consolidated run and classification
      // live in work-driver-verify-verify-cmd.ts (500-line gate).
      // #1509 — both tier bounds come from one repoRoot in one call (see
      // `developTierTimeouts`): the fast exec takes `fast` through the wrapper,
      // the full exec takes `suite` as an argument. Deriving the fast bound from
      // `opts.timeout` inside the wrapper handed the fast tier the suite budget;
      // defaulting it inside the gate would widen every caller that never migrated.
      const tiers = await developTierTimeouts(ctx.repoRoot);
      await runVerifyCommandGate({
        suiteTierTimeoutMs: tiers.suite,
        // #1324 — `.pi/verify-cmd-fast` runs before every full run of `cmd`.
        execFn: plan.wrap(execFn),
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
        verifyRecord: options.verifyRecord,
        // #814 — the fence records the gate just wrote (the scope gate runs
        // before the consolidated verify) — so a conflict the fence already
        // recorded is attributed, not re-diagnosed as an incoherent
        // decomposition.
        ...(fenceViolations !== undefined ? { fenceViolations } : {}),
        ...(onConsolidatedLogPath !== undefined ? { onConsolidatedLogPath } : {}),
        onBaselineAttributed: () => {
          baselineLeg.red = true;
        },
        baseHealthChannels: {
          onBaseHealthCollected: (verdict) => {
            onBaseHealth(verdict, undefined);
          },
          onBaseHealthConsulted: (report) => {
            onBaseHealth(undefined, report);
          },
        },
        // #1765 — the CAP's claim, reported by `reportBaselineLeg`.
        onBaselineRedEstablished: (established) => {
          baselineLeg.established = established;
        },
        ...(onConsolidatedVerifySkipped !== undefined ? { onConsolidatedVerifySkipped } : {}),
        ...(onBuildResidueOnly !== undefined ? { onBuildResidueOnly } : {}),
        // #1427 — the walker reaches both legs; `hangSink` (round 3) is the
        // per-call sink this gate's reports land on, scoping a cap's logPaths.
        ...(walkProcessTree !== undefined ? { walkProcessTree } : {}),
        ...(hangSink !== undefined ? { hangSink } : {}),
        ...(onGateRecorded !== undefined ? { onGateRecorded } : {}),
      }).finally(() => plan.finish(options.onSelectedVerify));
    }
  }
}

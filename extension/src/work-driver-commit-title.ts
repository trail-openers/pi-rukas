/**
 * work-driver-commit-title — the commit-pr PR title derivation and the
 * integration verify timeout, moved verbatim from work-driver-commit.ts
 * for the 500-line cap (#861).
 */

import type { DriverContext } from "./work-driver-context.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import { deriveConsolidationSubject } from "./work-driver-handoff-subject.ts";
import { cachedIssueTitle } from "./work-driver-integrate.ts";
import { clipTitle } from "./work-driver-pr-body-definition.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * #818 — the commit-pr PR title and commit title, always a valid
 * conventional-commit subject.
 *
 * Derives via `deriveConsolidationSubject` (the single shared parser — the
 * handoff consolidation path derives through the same helper, so the two
 * cannot disagree) from the cached issue title, then the LIVE forge issue
 * title (the #810 pattern in work-driver-handoff-consolidate.ts), then an
 * honest `chore(work): …`. `implement issue #N` is removed: it is not a
 * conventional subject, release-please drops it, and it is exactly what
 * #771/#809 landed as. Derivation runs BEFORE clipping so the `type(scope):`
 * prefix can never be cut off.
 */
export async function deriveCommitPrTitle(
  state: WorkState,
  ctx: Pick<DriverContext, "repoRoot" | "issue">,
  execFn: (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string }>,
): Promise<string> {
  const from = async (rawTitle: string | undefined): Promise<string | undefined> =>
    rawTitle ? deriveConsolidationSubject(rawTitle) : undefined;
  const cached = await from(await cachedIssueTitle(state));
  if (cached) return clipTitle(cached, 64);
  let live: string | undefined;
  try {
    const forge = await forgeForCycle(ctx, execFn);
    if (forge) live = await from((await forge.issueView(ctx.issue)).title);
  } catch {
    live = undefined;
  }
  if (live) return clipTitle(live, 64);
  return clipTitle(`chore(work): resolve issue #${ctx.issue}`, 64);
}

/** Wall-clock for the verify run against the consolidated tree (FAST suite).
 * Exists to catch "the combination does not build". Default 15 min. */
export function integrationVerifyTimeoutMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_INTEGRATION_VERIFY_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 15 * 60_000;
}

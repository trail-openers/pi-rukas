/**
 * work-driver-commit-title — the commit-pr PR title (which is also the commit
 * subject) and the integration verify timeout.
 */

import type { DriverContext } from "./work-driver-context.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import {
  deriveConsolidationSubject,
  parseConventionalTitle,
} from "./work-driver-handoff-subject.ts";
import { cachedIssueTitle } from "./work-driver-integrate.ts";
import { fitsTitle, usesConventionalCommits } from "./work-title.ts";
import type { WorkState } from "./workflow-state.ts";

/** A title's text without any type prefix it already carries. */
function bare(title: string): string {
  return parseConventionalTitle(title).description || title.trim();
}

/**
 * The commit-pr PR title and commit subject: a complete phrase, never cut.
 *
 * The text is the spec's own title when explore wrote one that fits
 * (work-title.ts settles it), else the WHOLE issue title — cached, then read
 * live from the forge — else `resolve issue #N`. A `type(scope):` prefix is
 * added only when the target repo writes conventional subjects; the type and
 * scope still come from the issue title through `deriveConsolidationSubject`,
 * the one parser the handoff consolidation shares.
 */
export async function deriveCommitPrTitle(
  state: WorkState,
  ctx: Pick<DriverContext, "repoRoot" | "issue">,
  execFn: (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string }>,
): Promise<string> {
  let issueTitle = (await cachedIssueTitle(state))?.trim() || undefined;
  if (issueTitle === undefined) {
    try {
      const forge = await forgeForCycle(ctx, execFn);
      if (forge) issueTitle = (await forge.issueView(ctx.issue)).title?.trim() || undefined;
    } catch {
      issueTitle = undefined;
    }
  }
  const specTitle = state.pipelineState.normalisedSpec?.title;
  const text = fitsTitle(specTitle)
    ? bare(specTitle)
    : issueTitle !== undefined
      ? bare(issueTitle)
      : `resolve issue #${ctx.issue}`;
  if (!(await usesConventionalCommits(ctx.repoRoot, state.pipelineState.baseSha, execFn))) {
    return text;
  }
  return deriveConsolidationSubject(issueTitle ?? "", text) ?? `chore(work): ${text}`;
}

/** Wall-clock for the verify run against the consolidated tree (FAST suite).
 * Exists to catch "the combination does not build". Default 15 min. */
export function integrationVerifyTimeoutMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_INTEGRATION_VERIFY_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 15 * 60_000;
}

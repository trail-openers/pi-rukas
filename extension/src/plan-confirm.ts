import { parseOperatorDirectives } from "./plan-directives.ts";
/**
 * plan-confirm — #1043: an identical confirming call files the REVIEWED dry run.
 *
 * A filing call (dryRun omitted) whose descriptor, context, type and git HEAD
 * match a dry run cached within the expiry, and whose dry run was FILEABLE
 * (no unresolved CRITICAL gap, no gate that failed to run or parse), files the
 * dry run's drafted title and body VERBATIM. The operator reviewed exactly those
 * bytes, so no inventory, investigation, drafting or gap gate runs again, and
 * the result says so ("FILED FROM REVIEWED DRY RUN").
 *
 * Anything else — a changed input, a moved HEAD, an expired or malformed entry,
 * or a dry run that was not fileable — is a miss, and the driver runs the normal
 * pipeline (plan-driver.ts). A failed forge call keeps the entry, so a retry can
 * file the same reviewed bytes; a successful filing consumes it, so a repeated
 * identical confirm cannot file a second copy. Working-tree edits made after the
 * dry run are not part of the key and are not re-read: the spec was already
 * drafted and reviewed, and filing it does not depend on the tree.
 */
import type { MechanicalInventory } from "./plan-draft.ts";
import { haltResult } from "./plan-driver-halt.ts";
import {
  type ClaimedDryRun,
  claimFileableDryRun,
  concurrentFilingOf,
} from "./plan-filing-claim.ts";
import { type FilingFailure, fileIssue, getPlanForge, planForgeFor } from "./plan-filing.ts";
import type { InvestigationResult } from "./plan-investigate.ts";
import {
  type CacheInputs,
  type PlanGitState,
  consumeInvestigationCache,
  writeInvestigationCache,
} from "./plan-investigation-cache.ts";
import {
  type PlanDriverInput,
  type PlanGap,
  type PlanPhaseTiming,
  type PlanResult,
  planTitle,
} from "./plan-types.ts";
import { FORGE_BODY_MAX, bodyContainsForbiddenPhrase } from "./plan-validate.ts";
import { trace } from "./trace.ts";

/** What a finished pipeline run hands the cache: its inputs' outputs and verdict. */
export interface SettleRun {
  dryRun?: boolean;
  issueUrl?: string;
  filingFailure?: FilingFailure;
  inventory: MechanicalInventory;
  barrier: InvestigationResult;
  gaps: PlanGap[];
  title: string;
  spec: string;
  priorContext: { source: string; fact: string }[];
  failedAngles?: { name: string; detail: string }[];
}

/**
 * Record a finished run. A dry run is cached with its reviewed spec and
 * fileability (a non-fileable one still feeds the reuse and the gate seed); a
 * filed run consumes the entry so an identical confirm cannot file it again.
 */
export async function settlePlanCache(
  git: PlanGitState | undefined,
  inputs: CacheInputs | undefined,
  run: SettleRun,
): Promise<void> {
  if (!git || !inputs) return;
  const cacheDir = git.cacheDir;
  if (run.dryRun) {
    await writeInvestigationCache(cacheDir, inputs, {
      inventory: run.inventory,
      barrier: run.barrier,
      gaps: run.gaps,
      reviewed: {
        fileable: !run.filingFailure,
        title: run.title,
        spec: run.spec,
        priorContext: run.priorContext,
        failedAngles: run.failedAngles,
      },
    });
  } else if (run.issueUrl) {
    await consumeInvestigationCache(cacheDir, inputs);
  }
}

/**
 * Why a claimed dry run may NOT be filed verbatim, re-checked against the
 * CURRENT call (the cached spec was checked against the dry run's context):
 * a NEVER CLAIM phrase now in a generated section (validateDraft's rule), or a
 * body over the forge's limit. Undefined when the spec may file.
 */
function verbatimRefusal(spec: string, context: string | undefined): string | undefined {
  const phrases = parseOperatorDirectives(context).neverClaim ?? [];
  const hits = bodyContainsForbiddenPhrase(spec, phrases);
  if (hits.length > 0) {
    const named = hits.map((h) => `"${h}"`).join(", ");
    return `a NEVER CLAIM phrase appears in a generated section: ${named}`;
  }
  if (spec.length > FORGE_BODY_MAX) {
    return `the spec is ${spec.length} chars, over the forge's ${FORGE_BODY_MAX}-char body limit`;
  }
  return undefined;
}

/**
 * The verbatim path for one call: a confirm (dryRun omitted) with a cache and
 * git state. A dry run never takes it — it is the thing being confirmed.
 */
export async function confirmVerbatim(
  git: PlanGitState | undefined,
  inputs: CacheInputs | undefined,
  input: PlanDriverInput,
  repoRoot: string,
  finishTimings: () => PlanPhaseTiming[],
): Promise<PlanResult | undefined> {
  if (input.dryRun || !git || !inputs) return undefined;
  return fileReviewedDryRun(git.cacheDir, inputs, repoRoot, finishTimings, input.reviewedDigest);
}

/**
 * File the reviewed spec of a matching, fileable dry run. Verbatim filing needs
 * the `reviewedDigest` the dry run reported: without it, or when the claimed
 * entry's title + body does not hash to it, or when the cheap deterministic
 * checks now refuse, the entry is put back and the call is a miss (the caller
 * runs the full pipeline). Undefined on any miss; a concurrent identical confirm
 * is refused rather than re-run.
 */
export async function fileReviewedDryRun(
  cacheDir: string,
  inputs: CacheInputs,
  repoRoot: string,
  finishTimings: () => PlanPhaseTiming[],
  reviewedDigest?: string,
): Promise<PlanResult | undefined> {
  if (reviewedDigest !== undefined) {
    const claimed = await claimFileableDryRun(cacheDir, inputs, { digest: reviewedDigest });
    if (claimed) {
      const refusal = verbatimRefusal(claimed.reviewed.spec, inputs.context);
      if (!refusal) return fileClaimed(claimed, inputs, repoRoot, finishTimings);
      trace(`plan-confirm: verbatim filing refused — running the full pipeline (${refusal})`);
      await claimed.release();
    }
  }
  // A miss runs the pipeline. An identical confirm that is already filing (or
  // just filed) must NOT: the pipeline would re-investigate and could file a
  // second issue before the first one is visible to its duplicate check.
  const busy = await concurrentFilingOf(cacheDir, inputs);
  if (!busy) return undefined;
  const detail = busy.url
    ? `an identical confirm filed this dry run as ${busy.url} moments ago — refusing a second copy`
    : "an identical confirm is already filing this dry run — refusing a concurrent second copy; re-call once it has finished";
  return haltResult({
    type: inputs.type,
    title: planTitle(inputs.descriptor, inputs.type),
    spec: `(not filed — ${detail})`,
    priorContext: [],
    failure: { reason: "filing-in-progress", detail },
    timings: finishTimings(),
  });
}

/** File a claimed entry's reviewed bytes; a failed forge call keeps the entry. */
async function fileClaimed(
  claimed: ClaimedDryRun,
  inputs: CacheInputs,
  repoRoot: string,
  finishTimings: () => PlanPhaseTiming[],
): Promise<PlanResult> {
  const { title, spec, priorContext, failedAngles } = claimed.reviewed;
  // A throw from the forge releases the claim before propagating.
  const { url, failure } = await fileIssue(
    title,
    spec,
    getPlanForge() ?? (() => planForgeFor(repoRoot)),
  ).catch(async (err: unknown) => {
    await claimed.release();
    throw err;
  });
  // Consume only once the forge answered: a failed filing keeps the entry.
  if (url) await claimed.commit(url);
  else await claimed.release();
  return {
    type: inputs.type,
    title,
    spec,
    gaps: claimed.gaps,
    priorContext,
    failedAngles: failedAngles && failedAngles.length > 0 ? failedAngles : undefined,
    filed: !!url,
    issueUrl: url,
    filingFailure: failure,
    filedFromDryRun: url ? { ageMs: claimed.ageMs } : undefined,
    timings: finishTimings(),
  };
}

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
 * What the verbatim path deliberately SKIPS, and why. Skipped: the inventory,
 * the investigation (angles and the LLM duplicate-risk check), drafting and
 * validate-draft, and the LLM gap gate. Re-running them is what let a fresh
 * review block a spec the operator had already reviewed and approved — the
 * dry run's verdict was the review, and a second, different review of the same
 * bytes is noise that can only refuse. What it still RE-CHECKS is cheap and
 * deterministic (validateFinalSpec in plan-validate.ts: the NEVER CLAIM block and
 * the forge's body limit), because those depend on the current call's context
 * and the forge, not on a model's judgement.
 *
 * Anything else — a changed input, a moved HEAD, an expired or malformed entry,
 * or a dry run that was not fileable — is a miss, and the driver runs the normal
 * pipeline (plan-driver.ts). When such a miss carried the reviewedDigest and the
 * pipeline drafts different bytes, it does not file them (#1224, heldForReview):
 * the operator approved the reviewed spec, not whatever a re-run produces.
 * A failed forge call keeps the entry, so a retry can
 * file the same reviewed bytes; a successful filing consumes it, so a repeated
 * identical confirm cannot file a second copy. Working-tree edits made after the
 * dry run are not part of the key and are not re-read: the spec was already
 * drafted and reviewed, and filing it does not depend on the tree.
 */
import type { MechanicalInventory } from "./plan-draft.ts";
import { buildPlanResult, haltResult } from "./plan-driver-halt.ts";
import {
  type ClaimedDryRun,
  claimFileableDryRun,
  concurrentFilingOf,
  reviewedDigestOf,
} from "./plan-filing-claim.ts";
import { type FilingFailure, fileIssue, getPlanForge, planForgeFor } from "./plan-filing.ts";
import type { InvestigationResult } from "./plan-investigate.ts";
import {
  type CacheInputs,
  type PlanGitState,
  dropInvestigationCache,
  entryFile,
  investigationCacheKey,
  readEntryAt,
  withinPlanCacheTtl,
  writeInvestigationCache,
} from "./plan-investigation-cache.ts";
import {
  type PlanDriverInput,
  type PlanGap,
  type PlanPhaseTiming,
  type PlanResult,
  planTitle,
} from "./plan-types.ts";
import { validateFinalSpec } from "./plan-validate.ts";
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
    await dropInvestigationCache(cacheDir, inputs);
  }
}

/**
 * The verbatim path for one call: a confirm (dryRun omitted) with a cache and
 * git state. A dry run never takes it — it is the thing being confirmed.
 * `result` is set when the call is answered here; otherwise the caller runs the
 * pipeline, and `missReason` (set only for a confirm that carried a digest) says
 * why the reviewed spec could not be filed verbatim — see heldForReview.
 */
export async function confirmVerbatim(
  git: PlanGitState | undefined,
  inputs: CacheInputs | undefined,
  input: PlanDriverInput,
  repoRoot: string,
  finishTimings: () => PlanPhaseTiming[],
): Promise<{ result?: PlanResult; missReason?: string }> {
  if (input.dryRun) return {};
  const digest = input.reviewedDigest;
  if (!git || !inputs) {
    return digest === undefined
      ? {}
      : {
          missReason:
            "the plan cache is unavailable (no origin/<default> commit to key on, or caching disabled)",
        };
  }
  const result = await fileReviewedDryRun(git.cacheDir, inputs, repoRoot, finishTimings, digest);
  if (result || digest === undefined) return { result };
  return { missReason: await verbatimMissReason(git.cacheDir, inputs, digest) };
}

/**
 * Why a digest-carrying confirm missed, read from the entry as it is now (the
 * pipeline has not yet overwritten it). Operator-facing; first failing check wins.
 */
async function verbatimMissReason(
  cacheDir: string,
  inputs: CacheInputs,
  digest: string,
): Promise<string> {
  const entry = await readEntryAt(entryFile(cacheDir, inputs));
  if (!entry) {
    return `no reviewed dry run is cached for these inputs in ${cacheDir} (a fresh clone, a removed cache, or a changed descriptor, context or type)`;
  }
  if (entry.key !== investigationCacheKey(inputs))
    return "origin/<default> moved since the dry run";
  const ageMs = Date.now() - entry.createdAt;
  if (!withinPlanCacheTtl(ageMs)) {
    return `the reviewed dry run expired (${Math.round(ageMs / 60_000)} min old; PI_ENSEMBLE_PLAN_CACHE_TTL_MS sets the limit)`;
  }
  if (!entry.reviewed.fileable) return "the dry run was not fileable";
  if (reviewedDigestOf(entry.reviewed.title, entry.reviewed.spec) !== digest) {
    return "the reviewedDigest does not match the cached dry run";
  }
  return "the cached spec no longer passes the final-spec checks";
}

/**
 * #1224 — a confirm that carried a reviewedDigest but could not file it verbatim
 * ran the full pipeline, which may draft a DIFFERENT spec (a fresh investigation,
 * a fresh gate). Filing that would file bytes the operator never saw, so the run
 * is held: not filed, cached as a dry run, and the result asks again. A re-run
 * that reproduces the reviewed bytes exactly files as before. Undefined = file.
 */
export function heldForReview(
  input: PlanDriverInput,
  missReason: string | undefined,
  title: string,
  spec: string,
): { reason: string } | undefined {
  if (input.dryRun || input.reviewedDigest === undefined) return undefined;
  if (reviewedDigestOf(title, spec) === input.reviewedDigest) return undefined;
  const reason = missReason ?? "the reviewed dry run could not be filed verbatim";
  trace(
    `plan-confirm: confirm held — the re-drafted spec differs from the reviewed one (${reason})`,
  );
  return { reason };
}

/**
 * Claim a matching entry AND check it, failing closed: any exception while the
 * entry is claimed or checked is a miss (traced), and a claim that did not pass
 * the final-spec checks is put back. Only the forge call (fileClaimed) may throw
 * out of the verbatim path.
 */
async function claimVerbatim(
  cacheDir: string,
  inputs: CacheInputs,
  digest: string,
): Promise<ClaimedDryRun | undefined> {
  let claimed: ClaimedDryRun | undefined;
  try {
    claimed = await claimFileableDryRun(cacheDir, inputs, { digest });
    if (!claimed) return undefined;
    const check = validateFinalSpec(claimed.reviewed.title, claimed.reviewed.spec, inputs.context);
    if (check.ok) return claimed;
    trace(
      `plan-confirm: verbatim filing refused — running the full pipeline (${check.problems.join("; ")})`,
    );
  } catch (err) {
    trace(
      `plan-confirm: cached dry run unusable for verbatim filing — treated as a miss (${(err as Error).message})`,
    );
  }
  await claimed?.release().catch(() => undefined);
  return undefined;
}

/**
 * File the reviewed spec of a matching, fileable dry run. Verbatim filing needs
 * the `reviewedDigest` the dry run reported: without it, when the entry's title +
 * body does not hash to it, or when the final-spec checks now refuse, the entry
 * is left as it was (or put back) and the call is a miss (the caller runs the
 * full pipeline). Undefined on any miss; a concurrent identical confirm is
 * refused rather than re-run.
 */
export async function fileReviewedDryRun(
  cacheDir: string,
  inputs: CacheInputs,
  repoRoot: string,
  finishTimings: () => PlanPhaseTiming[],
  reviewedDigest?: string,
): Promise<PlanResult | undefined> {
  if (reviewedDigest !== undefined) {
    const claimed = await claimVerbatim(cacheDir, inputs, reviewedDigest);
    if (claimed) return fileClaimed(claimed, inputs, repoRoot, finishTimings);
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
  return buildPlanResult({
    type: inputs.type,
    title,
    spec,
    gaps: claimed.gaps,
    priorContext,
    issueUrl: url,
    filingFailure: failure,
    failedAngles,
    filedFromDryRun: url ? { ageMs: claimed.ageMs } : undefined,
    timings: finishTimings(),
  });
}

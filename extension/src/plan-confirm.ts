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
 * #1383 scope note: the verbatim path is deliberately NOT cap-aware. It files
 * cached bytes the operator reviewed, so re-running any renderer (including the
 * bounded dropped-section renderer) would file something other than what was
 * approved. An over-limit cached body is therefore refused by `validateFinalSpec`,
 * exactly as before — the operator re-runs `start_plan_driver` to get a bounded
 * draft to review.
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
import type { PlanProvenance } from "./plan-provenance.ts";
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
  /**
   * #1377: what the filing would send beyond the body — recorded with the
   * reviewed bytes so a verbatim confirm files the same labels and appends the
   * same provenance lines, and so the digest both sides compute matches.
   */
  labels?: string[];
  provenance?: PlanProvenance;
  /**
   * #1854: the repository the run targets. Recorded with the reviewed bytes for
   * the same reason `labels` is: it is part of what the operator approved, and a
   * confirm aimed elsewhere has to be NAMEABLE rather than surface as an opaque
   * digest mismatch. A digest input, so it reaches the hash through
   * `DigestInputs.target`.
   */
  target?: string;
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
        // #1377: stored only when the caller asked for them, so a dry run with
        // no labels/provenance writes the byte-identical entry it wrote before.
        labels: run.labels?.length ? run.labels : undefined,
        provenance: run.provenance,
        // #1854: likewise absent for a session-repo run, so the entries an
        // omitted target writes keep the shape they had before this parameter.
        target: run.target,
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
  /** #1854: this call's canonical target identity (absent → the session repo). */
  targetIdentity?: string,
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
  const result = await fileReviewedDryRun(
    git.cacheDir,
    inputs,
    repoRoot,
    finishTimings,
    digest,
    // #1854: the repository THIS call targets — what the miss reason compares
    // with the target the entry recorded, and what the filed report names as the
    // destination.
    targetIdentity,
  );
  if (result || digest === undefined) return { result };
  return { missReason: await verbatimMissReason(git.cacheDir, inputs, digest, targetIdentity) };
}

/**
 * Why a digest-carrying confirm missed, read from the entry as it is now (the
 * pipeline has not yet overwritten it). Operator-facing; first failing check wins.
 */
async function verbatimMissReason(
  cacheDir: string,
  inputs: CacheInputs,
  digest: string,
  currentTarget?: string,
): Promise<string> {
  const entry = await readEntryAt(entryFile(cacheDir, inputs));
  if (!entry) {
    return `no reviewed dry run is cached for these inputs in ${cacheDir} (a fresh clone, a removed cache, or a changed descriptor, context, type, source issue or target repository)`;
  }
  // #1854: the entry is read here under the CURRENT target's lineage, so a
  // different target normally lands on the "no reviewed dry run" arm above. If
  // the recorded target still disagrees (an entry written before the term
  // existed, or a hand-edited file) say so: the operator is holding a spec whose
  // destination changed, not a spec whose text did, and "THE REVIEWED SPEC
  // CHANGED" would send them to re-read bytes that are identical.
  if ((entry.reviewed.target ?? "") !== (currentTarget ?? "")) {
    return `the reviewed dry run targeted ${
      entry.reviewed.target ?? "the session repository"
    }, not ${currentTarget ?? "the session repository"} — the spec did not change, the destination did`;
  }
  if (entry.key !== investigationCacheKey(inputs))
    return "origin/<default> moved since the dry run";
  const ageMs = Date.now() - entry.createdAt;
  if (!withinPlanCacheTtl(ageMs)) {
    return `the reviewed dry run expired (${Math.round(ageMs / 60_000)} min old; PI_ENSEMBLE_PLAN_CACHE_TTL_MS sets the limit)`;
  }
  if (!entry.reviewed.fileable) return "the dry run was not fileable";
  // #1377: the digest covers the labels and provenance the ENTRY recorded, not
  // the ones this call passed — a confirm that changed either is a digest
  // mismatch, and the reason says so rather than the generic one.
  if (
    reviewedDigestOf(entry.reviewed.title, entry.reviewed.spec, {
      labels: entry.reviewed.labels,
      provenance: entry.reviewed.provenance,
      // #1854: the digest the entry was written with included its target; the
      // comparison must use the same tuple or every confirm mismatches on a
      // cross-repo dry run.
      target: entry.reviewed.target,
    }) !== digest
  ) {
    return "the reviewedDigest does not match the cached dry run (title, body, labels or provenance changed)";
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
  /**
   * #1854: the run's CANONICAL target identity — the term the dry run's digest
   * was built from (plan-driver.ts derives it once, plan-driver-result.ts hashes
   * it). REQUIRED and non-optional so no call site can quietly hash the caller's
   * raw `targetRepository` instead: that is a different string whenever the caller
   * spelled the destination non-canonically, and a comparison of two hashers that
   * disagree on one term holds a run whose bytes the operator did review. A
   * session-repo run passes `undefined` — the same term its dry run hashed.
   */
  targetIdentity: string | undefined,
): { reason: string } | undefined {
  if (input.dryRun || input.reviewedDigest === undefined) return undefined;
  // #1377: the same inputs the dry run hashed — labels and provenance are part
  // of what was reviewed, so a re-draft is compared on all of them.
  if (
    reviewedDigestOf(title, spec, {
      labels: input.labels,
      provenance: input.provenance,
      // #1854: the destination is part of what was reviewed, so a re-draft is
      // compared on it too — the same rule #1377 applies to labels.
      target: targetIdentity,
    }) === input.reviewedDigest
  ) {
    return undefined;
  }
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
  /**
   * #1854: this call's resolved target identity — for the miss reason, and for
   * the filed report's target section.
   */
  currentTarget?: string,
): Promise<PlanResult | undefined> {
  if (reviewedDigest !== undefined) {
    const claimed = await claimVerbatim(cacheDir, inputs, reviewedDigest);
    if (claimed) return fileClaimed(claimed, inputs, repoRoot, finishTimings, currentTarget);
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
  /**
   * #1854: this call's canonical target identity, so the steer for the one run
   * that mints the issue names the destination. Verbatim filing builds its result
   * directly (no re-draft to report on), so without this the field is absent and
   * `renderPlanResult` emits no `TARGET REPOSITORY` section — the dry run for the
   * same spec showed one, and the run that actually filed does not.
   */
  currentTarget?: string,
): Promise<PlanResult> {
  const { title, spec, priorContext, failedAngles } = claimed.reviewed;
  // #1377: the reviewed entry's OWN labels and provenance — the bytes the
  // operator saw, which the digest just proved match. The call's own inputs are
  // never consulted here (that is what makes it verbatim), and the label check
  // does not re-run: the dry run already refused to call these fileable unless
  // every label existed.
  const labels = claimed.reviewed.labels ?? [];
  // #1377: the forge is resolved ONCE and the same adapter files — the label
  // gate does not re-run here (the dry run already refused to call these
  // fileable unless every label existed), but a filing that resolved its forge
  // per call would pay the detection read again for no benefit.
  const forge = (await (getPlanForge() ?? (() => planForgeFor(repoRoot)))()) ?? undefined;
  // A throw from the forge releases the claim before propagating.
  const {
    url,
    number: issueNumber,
    failure,
  } = await fileIssue(title, spec, () => Promise.resolve(forge), {
    labels,
  }).catch(async (err: unknown) => {
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
    // Absent for a session-repo run, exactly as in the final result: an omitted
    // input keeps the pre-#1854 report bytes.
    ...(currentTarget ? { targetRepository: currentTarget } : {}),
    gaps: claimed.gaps,
    priorContext,
    issueUrl: url,
    issueNumber,
    filingFailure: failure,
    failedAngles,
    filedFromDryRun: url ? { ageMs: claimed.ageMs } : undefined,
    timings: finishTimings(),
  });
}

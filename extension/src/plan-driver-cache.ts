import type { PlanBase } from "./plan-base-tree.ts";
/**
 * plan-driver-cache — the cache half of one /plan run (#1043, #1132, #1854).
 *
 * Split out of plan-driver.ts at the AGENTS.md §12 size cap. The driver keeps
 * the orchestration; this file owns the three things a run must get right about
 * the investigation cache before it dispatches anything:
 *
 *   - the CACHE KEY INPUTS — everything that names one plan (descriptor, context,
 *     type, depth, source issue, and since #1854 the target repository) plus the
 *     run's base SHA. Two repositories must never share a lineage entry: the
 *     cached barrier is the investigation of a DIFFERENT codebase, and a dry run
 *     reviewed against one repository cannot answer for a confirm aimed at another.
 *   - the DROP — a dry run deletes its lineage's entry before it starts, so a dry
 *     run that halts (precheck, duplicate risk, a failed angle fan-out) leaves no
 *     fileable verdict behind for an identical confirm to file verbatim.
 *   - the SEED — the most recent dry run's gap-gate findings, read BEFORE the drop
 *     and handed to the gate as "already settled", at any head and any age.
 *
 * Read order matters: the settled gaps are read first, then the drop, because a
 * dry run is both the reader of the last run's findings and the writer of the
 * next one's verdict.
 */
import {
  type CacheInputs,
  type PlanGitState,
  dropInvestigationCache,
  readSettledGaps,
  resolvePlanGitState,
} from "./plan-investigation-cache.ts";
import type { PlanDriverInput, PlanGap, PlanType } from "./plan-types.ts";

/** What names one plan, everything except the base SHA. */
export interface CacheLineageArgs {
  descriptor: string;
  context?: string;
  type: PlanType;
  depth: number;
  sourceIssue?: number;
  /** #1854: canonical `host/owner/repo`, absent for the session repository. */
  target?: string;
}

/**
 * The lineage of one run, from the run's own inputs. Lives here rather than in the
 * orchestrator because the fields are this module's own key shape: #1854 added the
 * destination, and the builder and the key it feeds belong on the same side of the
 * seam so a new lineage term cannot be added to one and forgotten in the other.
 */
export function cacheLineage(
  input: PlanDriverInput,
  descriptor: string,
  context: string | undefined,
  type: PlanType,
  depth: number,
  targetIdentity: string | undefined,
): CacheLineageArgs {
  return {
    descriptor,
    context,
    type,
    depth,
    sourceIssue: input.sourceIssue,
    ...(targetIdentity ? { target: targetIdentity } : {}),
  };
}

/** The cache state one run carries: its key inputs, its seed, and its git state. */
export interface RunCacheState {
  git: PlanGitState | undefined;
  inputs: CacheInputs | undefined;
  /** The previous dry run's findings, seeding this run's gap gate. */
  settled: PlanGap[];
}

/**
 * Resolve the run's cache state, or nothing at all when there is no key. A run
 * with no base SHA neither reads nor writes the cache (there is no SHA to key on)
 * and proceeds exactly as it did before the cache existed.
 *
 * `dropForDryRun` is the dry-run half of the protocol: true for a dry run (which
 * is the thing being confirmed, and so must never read a cached verdict), false
 * for a filing run (which reads the cache below in the driver).
 */
export async function openRunCache(
  repoRoot: string,
  base: PlanBase,
  lineage: CacheLineageArgs,
  dropForDryRun: boolean,
): Promise<RunCacheState> {
  const git = await resolvePlanGitState(repoRoot, base);
  if (!git) return { git: undefined, inputs: undefined, settled: [] };
  const inputs: CacheInputs = {
    descriptor: lineage.descriptor,
    context: lineage.context,
    type: lineage.type,
    keySha: git.keySha,
    depth: lineage.depth,
    sourceIssue: lineage.sourceIssue,
    // #1854: one lineage per repository.
    ...(lineage.target ? { target: lineage.target } : {}),
  };
  const settled = await readSettledGaps(git.cacheDir, inputs);
  if (dropForDryRun) await dropInvestigationCache(git.cacheDir, inputs);
  return { git, inputs, settled };
}

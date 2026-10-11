/**
 * plan-investigation-cache — reuse a confirmed dry run's investigation.
 *
 * `start_plan_driver` is non-resumable, so a confirmed dry run used to pay
 * inventory + duplicate-risk + the angle fan-out a second time before filing
 * (the largest modeled cost item, outputs/spec-driven-plan-driver-gap.md).
 * A successful dry run now stores its inventory and investigation barrier
 * (duplicate-risk verdict, angle items, NEVER CLAIM disclosure); a filing run
 * whose descriptor, context, type and git HEAD all match, within a bounded
 * expiry, reuses them. Drafting, validation and the gap gate ALWAYS re-run —
 * the gate verdict is the part whose freshness matters most.
 *
 * The same file also carries the dry run's gap-gate findings. The gate is
 * seeded with them as "already settled" (plan-gaps.ts) on hit and miss alike,
 * so a re-review does not re-raise what the operator already saw.
 *
 * It also carries the dry run's FINAL drafted spec (title + body, byte-exact)
 * and its fileability verdict. An identical confirming call whose dry run was
 * fileable files that spec verbatim (plan-confirm.ts) — the operator reviewed
 * exactly those bytes, so nothing is re-investigated, re-drafted or re-gated.
 * A non-fileable dry run is cached too, but only feeds the investigation reuse
 * and gate seed; it never files on its own.
 *
 * Staleness is keyed on git HEAD only. Uncommitted working-tree edits are NOT
 * part of the key; the result says so (plan-tool.ts).
 *
 * Storage: one file per lineage (descriptor + context + type) under the clone's
 * git common dir (`<common-dir>/pi-plan-cache/`), so it is never tracked. The
 * stored entry carries the full key; a reader accepts it only on an exact key
 * match and inside INVESTIGATION_CACHE_TTL_MS. Every failure fails open: an
 * unreadable or corrupt entry is a miss, and a failed write costs only the
 * next run's reuse — never the run itself.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { MechanicalInventory } from "./plan-draft.ts";
import type { InvestigationResult } from "./plan-investigate.ts";
import type { PlanGap, PlanType } from "./plan-types.ts";
import { trace } from "./trace.ts";

const execFileP = promisify(execFile);

/** Bounded expiry: a dry run older than this is not reused (2 hours). */
export const INVESTIGATION_CACHE_TTL_MS = 2 * 60 * 60_000;

/**
 * How long a claim (an in-flight filing) or a filed-marker (a filing that just
 * completed) refuses a concurrent identical confirm. Filing is seconds; a claim
 * older than this is a crash leftover and no longer counts.
 */
export const RECENT_FILING_WINDOW_MS = 10 * 60_000;

export interface CacheInputs {
  descriptor: string;
  context?: string;
  type: PlanType;
  head: string;
}

export interface CachedInvestigation {
  inventory: MechanicalInventory;
  barrier: InvestigationResult;
  /** The dry run's gap-gate findings — seed for the gate on a miss. */
  gaps: PlanGap[];
  /** What the dry run drafted and whether it was fileable (#1043). */
  reviewed: ReviewedDryRun;
}

/** The reviewed dry run: the exact title/body the operator saw, and its verdict. */
export interface ReviewedDryRun {
  /**
   * False when the dry run's gap gate or validation blocked filing (an
   * unresolved CRITICAL gap, a gate that never ran, an unparseable review).
   * Duplicate-risk and precheck halts never reach the cache at all.
   */
  fileable: boolean;
  title: string;
  spec: string;
  priorContext: { source: string; fact: string }[];
  /** Angles that failed in the dry run — disclosed again on a verbatim filing. */
  failedAngles?: { name: string; detail: string }[];
}

interface InvestigationCacheEntry extends CachedInvestigation {
  key: string;
  createdAt: number;
}

export interface PlanGitState {
  head: string;
  cacheDir: string;
}

type GitStateFn = (repoRoot: string) => Promise<PlanGitState | undefined>;

let _gitStateOverride: GitStateFn | null = null;

/** Set a git-state stub (HEAD + cache dir) for the next runs (tests). `null` clears it. */
export function setPlanGitStateFn(fn: GitStateFn | null): void {
  _gitStateOverride = fn;
}

/**
 * HEAD and the per-clone cache dir. Undefined when HEAD is unreadable (for
 * example an unborn branch) — caching is then skipped and the run proceeds
 * exactly as it did before this module existed.
 */
export async function resolvePlanGitState(repoRoot: string): Promise<PlanGitState | undefined> {
  if (_gitStateOverride) return _gitStateOverride(repoRoot);
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir", "HEAD"],
      { timeout: 10_000 },
    );
    const [commonDir, head] = stdout.trim().split("\n");
    if (!commonDir || !head) return undefined;
    return { head, cacheDir: path.join(commonDir, "pi-plan-cache") };
  } catch (err) {
    trace(
      `plan-investigation-cache: git state unreadable — caching skipped (${(err as Error).message})`,
    );
    return undefined;
  }
}

const digest = (parts: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** The inputs that name one plan, everything except git HEAD. */
function lineageOf(i: Omit<CacheInputs, "head">): string {
  // `?? null` keeps an absent context (undefined) distinct from "" and " ".
  return digest(["plan-lineage-v1", i.descriptor.trim(), i.context ?? null, i.type]);
}

/** Full cache key: the lineage plus git HEAD. */
export function investigationCacheKey(i: CacheInputs): string {
  return digest(["plan-investigation-v1", lineageOf(i), i.head]);
}

function entryFile(cacheDir: string, i: Omit<CacheInputs, "head">): string {
  return path.join(cacheDir, `${lineageOf(i)}.json`);
}

function isEntry(x: unknown): x is InvestigationCacheEntry {
  if (!x || typeof x !== "object") return false;
  const e = x as Partial<InvestigationCacheEntry>;
  return (
    typeof e.key === "string" &&
    typeof e.createdAt === "number" &&
    !!e.inventory &&
    typeof e.inventory === "object" &&
    !!e.barrier &&
    Array.isArray(e.barrier.findings) &&
    Array.isArray(e.barrier.neverClaimDisclosure) &&
    (e.barrier.duplicateRisk === undefined ||
      (typeof e.barrier.duplicateRisk === "object" &&
        typeof e.barrier.duplicateRisk.level === "string" &&
        typeof e.barrier.duplicateRisk.rationale === "string")) &&
    Array.isArray(e.gaps) &&
    isReviewed(e.reviewed)
  );
}

function isReviewed(x: unknown): x is ReviewedDryRun {
  if (!x || typeof x !== "object") return false;
  const r = x as Partial<ReviewedDryRun>;
  return (
    typeof r.fileable === "boolean" &&
    typeof r.title === "string" &&
    typeof r.spec === "string" &&
    Array.isArray(r.priorContext) &&
    (r.failedAngles === undefined || Array.isArray(r.failedAngles)) &&
    // A fileable entry must carry something to file.
    (!r.fileable || (r.title.trim().length > 0 && r.spec.trim().length > 0))
  );
}

async function readEntryAt(file: string): Promise<InvestigationCacheEntry | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return isEntry(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readEntry(
  cacheDir: string,
  i: Omit<CacheInputs, "head">,
): Promise<InvestigationCacheEntry | undefined> {
  return readEntryAt(entryFile(cacheDir, i));
}

/**
 * The reusable investigation for these exact inputs, with the dry run's age.
 * Undefined on any mismatch (key, expiry, missing or corrupt file).
 */
export async function readInvestigationCache(
  cacheDir: string,
  inputs: CacheInputs,
  now: number = Date.now(),
): Promise<{ cached: CachedInvestigation; ageMs: number } | undefined> {
  const entry = await readEntry(cacheDir, inputs);
  if (!entry || entry.key !== investigationCacheKey(inputs)) return undefined;
  const ageMs = now - entry.createdAt;
  if (ageMs < 0 || ageMs > INVESTIGATION_CACHE_TTL_MS) return undefined;
  return { cached: entry, ageMs };
}

/** A FILEABLE dry run this call holds exclusively until it commits or releases it. */
export interface ClaimedDryRun {
  reviewed: ReviewedDryRun;
  gaps: PlanGap[];
  ageMs: number;
  /**
   * Filing succeeded: leave a short-lived filed-marker (so a concurrent identical
   * confirm is refused, not re-run) and drop the claim.
   */
  commit(url: string): Promise<void>;
  /** Filing failed: the entry is restored so a retry can file the same bytes. */
  release(): Promise<void>;
}

/** Filed-marker path for an entry file (`<lineage>.filed`, not `.json`, so readers skip it). */
const markerOf = (file: string): string => file.replace(/\.json$/, ".filed");

/**
 * Put a claimed entry back. `link` never overwrites: a fresher dry run that
 * wrote the entry while this claim was held wins, and the older bytes are dropped.
 */
async function restoreClaim(claim: string, file: string): Promise<void> {
  await fs.link(claim, file).catch(() => undefined);
  await fs.rm(claim, { force: true }).catch(() => undefined);
}

/**
 * Claim the reviewed spec of a FILEABLE dry run whose inputs and HEAD match,
 * inside the expiry. The claim is an atomic rename of the entry file, so of N
 * concurrent identical confirms exactly one gets it; the rest get undefined.
 * A crash after the claim drops the entry without filing — at-most-once, never
 * a second copy. Undefined for a miss, a non-fileable entry, or a malformed one.
 */
export async function claimFileableDryRun(
  cacheDir: string,
  inputs: CacheInputs,
  now: number = Date.now(),
): Promise<ClaimedDryRun | undefined> {
  const file = entryFile(cacheDir, inputs);
  const claim = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.claim`;
  try {
    await fs.rename(file, claim);
  } catch {
    return undefined;
  }
  const entry = await readEntryAt(claim);
  const ageMs = entry ? now - entry.createdAt : -1;
  if (
    !entry ||
    !entry.reviewed.fileable ||
    entry.key !== investigationCacheKey(inputs) ||
    ageMs < 0 ||
    ageMs > INVESTIGATION_CACHE_TTL_MS
  ) {
    await restoreClaim(claim, file);
    return undefined;
  }
  return {
    reviewed: entry.reviewed,
    gaps: entry.gaps,
    ageMs,
    commit: async (url) => {
      // Marker first: there is never a moment with neither claim nor marker.
      await fs.writeFile(markerOf(file), JSON.stringify({ at: Date.now(), url })).catch(() => {});
      await fs.rm(claim, { force: true }).catch(() => undefined);
    },
    release: () => restoreClaim(claim, file),
  };
}

/**
 * Whether an identical confirm is already filing this lineage, or filed it a
 * moment ago. A caller whose claim missed must consult this before running the
 * full pipeline: a miss there re-investigates and can file a second issue while
 * the first is still in flight. Undefined for a plain miss.
 */
export async function concurrentFilingOf(
  cacheDir: string,
  inputs: CacheInputs,
  now: number = Date.now(),
): Promise<{ url?: string } | undefined> {
  const file = entryFile(cacheDir, inputs);
  const marker = await fs
    .readFile(markerOf(file), "utf8")
    .then((t) => JSON.parse(t) as { at?: unknown; url?: unknown })
    .catch(() => undefined);
  if (
    marker &&
    typeof marker.at === "number" &&
    Math.abs(now - marker.at) <= RECENT_FILING_WINDOW_MS
  ) {
    return { url: typeof marker.url === "string" ? marker.url : undefined };
  }
  const prefix = `${path.basename(file)}.`;
  const names = await fs.readdir(cacheDir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".claim")) continue;
    const st = await fs.stat(path.join(cacheDir, name)).catch(() => undefined);
    if (st && now - st.mtimeMs <= RECENT_FILING_WINDOW_MS) return {};
  }
  return undefined;
}

/**
 * Drop the entry once its spec has been filed. Without this, an identical
 * confirm after a successful filing would verbatim-file the same spec again.
 * Fails open: an entry that cannot be removed is merely reusable.
 */
export async function consumeInvestigationCache(
  cacheDir: string,
  inputs: CacheInputs,
): Promise<void> {
  await fs.rm(entryFile(cacheDir, inputs), { force: true }).catch(() => undefined);
}

/**
 * The gap-gate findings of the most recent dry run for this lineage, at ANY
 * head and age. These seed a gate re-run; they are never a verdict.
 */
export async function readSettledGaps(cacheDir: string, inputs: CacheInputs): Promise<PlanGap[]> {
  return (await readEntry(cacheDir, inputs))?.gaps ?? [];
}

/**
 * Store a successful dry run. Gaps are de-duplicated by description (the same
 * union rule as the gate loop's residual disclosure). Writes atomically via a
 * temp file + rename, and never throws.
 */
export async function writeInvestigationCache(
  cacheDir: string,
  inputs: CacheInputs,
  payload: CachedInvestigation,
  now: number = Date.now(),
): Promise<void> {
  const gaps = [...new Map(payload.gaps.map((g) => [g.description, g])).values()];
  const entry: InvestigationCacheEntry = {
    ...payload,
    gaps,
    key: investigationCacheKey(inputs),
    createdAt: now,
  };
  const file = entryFile(cacheDir, inputs);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(entry));
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    trace(
      `plan-investigation-cache: write failed — dry run not cached (${(err as Error).message})`,
    );
    return;
  }
  await sweepStale(cacheDir, now);
}

/**
 * Remove expired entries and crash leftovers (stale claims, markers, temp files)
 * so the per-clone cache directory cannot grow without bound.
 */
async function sweepStale(cacheDir: string, now: number): Promise<void> {
  const names = await fs.readdir(cacheDir).catch(() => [] as string[]);
  for (const name of names) {
    const limit = name.endsWith(".json") ? INVESTIGATION_CACHE_TTL_MS : RECENT_FILING_WINDOW_MS;
    const p = path.join(cacheDir, name);
    const st = await fs.stat(p).catch(() => undefined);
    if (st && now - st.mtimeMs > limit) await fs.rm(p, { force: true }).catch(() => undefined);
  }
}

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
 * and gate seed; it never files on its own. The claim/commit protocol that
 * hands a fileable entry to the forge lives in plan-filing-claim.ts.
 *
 * Staleness is keyed on git HEAD and epic depth (both change the drafted spec).
 * #1132: the HEAD in that key is origin/<default>, what investigators read
 * (plan-base-tree.ts); a run with no origin SHA neither reads nor writes the cache.
 * Uncommitted working-tree edits are NOT part of the key; the result says so
 * (plan-tool.ts).
 *
 * Storage: one file per lineage (descriptor + context + type) under the clone's
 * git common dir (`<common-dir>/pi-plan-cache/`), so it is never tracked. The
 * stored entry carries the full key; a reader accepts it only on an exact key
 * match, inside INVESTIGATION_CACHE_TTL_MS, and only when every field the
 * pipeline dereferences is well-formed (a malformed entry is a miss, never a
 * crash). Every failure fails open: an unreadable or corrupt entry is a miss,
 * and a failed write costs only the next run's reuse — never the run itself.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { MechanicalInventory } from "./plan-draft.ts";
import type { InvestigationResult } from "./plan-investigate.ts";
import { assemblePriorContext } from "./plan-prior-context-assembly.ts";
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
  /** origin/<default> when the run read it (#1132), else local HEAD. */
  keySha: string;
  /** Resolved epic recursion depth (`input.depth ?? 0`): it changes drafting and validation. */
  depth?: number;
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

export interface InvestigationCacheEntry extends CachedInvestigation {
  key: string;
  createdAt: number;
}

export interface PlanGitState {
  /** The cache key: origin/<default> when the run read it (#1132), else local HEAD. */
  keySha: string;
  cacheDir: string;
}

/** The part of a run's base the cache keys on: its origin SHA, or why there is none. */
type BaseRef = { baseSha?: string; baseFallback?: string };

type GitStateFn = (repoRoot: string, base: BaseRef) => Promise<PlanGitState | undefined>;

let _gitStateOverride: GitStateFn | null = null;

/** Set a git-state stub (HEAD + cache dir) for the next runs (tests). `null` clears it. */
export function setPlanGitStateFn(fn: GitStateFn | null): void {
  _gitStateOverride = fn;
}

/**
 * HEAD and the per-clone cache dir. Undefined when HEAD is unreadable (for
 * example an unborn branch) — caching is then skipped and the run proceeds
 * exactly as it did before this module existed.
 * #1132: "HEAD" in this comment is the run's origin/<default> SHA, not local HEAD;
 * the key is that SHA, so without one there is no key.
 */
export async function resolvePlanGitState(
  repoRoot: string,
  base: BaseRef,
): Promise<PlanGitState | undefined> {
  if (_gitStateOverride) return _gitStateOverride(repoRoot, base);
  // PI_ENSEMBLE_PLAN_CACHE=0 (set by smoke-tests/lib/verify-loop.sh): no real
  // lookup, so a test without an explicit stub cannot touch the real clone's cache.
  if (process.env.PI_ENSEMBLE_PLAN_CACHE === "0") return undefined;
  if (base.baseSha === undefined) {
    trace(
      `plan-investigation-cache: no origin key (${base.baseFallback ?? "no origin/HEAD"}) — cache skipped for this run`,
    );
    return undefined;
  }
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { timeout: 10_000 },
    );
    const commonDir = stdout.trim();
    if (!commonDir) return undefined;
    return {
      keySha: base.baseSha,
      cacheDir: path.join(commonDir, "pi-plan-cache"),
    };
  } catch (err) {
    trace(
      `plan-investigation-cache: git state unreadable — caching skipped (${(err as Error).message})`,
    );
    return undefined;
  }
}

const digest = (parts: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/**
 * The inputs that name one plan, everything except git HEAD. Depth is part of
 * the lineage: a sub-issue drafted at depth 3 is a different plan from the same
 * descriptor at depth 0, so a confirm must never file the other one's spec.
 */
function lineageOf(i: Omit<CacheInputs, "keySha">): string {
  // `?? null` keeps an absent context (undefined) distinct from "" and " ".
  return digest(["plan-lineage-v1", i.descriptor.trim(), i.context ?? null, i.type, i.depth ?? 0]);
}

/** Full cache key: the lineage plus git HEAD. */
export function investigationCacheKey(i: CacheInputs): string {
  return digest(["plan-investigation-v1", lineageOf(i), i.keySha]);
}

/** The entry file for one lineage (exported for the claim protocol, plan-filing-claim.ts). */
export function entryFile(cacheDir: string, i: Omit<CacheInputs, "keySha">): string {
  return path.join(cacheDir, `${lineageOf(i)}.json`);
}

// ---------------------------------------------------------------------------
// Entry guard. Validates every field the pipeline dereferences from a cached
// entry (the barrier's findings and their tool uses, the gaps, the inventory,
// the reviewed spec and its facts), so a malformed or hand-edited entry is a
// miss rather than a crash deep inside drafting or filing.
// ---------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";
const isStr = (x: unknown): x is string => typeof x === "string";
const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

const isToolUse = (x: unknown): boolean =>
  isObj(x) && isStr(x.kind) && isStr(x.text) && isStr(x.angle);

const isFinding = (x: unknown): boolean =>
  isObj(x) &&
  isStr(x.name) &&
  typeof x.ok === "boolean" &&
  isStr(x.text) &&
  Array.isArray(x.toolUses) &&
  x.toolUses.every(isToolUse) &&
  (x.failure === undefined || isStr(x.failure));

const isGap = (x: unknown): boolean =>
  isObj(x) &&
  typeof x.severity === "string" &&
  SEVERITIES.includes(x.severity) &&
  isStr(x.description) &&
  isStr(x.resolution);

const isFact = (x: unknown): boolean => isObj(x) && isStr(x.source) && isStr(x.fact);

const isInventory = (x: unknown): boolean =>
  isObj(x) &&
  Array.isArray(x.memory) &&
  x.memory.every((m) => isObj(m) && isStr(m.content)) &&
  Array.isArray(x.related) &&
  x.related.every(
    (r) => isObj(r) && typeof r.number === "number" && isStr(r.title) && isStr(r.state),
  ) &&
  Array.isArray(x.errors) &&
  x.errors.every(isStr);

const isBarrier = (x: unknown): boolean =>
  isObj(x) &&
  Array.isArray(x.findings) &&
  x.findings.every(isFinding) &&
  Array.isArray(x.neverClaimDisclosure) &&
  x.neverClaimDisclosure.every(isStr) &&
  (x.duplicateRisk === undefined ||
    (isObj(x.duplicateRisk) && isStr(x.duplicateRisk.level) && isStr(x.duplicateRisk.rationale)));

const isReviewed = (x: unknown): boolean => {
  if (!isObj(x)) return false;
  const { fileable, title, spec, priorContext, failedAngles } = x;
  return (
    typeof fileable === "boolean" &&
    isStr(title) &&
    isStr(spec) &&
    Array.isArray(priorContext) &&
    priorContext.every(isFact) &&
    (failedAngles === undefined ||
      (Array.isArray(failedAngles) &&
        failedAngles.every((a) => isObj(a) && isStr(a.name) && isStr(a.detail)))) &&
    // A fileable entry must carry something to file.
    (!fileable || (title.trim().length > 0 && spec.trim().length > 0))
  );
};

function isEntry(x: unknown): x is InvestigationCacheEntry {
  if (!isObj(x)) return false;
  return (
    isStr(x.key) &&
    typeof x.createdAt === "number" &&
    isInventory(x.inventory) &&
    isBarrier(x.barrier) &&
    Array.isArray(x.gaps) &&
    x.gaps.every(isGap) &&
    isReviewed(x.reviewed)
  );
}

export async function readEntryAt(file: string): Promise<InvestigationCacheEntry | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return isEntry(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readEntry(
  cacheDir: string,
  i: Omit<CacheInputs, "keySha">,
): Promise<InvestigationCacheEntry | undefined> {
  return readEntryAt(entryFile(cacheDir, i));
}

/**
 * Fail closed on cache shape (#1043 review). The guard above proves the entry is
 * well-formed; this runs the consumers the pipeline will apply to it (the
 * inventory's prior-context assembly, the barrier's findings and disclosure, the
 * gap gate's settled list) once, up front. Anything that throws is a miss, traced,
 * never a crash deep inside drafting.
 */
function consumable(entry: InvestigationCacheEntry, context: string | undefined): boolean {
  try {
    assemblePriorContext(context, entry.inventory);
    // The reads the pipeline makes: failed-angle disclosure, the NEVER CLAIM
    // disclosure, and each settled gap's text. Every one must yield a string.
    const reads = [
      ...entry.barrier.findings.filter((f) => !f.ok).map((f) => f.failure ?? "failed"),
      entry.barrier.neverClaimDisclosure.join("\n"),
      ...entry.gaps.map((g) => `${g.description}${g.resolution}`),
    ];
    return reads.every((r) => typeof r === "string");
  } catch (err) {
    trace(
      `plan-investigation-cache: cached entry unusable by the pipeline — treated as a miss (${(err as Error).message})`,
    );
    return false;
  }
}

/**
 * The reusable investigation for these exact inputs, with the dry run's age.
 * Undefined on any mismatch (key, expiry, missing, corrupt or unusable file).
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
  if (!consumable(entry, inputs.context)) return undefined;
  return { cached: entry, ageMs };
}

/**
 * Drop a lineage's entry. Two callers, one rule, because both need the same
 * thing: no fileable verdict survives for an identical confirm to file verbatim.
 * (a) A dry run calls it at its start, so a dry run that halts before it can
 * cache a verdict (precheck, duplicate risk, a failed angle fan-out, a draft
 * that does not validate) leaves no stale fileable entry behind. (b) A successful
 * filing calls it, so an identical confirm after the filing cannot file the same
 * spec a second time. Fails open: an entry that cannot be removed is merely
 * reusable (and, after a filing, guarded by the filed-marker).
 */
export async function dropInvestigationCache(cacheDir: string, inputs: CacheInputs): Promise<void> {
  await fs.rm(entryFile(cacheDir, inputs), { force: true }).catch(() => undefined);
}

/**
 * The gap-gate findings of the most recent dry run for this lineage, at ANY
 * head and age. These seed a gate re-run; they are never a verdict. An entry the
 * pipeline cannot consume seeds nothing (fail closed, as readInvestigationCache).
 */
export async function readSettledGaps(cacheDir: string, inputs: CacheInputs): Promise<PlanGap[]> {
  const entry = await readEntry(cacheDir, inputs);
  if (!entry || !consumable(entry, inputs.context)) return [];
  return entry.gaps;
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

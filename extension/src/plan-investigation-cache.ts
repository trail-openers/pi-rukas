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
    Array.isArray(e.gaps)
  );
}

async function readEntry(
  cacheDir: string,
  i: Omit<CacheInputs, "head">,
): Promise<InvestigationCacheEntry | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(entryFile(cacheDir, i), "utf8"));
    return isEntry(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
    trace(
      `plan-investigation-cache: write failed — dry run not cached (${(err as Error).message})`,
    );
  }
}

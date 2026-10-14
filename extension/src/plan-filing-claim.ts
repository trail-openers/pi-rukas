/**
 * plan-filing-claim — the claim / commit / release protocol for a verbatim
 * filing (#1043). Split out of plan-investigation-cache.ts along the 500-line
 * seam (AGENTS.md §12): the cache owns storage, keys and the entry guard; this
 * module owns the at-most-once hand-off of a reviewed entry to the forge.
 *
 * A verbatim filing is authorised by the DIGEST the operator was shown in the
 * dry run (`reviewedDigestOf`), not by the cache entry alone: a caller passes
 * the digest back, and the claim takes the entry only when the title + body on
 * disk hash to it. An entry altered after the dry run therefore cannot be filed
 * by an identical-input confirm that carries the original digest.
 *
 * Protocol: claim = atomic rename of the entry file (of N concurrent identical
 * confirms exactly one wins); commit = filed-marker, then drop the claim;
 * release = put the entry back (`link` never overwrites a fresher dry run).
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  type CacheInputs,
  type InvestigationCacheEntry,
  RECENT_FILING_WINDOW_MS,
  type ReviewedDryRun,
  entryFile,
  investigationCacheKey,
  readEntryAt,
  withinPlanCacheTtl,
} from "./plan-investigation-cache.ts";
import type { PlanGap } from "./plan-types.ts";
import { trace } from "./trace.ts";

/**
 * The short digest of the exact title + body a filing would send: 16 hex chars
 * of sha256. The dry run reports it; a verbatim filing must echo it back.
 */
export function reviewedDigestOf(title: string, spec: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["plan-reviewed-v1", title, spec]))
    .digest("hex")
    .slice(0, 16);
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

/**
 * Whether an entry may be filed under these inputs, digest and clock: fileable,
 * same key (lineage + HEAD), inside the expiry, and (when given) hashing to the
 * digest the operator was shown. Used BEFORE the claim and again on the claimed
 * bytes, so a check never relies on a file that changed underneath it.
 */
function fileableEntry(
  entry: InvestigationCacheEntry | undefined,
  inputs: CacheInputs,
  digest: string | undefined,
  now: number,
): entry is InvestigationCacheEntry {
  if (!entry || !entry.reviewed.fileable || entry.key !== investigationCacheKey(inputs)) {
    return false;
  }
  if (!withinPlanCacheTtl(now - entry.createdAt)) return false;
  return (
    digest === undefined || reviewedDigestOf(entry.reviewed.title, entry.reviewed.spec) === digest
  );
}

/** Filed-marker path for an entry file (`<lineage>.filed`, not `.json`, so readers skip it). */
const markerOf = (file: string): string => file.replace(/\.json$/, ".filed");

/**
 * Put a claimed entry back. `link` never overwrites: a fresher dry run that
 * wrote the entry while this claim was held wins, and the older bytes are
 * dropped. Only EEXIST (a fresher entry) and ENOENT (the claim is already gone)
 * are benign; any other link failure (a filesystem without hard links, EPERM)
 * falls back to a rename, and the claim is kept if that fails too — a kept
 * claim is still visible to concurrentFilingOf, a dropped one is not.
 */
async function restoreClaim(claim: string, file: string): Promise<void> {
  try {
    await fs.link(claim, file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOENT") {
      const fresherExists = await fs.stat(file).then(
        () => true,
        () => false,
      );
      if (!fresherExists) {
        try {
          await fs.rename(claim, file);
          return;
        } catch (renameErr) {
          trace(
            `plan-filing-claim: restore failed — claim kept for the sweep (${(renameErr as Error).message})`,
          );
          return;
        }
      }
    }
  }
  await fs.rm(claim, { force: true }).catch(() => undefined);
}

/**
 * Claim the reviewed spec of a FILEABLE dry run whose inputs and HEAD match,
 * inside the expiry. With `digest`, the entry's title + body must hash to it
 * (`reviewedDigestOf`). The digest is checked BEFORE the rename: a call that
 * would not file never takes the entry, so it cannot make a concurrent correct
 * confirm see "filing-in-progress". After the rename the CLAIMED bytes are
 * checked again (the entry may have been replaced in between); a mismatch puts
 * them back. A crash after the claim drops the entry without filing —
 * at-most-once, never a second copy. Undefined for a miss, a non-fileable or
 * malformed entry, or a digest mismatch.
 */
export async function claimFileableDryRun(
  cacheDir: string,
  inputs: CacheInputs,
  opts: { now?: number; digest?: string } = {},
): Promise<ClaimedDryRun | undefined> {
  const now = opts.now ?? Date.now();
  const file = entryFile(cacheDir, inputs);
  if (!fileableEntry(await readEntryAt(file), inputs, opts.digest, now)) return undefined;
  const claim = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.claim`;
  try {
    await fs.rename(file, claim);
  } catch {
    return undefined;
  }
  // rename keeps the entry's own mtime (the dry run's write time). Stamp the claim
  // now, so its freshness is the claim's age — not the dry run's — for a racing
  // identical confirm (concurrentFilingOf) and for the sweep.
  await fs.utimes(claim, now / 1000, now / 1000).catch((err: unknown) => {
    trace(
      `plan-filing-claim: utimes failed — the claim keeps the dry run's write time (${(err as Error).message})`,
    );
  });
  const entry = await readEntryAt(claim);
  if (!fileableEntry(entry, inputs, opts.digest, now)) {
    await restoreClaim(claim, file);
    return undefined;
  }
  const ageMs = now - entry.createdAt;
  return {
    reviewed: entry.reviewed,
    gaps: entry.gaps,
    ageMs,
    commit: async (url) => {
      // Marker first: there is never a moment with neither claim nor marker. If the
      // marker cannot be written the claim is KEPT — it is what concurrentFilingOf
      // reads for the next 10 minutes, so an identical confirm is still refused.
      try {
        await fs.writeFile(
          markerOf(file),
          JSON.stringify({ at: Date.now(), url, keySha: inputs.keySha }),
        );
      } catch (err) {
        trace(
          `plan-filing-claim: filed-marker write failed — claim kept so a concurrent identical confirm is still refused (${(err as Error).message})`,
        );
        return;
      }
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
    .then((t) => JSON.parse(t) as { at?: unknown; url?: unknown; keySha?: unknown })
    .catch(() => undefined);
  // A marker refuses only the HEAD it was written at: after HEAD moves, the
  // identical confirm is a new plan and runs the pipeline (#1043 review).
  // (#1132: "HEAD" here is the origin/<default> SHA, the cache key's keySha.)
  if (
    marker &&
    typeof marker.at === "number" &&
    marker.keySha === inputs.keySha &&
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

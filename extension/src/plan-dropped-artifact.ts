/**
 * plan-dropped-artifact — the durable full list behind the bounded dropped
 * section (#1383).
 *
 * The omission line inside a filed spec used to point at "the run transcripts
 * (/runs)". That promise was false twice over: `/runs` renders tool arguments
 * truncated (so the un-clipped item text it claimed to hold was never there),
 * and transcripts are pruned after 5 days (so the pointer aged out of
 * usefulness a week after the filing). A pointer a spec carries for the
 * lifetime of the issue has to name bytes the pipeline itself wrote.
 *
 * So the pipeline writes them: one JSON file per run that omitted anything,
 * under `<repo>/.pi/plan-dropped/`, named so an operator holding the issue can
 * find it from the descriptor. `DROPPED_ARTIFACT_DIR` in
 * plan-dropped-budget.ts is the directory; this file owns the naming, the
 * write, and the sweep that keeps the directory from growing without bound.
 *
 * It never throws and never rejects a run: the artifact is what makes the
 * omission line's promise TRUE, and a read-only or full checkout degrades to
 * the count-and-bounds disclosure, which is still an honest statement — it
 * just does not name a file the operator cannot read.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DroppedInvestigationItem } from "./plan-draft-conflicts.ts";
import { DROPPED_ARTIFACT_DIR } from "./plan-dropped-budget.ts";
import { lastDroppedRender } from "./plan-dropped-holder.ts";
import { repointDroppedOmission } from "./plan-dropped-section.ts";
import { FORGE_BODY_MAX } from "./plan-validate.ts";
import { trace } from "./trace.ts";
export { repointDroppedOmission } from "./plan-dropped-section.ts";

/** How long a dropped-items artifact survives the sweep. Transcripts get 5
 * days; a filed spec lives for years, so the artifact it names lives longer. */
const ARTIFACT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Ceiling on files in the directory — the sweep's second bound, alongside age. */
const ARTIFACT_MAX_FILES = 200;

/** One dropped item as the artifact records it: everything the renderer clipped
 * away, verbatim, which is the entire reason the artifact exists. */
export interface DroppedArtifactEntry {
  reason: DroppedInvestigationItem["reason"];
  angle: string;
  kind: string;
  text: string;
  against: string;
  sibling?: string;
}

/**
 * The artifact's on-disk shape. `shown` is the count the body rendered, so the
 * file and the spec it belongs to reconcile without re-rendering anything.
 */
export interface DroppedArtifact {
  version: 1;
  descriptor: string;
  planType: string;
  writtenAt: number;
  shown: number;
  omitted: number;
  items: DroppedArtifactEntry[];
}

/**
 * Run identity: a short digest of the inputs that produced this list. Same
 * digest recipe the investigation cache uses (plan-investigation-cache.ts), so
 * "which run wrote this file" is answerable from the descriptor alone.
 */
function runId(descriptor: string, planType: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["plan-dropped-v1", descriptor.trim(), planType]))
    .digest("hex")
    .slice(0, 12);
}

/** Descriptor → a filename slug. Filenames carry the human half of "findable
 * from the issue"; the digest carries the disambiguation half. */
function slugOf(descriptor: string): string {
  return descriptor
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Where this run's artifact lives. Exported for the test that asserts the file
 * the body names is the file the pipeline wrote. */
export function droppedArtifactFile(
  repoRoot: string,
  descriptor: string,
  planType: string,
): string {
  const slug = slugOf(descriptor) || "plan";
  return join(repoRoot, DROPPED_ARTIFACT_DIR, `${slug}-${runId(descriptor, planType)}.json`);
}

/**
 * Persist the FULL dropped list when the body omitted any of it. Returns the
 * path written, or `undefined` when nothing needed persisting (nothing was
 * omitted) or the write failed — both of which leave the body's
 * count-and-bounds disclosure intact.
 */
export async function writeDroppedArtifact(
  repoRoot: string,
  descriptor: string,
  planType: string,
  dropped: DroppedInvestigationItem[],
  shown: number,
): Promise<string | undefined> {
  const omitted = dropped.length - shown;
  if (omitted <= 0) return undefined;
  const file = droppedArtifactFile(repoRoot, descriptor, planType);
  const payload: DroppedArtifact = {
    version: 1,
    descriptor,
    planType,
    writtenAt: Date.now(),
    shown,
    omitted,
    items: dropped.map((d) => ({
      reason: d.reason,
      angle: d.item.angle,
      kind: d.item.kind,
      text: d.item.text,
      against: d.against,
      ...(d.sibling === undefined ? {} : { sibling: d.sibling }),
    })),
  };
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await mkdir(join(repoRoot, DROPPED_ARTIFACT_DIR), { recursive: true });
    await writeFile(tmp, JSON.stringify(payload, null, 2));
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    trace(
      `plan-dropped-artifact: write failed — the omission line states counts only (${(err as Error).message})`,
    );
    return undefined;
  }
  await sweepDroppedArtifacts(join(repoRoot, DROPPED_ARTIFACT_DIR));
  return file;
}

/**
 * Age + count sweep, mirroring the investigation cache's `sweepStale`
 * (plan-investigation-cache.ts) so the directory cannot accumulate one file per
 * plan run forever. Best-effort: a directory it cannot read is simply skipped.
 */
async function sweepDroppedArtifacts(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const now = Date.now();
  const kept: { name: string; mtime: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      // A crash leftover from the temp-file write above.
      if (name.includes(".tmp")) await rm(join(dir, name), { force: true }).catch(() => undefined);
      continue;
    }
    const st = await stat(join(dir, name)).catch(() => undefined);
    if (!st) continue;
    if (now - st.mtimeMs > ARTIFACT_TTL_MS) {
      await rm(join(dir, name), { force: true }).catch(() => undefined);
      continue;
    }
    kept.push({ name, mtime: st.mtimeMs });
  }
  if (kept.length <= ARTIFACT_MAX_FILES) return;
  kept.sort((a, b) => a.mtime - b.mtime);
  for (const stale of kept.slice(0, kept.length - ARTIFACT_MAX_FILES)) {
    await rm(join(dir, stale.name), { force: true }).catch(() => undefined);
  }
}

/**
 * The one place the pipeline decides what the dropped section's omission line
 * points at, and writes the bytes to back the promise (#1383).
 *
 * It runs AFTER the gap gate, not at draft time, because the pointer depends on
 * two facts that do not exist while drafting: whether the gate reopened points
 * (whose own body section quotes the full conflict text, making a local file on
 * the planner's machine the wrong answer for a teammate reading the issue), and
 * whether the write actually landed (a read-only or full checkout degrades to
 * the count-and-bounds disclosure, which is still honest). Returns the pieces
 * the driver needs to rewrite the one line — it does not touch the body itself,
 * so the gate keeps reviewing exactly what files.
 */
export async function finalizeDroppedDisclosure(args: {
  repoRoot: string;
  descriptor: string;
  type: string;
  openPoints: unknown[];
}): Promise<{
  omitted: number;
  reopened: boolean;
  file?: string;
  /** Rewrite the omission line's pointer in the body (identity when nothing to point at). */
  repoint: (body: string) => string;
}> {
  const rendered = lastDroppedRender();
  const omitted = rendered ? rendered.items.length - rendered.shown : 0;
  const reopened = args.openPoints.length > 0;
  if (!rendered || omitted <= 0 || reopened) {
    return { omitted, reopened, repoint: (b) => b };
  }
  const file = await writeDroppedArtifact(
    args.repoRoot,
    args.descriptor,
    args.type,
    rendered.items,
    rendered.shown,
  );
  return {
    omitted,
    reopened,
    file,
    repoint: (b) => repointDroppedOmission(b, reopened, file, omitted),
  };
}

/**
 * The compaction disclosure line the driver appends after the fitter (#1383).
 * Lives here beside the other dropped-section disclosure text so one module
 * owns "what the body says about bytes it had to give up".
 */
export function compactedDisclosure(budget: {
  maxItemsPerSection: number;
  itemClipChars: number;
}): string {
  return `\n\n> Compacted to fit the forge's ${FORGE_BODY_MAX}-char body limit (per-section items capped at ${budget.maxItemsPerSection}, item text clipped at ${budget.itemClipChars} chars).`;
}

/**
 * The driver's one-line run summary, called at the end of every pipeline run.
 * Lives here because plan-driver.ts sits at the 500-line seam (AGENTS.md §12)
 * and this is self-contained formatting, not orchestration. `structured` is
 * how many angles produced ANY structured item — reported beside the angle
 * count because `angles=` alone read as "3 angles ran" when all three had
 * returned prose-only (the #633 case the all-angles-failed guard now catches).
 */
export function tracePlanRun(args: {
  type: string;
  findings: { toolUses: unknown[] }[];
  gaps: unknown[];
  issueUrl?: string;
  dryRun: boolean;
  capReason?: string;
}): void {
  const structured = args.findings.filter((f) => f.toolUses.length > 0).length;
  trace(
    `plan-driver: type=${args.type} angles=${args.findings.length} structured=${structured} gaps=${args.gaps.length} filed=${!!args.issueUrl} dryRun=${args.dryRun} capReason=${args.capReason ?? "none"}`,
  );
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PRUNE_MIN_AGE_MS, transcriptRetentionDays } from "./runs-retention.ts";
import { pickBatch, renderTranscript, summariseTranscript } from "./runs-viewer.ts";

const ENSEMBLE_DIR_DEFAULT = path.join(os.homedir(), ".pi", "agent", "ensemble-runs");

export interface RunFile {
  path: string;
  filename: string;
  runId: string;
  role: string;
  seq: number | null;
  mtimeMs: number;
  sizeBytes: number;
}

interface Batch {
  runId: string;
  mtimeMs: number; // newest child's mtime
  children: RunFile[];
}

/**
 * Filename shape (from spawn.ts/transcriptPathFor):
 *   <runId>-<role>[-<seq>].json
 *   runId      → "<base36ms>-<rand6>"   (two dash-separated segments)
 *   role       → known role names, may contain dashes (e.g. "adversarial-developer")
 *   seq        → optional numeric suffix from dispatch_parallel
 *
 * To split robustly, we anchor to the runId prefix: take the first two
 * dash-separated tokens as the runId, then the rest is "<role>[-<seq>]".
 */
function parseRunFilename(
  filename: string,
): Omit<RunFile, "path" | "mtimeMs" | "sizeBytes"> | null {
  const base = filename.replace(/\.json$/i, "");
  const parts = base.split("-");
  if (parts.length < 3) return null;
  const runId = `${parts[0]}-${parts[1]}`;
  const tail = parts.slice(2);
  const last = tail[tail.length - 1];
  let role: string;
  let seq: number | null = null;
  if (last !== undefined && /^\d+$/.test(last)) {
    seq = Number(last);
    role = tail.slice(0, -1).join("-");
  } else {
    role = tail.join("-");
  }
  if (!role) return null;
  return { filename, runId, role, seq };
}

async function listRunFiles(rootDir: string): Promise<RunFile[]> {
  let dates: string[];
  try {
    dates = await fs.readdir(rootDir);
  } catch {
    return [];
  }
  const out: RunFile[] = [];
  for (const date of dates) {
    const dir = path.join(rootDir, date);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const parsed = parseRunFilename(entry);
      if (!parsed) continue;
      const full = path.join(dir, entry);
      const s = await fs.stat(full).catch(() => null);
      if (!s) continue;
      out.push({ ...parsed, path: full, mtimeMs: s.mtimeMs, sizeBytes: s.size });
    }
  }
  return out;
}

function groupIntoBatches(files: RunFile[]): Batch[] {
  const by = new Map<string, RunFile[]>();
  for (const f of files) {
    const arr = by.get(f.runId) ?? [];
    arr.push(f);
    by.set(f.runId, arr);
  }
  const batches: Batch[] = [];
  for (const [runId, children] of by) {
    children.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const mtimeMs = Math.max(...children.map((c) => c.mtimeMs));
    batches.push({ runId, mtimeMs, children });
  }
  batches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return batches;
}

export interface PruneSummary {
  /** Total batches found before pruning. */
  totalBatches: number;
  /** Batches actually deleted. */
  deletedBatches: number;
  /** Individual transcript files deleted. */
  deletedFiles: number;
  /** Bytes freed. */
  bytesFreed: number;
  /** Batches kept young enough to survive even past the retention window (safety floor). */
  preservedByAgeFloor: number;
}

/**
 * Delete every batch whose NEWEST child file is older than the retention
 * window (default 5 days, `PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS`) — but
 * never anything younger than `PRUNE_MIN_AGE_MS` (60 s), which protects
 * in-progress spawns. `retentionDays === 0` disables pruning (no-op).
 * Cheap to call repeatedly: a single dir walk + filtered unlinks.
 */
export async function pruneOldRuns(
  rootDir: string = process.env.PI_ENSEMBLE_RUNS_DIR ?? ENSEMBLE_DIR_DEFAULT,
  retentionDays: number = transcriptRetentionDays(),
): Promise<PruneSummary> {
  const summary: PruneSummary = {
    totalBatches: 0,
    deletedBatches: 0,
    deletedFiles: 0,
    bytesFreed: 0,
    preservedByAgeFloor: 0,
  };
  if (retentionDays <= 0) return summary;

  const files = await listRunFiles(rootDir);
  const batches = groupIntoBatches(files);
  summary.totalBatches = batches.length;

  const now = Date.now();
  const windowMs = retentionDays * 86_400_000;
  const candidates = batches.filter((b) => now - b.mtimeMs >= windowMs);
  for (const b of candidates) {
    if (now - b.mtimeMs < PRUNE_MIN_AGE_MS) {
      summary.preservedByAgeFloor++;
      continue;
    }
    for (const c of b.children) {
      try {
        await fs.unlink(c.path);
        summary.deletedFiles++;
        summary.bytesFreed += c.sizeBytes;
      } catch {
        // Best effort — ignore unlink races / permissions
      }
    }
    summary.deletedBatches++;
  }

  // Best-effort: remove empty date subdirs.
  try {
    const dates = await fs.readdir(rootDir);
    for (const d of dates) {
      const sub = path.join(rootDir, d);
      const st = await fs.stat(sub).catch(() => null);
      if (!st?.isDirectory()) continue;
      const remaining = await fs.readdir(sub);
      if (remaining.length === 0) await fs.rmdir(sub).catch(() => undefined);
    }
  } catch {
    // ignore
  }

  return summary;
}

/**
 * One-line summary for /ensemble-debug: file count, batch count, oldest age,
 * total size on disk. Returns an empty string when no runs exist yet.
 */
export async function transcriptsSummary(
  rootDir: string = process.env.PI_ENSEMBLE_RUNS_DIR ?? ENSEMBLE_DIR_DEFAULT,
): Promise<string> {
  const files = await listRunFiles(rootDir);
  if (files.length === 0) return "";
  const batches = groupIntoBatches(files);
  const oldest = batches[batches.length - 1];
  const totalBytes = files.reduce((acc, f) => acc + f.sizeBytes, 0);
  const sizeStr =
    totalBytes < 1024 * 1024
      ? `${(totalBytes / 1024).toFixed(0)} KB`
      : `${(totalBytes / 1024 / 1024).toFixed(1)} MB`;
  const oldestAge = oldest ? fmtRelative(oldest.mtimeMs) : "?";
  const retention = transcriptRetentionDays();
  const retentionStr = retention > 0 ? `retention ${retention} days` : "retention off";
  return `${files.length} files · ${batches.length} batches · oldest ${oldestAge} · ${sizeStr}  (${retentionStr})`;
}

export function fmtRelative(mtimeMs: number, now = Date.now()): string {
  const dMs = now - mtimeMs;
  if (dMs < 60_000) return `${Math.round(dMs / 1000)}s ago`;
  if (dMs < 3_600_000) return `${Math.round(dMs / 60_000)}m ago`;
  if (dMs < 86_400_000) return `${Math.round(dMs / 3_600_000)}h ago`;
  return `${Math.round(dMs / 86_400_000)}d ago`;
}

export function registerRunsCommand(pi: ExtensionAPI) {
  pi.registerCommand("runs", {
    description: "Browse recent pi-rukas subagent runs (or `/runs all`, `/runs prune [N]`)",
    handler: async (args, ctx) => {
      const rootDir = process.env.PI_ENSEMBLE_RUNS_DIR ?? ENSEMBLE_DIR_DEFAULT;
      const trimmed = args.trim().toLowerCase();

      // `/runs prune [days]` — manual cleanup (days defaults to the configured window)
      if (trimmed.startsWith("prune")) {
        const m = trimmed.match(/^prune\s+(\d+(?:\.\d+)?)/);
        const days = m ? Number(m[1]) : transcriptRetentionDays();
        if (days <= 0) {
          ctx.ui.notify("Nothing to prune — retention is disabled (0 days).", "info");
          return;
        }
        const preview = await listRunFiles(rootDir).then(groupIntoBatches);
        const now = Date.now();
        const windowMs = days * 86_400_000;
        const willDelete = preview.filter((b) => now - b.mtimeMs >= windowMs).length;
        if (willDelete === 0) {
          ctx.ui.notify(`Nothing to prune — no batches older than ${days} days.`, "info");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Prune old runs?",
          `Delete ${willDelete} batch(es) older than ${days} days? In-progress runs younger than ${Math.round(PRUNE_MIN_AGE_MS / 1000)}s are preserved.`,
        );
        if (!confirmed) return;
        const s = await pruneOldRuns(rootDir, days);
        ctx.ui.notify(
          `Pruned ${s.deletedBatches} batches · ${s.deletedFiles} files · ${(s.bytesFreed / 1024).toFixed(1)} KB freed.${s.preservedByAgeFloor > 0 ? `  (${s.preservedByAgeFloor} kept by age floor.)` : ""}`,
          "info",
        );
        return;
      }

      const files = await listRunFiles(rootDir);
      if (files.length === 0) {
        ctx.ui.notify(
          `No ensemble runs found yet in ${rootDir}. Run /research or /work first.`,
          "info",
        );
        return;
      }
      const allBatches = groupIntoBatches(files);

      // Allow `/runs all` to bypass the recency cap.
      const showAll = trimmed === "all";

      const batch = await pickBatch(ctx, allBatches, showAll);
      if (!batch) return;

      // Level 2: pick a child within the batch. Children-per-batch is usually
      // 1–6 so no pagination needed here.
      const childLabels = batch.children.map((c) => {
        const tag = c.seq != null ? `${c.role}-${c.seq}` : c.role;
        return `${tag.padEnd(28)} · ${fmtSize(c.sizeBytes).padStart(6)}`;
      });
      const childPick = await ctx.ui.select(`Children in ${batch.runId}`, childLabels);
      if (!childPick) return;
      const child = batch.children[childLabels.indexOf(childPick)];
      if (!child) return;

      // Level 3: render summary and show in scrollable editor
      const parsed = await summariseTranscript(child.path);
      const rendered = renderTranscript(child, parsed);
      // ui.editor returns the (possibly edited) text on save, undefined on Esc.
      // We use it as a read-only viewer; discard the return value.
      await ctx.ui.editor(`${child.role}${child.seq != null ? `-${child.seq}` : ""}`, rendered);
    },
  });
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

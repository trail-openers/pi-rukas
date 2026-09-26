import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  TOOL_ARGS_PREVIEW_MAX,
  TOOL_RESULT_LINE_MAX,
  TOOL_RESULT_PREVIEW_MAX,
} from "./transcript-preview-limits.ts";

const ENSEMBLE_DIR_DEFAULT = path.join(os.homedir(), ".pi", "agent", "ensemble-runs");

/**
 * Retention window in days: delete transcript batches whose newest child file
 * is older than this. Read at call time (not module load) so tests and same-
 * process env changes take effect on the next prune. Override with
 * PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS: unset/empty/invalid/negative → 5;
 * "0" disables; fractional values (e.g. "1.5") are honoured.
 */
const RETENTION_DAYS_DEFAULT = 5;

export function transcriptRetentionDays(): number {
  const raw = process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return RETENTION_DAYS_DEFAULT;
}

/**
 * Safety floor — never delete anything younger than this regardless of count
 * cap. Protects in-progress spawns whose transcripts are still being written.
 */
const PRUNE_MIN_AGE_MS = 60_000;

interface RunFile {
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
 *   <runId>-<role>[-<seq>].json  (runId = "<base36ms>-<rand6>", seq = optional
 *   numeric dispatch_parallel suffix; roles may contain dashes).
 * Anchor to the runId prefix: the first two dash-separated tokens are the
 * runId, the rest is "<role>[-<seq>]".
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
    for (const entry of await fs.readdir(dir)) {
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
  /** Batches kept young enough to survive even past the cap (safety floor). */
  preservedByAgeFloor: number;
}

/**
 * Delete every batch whose NEWEST child file is older than the retention
 * window (default 5 days) — but never anything younger than `PRUNE_MIN_AGE_MS`
 * (60 s), which protects in-progress spawns. `retentionDays === 0` disables
 * pruning (no-op). A batch survives if any child is still inside the window.
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
 * total size, active retention window. Empty string when no runs exist.
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

function fmtRelative(mtimeMs: number, now = Date.now()): string {
  const dMs = now - mtimeMs;
  if (dMs < 60_000) return `${Math.round(dMs / 1000)}s ago`;
  if (dMs < 3_600_000) return `${Math.round(dMs / 60_000)}m ago`;
  if (dMs < 86_400_000) return `${Math.round(dMs / 3_600_000)}h ago`;
  return `${Math.round(dMs / 86_400_000)}d ago`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

interface ParsedTranscript {
  userPrompt: string;
  assistantText: string;
  toolCalls: Array<{ name: string; input: unknown }>;
  toolResults: Array<{ name?: string; preview: string }>;
  model?: string;
  cost?: number;
  turns: number;
}

interface SessionEvent {
  type: string;
  message?: {
    // Pi emits tool results under their own role, not as blocks inside a user
    // message. The type said otherwise, so the parser could not have matched.
    role: "user" | "assistant" | "toolResult";
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      /** Anthropic spelling. */
      input?: unknown;
      /** Pi's spelling on a `toolCall` block — a JSON string, not an object. */
      arguments?: unknown;
      content?: unknown;
    }>;
    usage?: { cost?: { total?: number } };
    model?: string;
  };
}

/** Exported for the parser canary: the block shapes here are Pi's, not Anthropic's. */
export async function summariseTranscript(file: string): Promise<ParsedTranscript> {
  const raw = await fs.readFile(file, "utf8");
  const out: ParsedTranscript = {
    userPrompt: "",
    assistantText: "",
    toolCalls: [],
    toolResults: [],
    turns: 0,
  };
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: SessionEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type !== "message" || !ev.message) continue;
    const msg = ev.message;
    // Pi emits tool results as their OWN message role (not as blocks inside a
    // user message), and names the block `toolCall`/`toolResult` rather than
    // Anthropic's `tool_use`/`tool_result` — matching the Anthropic spelling
    // alone made /runs report "tool calls: 0" for every transcript.
    if (msg.role === "toolResult") {
      const blocks = msg.content ?? [];
      const preview = blocks.map((b) => (b.type === "text" && b.text ? b.text : "")).join("");
      out.toolResults.push({ preview: preview.slice(0, TOOL_RESULT_PREVIEW_MAX) });
    } else if (msg.role === "user") {
      for (const b of msg.content ?? []) {
        if (b.type === "text" && b.text) {
          out.userPrompt += b.text;
        } else if (b.type === "tool_result") {
          const preview =
            typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? (b.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
                : JSON.stringify(b.content ?? "");
          out.toolResults.push({ preview: preview.slice(0, TOOL_RESULT_PREVIEW_MAX) });
        }
      }
    } else if (msg.role === "assistant") {
      out.turns++;
      if (msg.model && !out.model) out.model = msg.model;
      if (msg.usage?.cost?.total) out.cost = (out.cost ?? 0) + msg.usage.cost.total;
      for (const b of msg.content ?? []) {
        if (b.type === "text" && b.text) out.assistantText += b.text;
        else if (b.type === "tool_use" || b.type === "toolCall") {
          out.toolCalls.push({ name: b.name ?? "?", input: b.input ?? b.arguments });
        }
      }
    }
  }
  return out;
}

/**
 * Render a parsed transcript as markdown for the read-only viewer
 * (`ctx.ui.editor`, #607 d2). The same renderer the `/runs` command uses for
 * its level-3 view — the deck viewer reuses it so both surfaces display
 * identical output.
 */
export function renderTranscript(file: RunFile, parsed: ParsedTranscript): string {
  const lines: string[] = [];
  lines.push(`# ${file.role}${file.seq != null ? `-${file.seq}` : ""}`);
  lines.push(`runId:   ${file.runId}`);
  lines.push(`file:    ${file.path}`);
  lines.push(`size:    ${fmtSize(file.sizeBytes)}`);
  if (parsed.model) lines.push(`model:   ${parsed.model}`);
  if (parsed.cost) lines.push(`cost:    $${parsed.cost.toFixed(4)}`);
  lines.push(`turns:   ${parsed.turns}`);
  lines.push(`tool calls: ${parsed.toolCalls.length}`);
  lines.push("");
  lines.push("## prompt");
  lines.push(parsed.userPrompt.trim() || "(none)");
  lines.push("");
  lines.push("## tool calls");
  if (parsed.toolCalls.length === 0) {
    lines.push("(none)");
  } else {
    for (let i = 0; i < parsed.toolCalls.length; i++) {
      const tc = parsed.toolCalls[i];
      if (!tc) continue;
      const inputStr = JSON.stringify(tc.input);
      const truncated =
        inputStr.length > TOOL_ARGS_PREVIEW_MAX
          ? `${inputStr.slice(0, TOOL_ARGS_PREVIEW_MAX)}…`
          : inputStr;
      lines.push(`${i + 1}. [${tc.name}] ${truncated}`);
      const matching = parsed.toolResults[i];
      if (matching) {
        const preview = matching.preview.replaceAll("\n", " ").slice(0, TOOL_RESULT_LINE_MAX);
        lines.push(`   → ${preview}${preview.length === TOOL_RESULT_LINE_MAX ? "…" : ""}`);
      }
    }
  }
  lines.push("");
  lines.push("## final answer");
  lines.push(parsed.assistantText.trim() || "(empty)");
  lines.push("");
  lines.push("---");
  lines.push(`Press Esc to close.  Replay: pi --session ${file.path}`);
  return lines.join("\n");
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

/**
 * Default page size for the batch picker: fits a typical 24-line terminal
 * with room for the title and 1-2 sentinel rows. `ctx.ui.select` doesn't
 * scroll well past terminal height, so capping the visible list is the only
 * way to keep all entries reachable without shrinking the font.
 */
const BATCH_PAGE_SIZE = 15;
const SHOW_OLDER = "── show older ──";
const SHOW_ALL = "── show all ──";

async function pickBatch(
  ctx: ExtensionCommandContext,
  allBatches: Batch[],
  showAll: boolean,
): Promise<Batch | undefined> {
  // Paginate by recency. Start at offset 0; "show older" steps forward by
  // BATCH_PAGE_SIZE; "show all" widens to the full list (only when small
  // enough that scrolling won't matter, or when the user opted in via
  // `/runs all`).
  let offset = 0;
  while (true) {
    const limit = showAll ? allBatches.length : BATCH_PAGE_SIZE;
    const slice = allBatches.slice(offset, offset + limit);
    const labels = slice.map(batchLabel);

    const more = !showAll && offset + limit < allBatches.length;
    const sentinels: string[] = [];
    if (more) sentinels.push(SHOW_OLDER);
    if (!showAll && allBatches.length <= BATCH_PAGE_SIZE * 3) sentinels.push(SHOW_ALL);

    const total = allBatches.length;
    const shownTo = Math.min(offset + limit, total);
    const title = showAll
      ? `pi-rukas runs · all ${total}`
      : `pi-rukas runs · ${offset + 1}–${shownTo} of ${total}`;

    const pick = await ctx.ui.select(title, [...labels, ...sentinels]);
    if (!pick) return undefined;

    if (pick === SHOW_OLDER) {
      offset += BATCH_PAGE_SIZE;
      continue;
    }
    if (pick === SHOW_ALL) {
      // Re-open with the cap removed. (showAll=true on the next loop.)
      // Tail call via simple flag swap.
      return pickBatch(ctx, allBatches, true);
    }
    const idx = labels.indexOf(pick);
    return slice[idx];
  }
}

function batchLabel(b: Batch): string {
  const roles = b.children.map((c) => `${c.role}${c.seq != null ? `${c.seq}` : ""}`).join(",");
  return `${fmtRelative(b.mtimeMs).padEnd(8)} · ${b.runId} · ${String(b.children.length).padStart(2)} child${b.children.length === 1 ? "" : "ren"} · ${roles}`;
}

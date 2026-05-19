import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENSEMBLE_DIR_DEFAULT = path.join(os.homedir(), ".pi", "agent", "ensemble-runs");

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
    role: "user" | "assistant";
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: unknown;
      content?: unknown;
    }>;
    usage?: { cost?: { total?: number } };
    model?: string;
  };
}

async function summariseTranscript(file: string): Promise<ParsedTranscript> {
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
    if (msg.role === "user") {
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
          out.toolResults.push({ preview: preview.slice(0, 400) });
        }
      }
    } else if (msg.role === "assistant") {
      out.turns++;
      if (msg.model && !out.model) out.model = msg.model;
      if (msg.usage?.cost?.total) out.cost = (out.cost ?? 0) + msg.usage.cost.total;
      for (const b of msg.content ?? []) {
        if (b.type === "text" && b.text) out.assistantText += b.text;
        else if (b.type === "tool_use") {
          out.toolCalls.push({ name: b.name ?? "?", input: b.input });
        }
      }
    }
  }
  return out;
}

function renderTranscript(file: RunFile, parsed: ParsedTranscript): string {
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
      const truncated = inputStr.length > 240 ? `${inputStr.slice(0, 240)}…` : inputStr;
      lines.push(`${i + 1}. [${tc.name}] ${truncated}`);
      const matching = parsed.toolResults[i];
      if (matching) {
        const preview = matching.preview.replaceAll("\n", " ").slice(0, 200);
        lines.push(`   → ${preview}${preview.length === 200 ? "…" : ""}`);
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
    description: "Browse recent pi-ensemble subagent runs (transcripts + tool calls)",
    handler: async (_args, ctx) => {
      const rootDir = process.env.PI_ENSEMBLE_RUNS_DIR ?? ENSEMBLE_DIR_DEFAULT;
      const files = await listRunFiles(rootDir);
      if (files.length === 0) {
        ctx.ui.notify(
          `No ensemble runs found yet in ${rootDir}. Run /research or /work first.`,
          "info",
        );
        return;
      }
      const batches = groupIntoBatches(files);

      // Level 1: pick a batch
      const batchLabels = batches.map((b) => {
        const roles = b.children
          .map((c) => `${c.role}${c.seq != null ? `${c.seq}` : ""}`)
          .join(",");
        return `${fmtRelative(b.mtimeMs).padEnd(8)} · ${b.runId} · ${String(b.children.length).padStart(2)} child${b.children.length === 1 ? "" : "ren"} · ${roles}`;
      });
      const batchPick = await ctx.ui.select("pi-ensemble runs (most recent first)", batchLabels);
      if (!batchPick) return;
      const batch = batches[batchLabels.indexOf(batchPick)];
      if (!batch) return;

      // Level 2: pick a child within the batch
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

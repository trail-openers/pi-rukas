/**
 * `/runs` level-1/level-2/level-3 viewer helpers (batch picker + transcript
 * summary/render pair). Split from runs.ts verbatim by the 500-line
 * file-size gate.
 */
import fs from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RunFile } from "./runs.ts";
import { fmtRelative } from "./runs.ts";
import {
  TOOL_ARGS_PREVIEW_MAX,
  TOOL_RESULT_LINE_MAX,
  TOOL_RESULT_PREVIEW_MAX,
} from "./transcript-preview-limits.ts";

/**
 * Default page size for the batch picker. Sized so the list comfortably fits a
 * typical 24-line terminal with room for the title and 1-2 sentinel rows.
 * Pi's `ctx.ui.select` doesn't scroll well past terminal height, so capping
 * the visible list is the only way to keep all entries reachable without the
 * user having to shrink their font.
 */
const BATCH_PAGE_SIZE = 15;
const SHOW_OLDER = "── show older ──";
const SHOW_ALL = "── show all ──";

interface Batch {
  runId: string;
  mtimeMs: number; // newest child's mtime
  children: RunFile[];
}

export async function pickBatch(
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
    // Pi emits tool results as their OWN message role, not as blocks inside a
    // user message, and names the block type `toolCall`/`toolResult` rather
    // than Anthropic's `tool_use`/`tool_result`. Matching only the Anthropic
    // spelling meant `/runs` reported "tool calls: 0" for every transcript —
    // including one with 41 of them, at the exact moment an operator was
    // reading it to find out whether a killed child had done any work.
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
 * (`ctx.ui.editor`, #607 d2). The same renderer the `/runs` command uses
 * for its level-3 view — the deck viewer reuses it so both surfaces
 * display identical output.
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

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

/**
 * Interactive deck surfaces (607 d2 + d3).
 *
 * Transcript viewer (d2): confirming a deck row for a settled job opens
 * ctx.ui.editor pre-filled with summariseTranscript / renderTranscript output
 * for the job's transcript file, the same renderer the /runs command uses.
 *
 * Steer input (d3): confirming a deck row for a running job opens the
 * pre-filled steer prompt; saving it routes through steerChild() with the
 * deck-ui source tag.
 *
 * Quiet mode: PI_ENSEMBLE_QUIET_STATUS=1 disables the viewer and steer.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { DeckEntry } from "./dispatch-deck.ts";
import type { SteerSource } from "./dispatch-steer.ts";
import { trace } from "./trace.ts";

const TRANSCRIPT_TITLE_MAX = 60;

interface TranscriptMeta {
  role: string;
  sizeBytes: number;
}

function runsRoot(rootDir?: string): string | undefined {
  return (
    rootDir ??
    process.env.PI_ENSEMBLE_RUNS_DIR ??
    path.join(os.homedir(), ".pi", "agent", "ensemble-runs")
  );
}

/**
 * Resolve a deck entry's transcript file. A direct single-dispatch job's deck
 * key IS its jobId, and its on-disk transcript is
 * root/date/jobId-role...json (basename starts with jobId-). Batch members and
 * orchestrator-round children use runId/tag keys and are not resolvable this
 * way, so this returns undefined for them. Scans the two most recent date dirs.
 */
export async function findTranscriptPath(
  key: string,
  rootDir?: string,
): Promise<string | undefined> {
  const root = runsRoot(rootDir);
  if (!root || !key || key.includes("/")) return undefined;
  let dates: string[];
  try {
    dates = await fs.readdir(root);
  } catch {
    return undefined;
  }
  dates.sort().reverse();
  for (const date of dates.slice(0, 2)) {
    let files: string[];
    try {
      files = await fs.readdir(path.join(root, date));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      if (f.startsWith(`${key}-`)) return path.join(root, date, f);
    }
  }
  return undefined;
}

/**
 * d2. Build the read-only viewer text for a settled job. Reuses the /runs
 * summariseTranscript and renderTranscript renderer so the deck viewer and the
 * /runs level-3 view are byte-identical for the same file. Degrades to an
 * explicit "no transcript on disk" note when the file has been pruned or the
 * job pre-dates the current process.
 */
export async function buildViewerText(
  key: string,
  label: string,
  meta: TranscriptMeta,
  rootDir?: string,
): Promise<string> {
  const file = await findTranscriptPath(key, rootDir);
  if (!file) {
    return [
      `# ${label} - no transcript found`,
      "",
      `No transcript on disk for job ${key}.`,
      "The child may have been pruned (/runs prune) or pre-dates this process.",
      "Replay (when available): pi --session <transcript path>",
    ].join("\n");
  }
  const { summariseTranscript, renderTranscript } = await import("./runs.ts");
  const parsed = await summariseTranscript(file);
  return renderTranscript(
    {
      path: file,
      filename: path.basename(file),
      runId: key,
      role: meta.role,
      seq: null,
      mtimeMs: 0,
      sizeBytes: meta.sizeBytes,
    },
    parsed,
  );
}

/** d3. The deck-UI steer source tag carried by the lifecycle scrollback line. */
export const DECK_UI_STEER_SOURCE: SteerSource = "deck-ui";

/**
 * d3. Deliver a steer from the deck UI to a job. Wraps steerChild(), the same
 * core the PM dispatch_steer tool uses, so the failure shapes are identical
 * (no-such-job / between-rounds / EPIPE). ctx.notify surfaces a warning when
 * delivery failed so the user sees why the steer did not land. Lazy-imports
 * dispatch-steer.ts to keep the deck-steer-registry import edge out of the
 * module graph.
 */
export async function steerFromDeck(
  ctx: ExtensionUIContext,
  key: string,
  message: string,
): Promise<{ delivered: boolean; reason?: string; label?: string }> {
  const { steerChild } = await import("./dispatch-steer.ts");
  const result = steerChild(key, message, DECK_UI_STEER_SOURCE);
  if (!result.delivered) {
    ctx.notify(
      `Steer to ${key} not delivered (${result.reason ?? "unknown"}) - job settled or between rounds.`,
      "warning",
    );
  }
  return result;
}

/**
 * d2. Open the read-only transcript viewer for a settled job. Builds the
 * viewer text (or the "no transcript" note) and shows it via ctx.ui.editor.
 * Lazy-imports runs.ts so the deck module graph stays light; file I/O happens
 * only on row confirm, never on deck render.
 */
export async function openTranscriptViewer(ctx: ExtensionContext, entry: DeckEntry): Promise<void> {
  if (process.env.PI_ENSEMBLE_QUIET_STATUS === "1") {
    trace("dispatch-deck-interactive: quiet mode - ignoring viewer request");
    return;
  }
  try {
    const text = await buildViewerText(entry.key, entry.label, {
      role: entry.state.role,
      sizeBytes: 0,
    });
    await ctx.ui.editor(viewerTitle(entry), text);
  } catch (err) {
    trace(`dispatch-deck-interactive: viewer failed for ${entry.key}: ${(err as Error).message}`);
  }
}

function viewerTitle(entry: DeckEntry): string {
  const t = `Transcript - ${entry.label} (${entry.key})`;
  return t.length > TRANSCRIPT_TITLE_MAX ? `${t.slice(0, TRANSCRIPT_TITLE_MAX - 1)}...` : t;
}

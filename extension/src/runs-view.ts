/**
 * The `/runs` viewer's level-2/level-3 helpers (extracted verbatim from
 * runs.ts when that module hit the 500-line limit — no behaviour change).
 *
 * `showRunChildren` picks a child within a batch; `showRunInEditor` renders
 * the chosen child's transcript summary and shows it in a scrollable editor
 * (read-only; the edited text is discarded). `childLabelRows` builds the
 * picker rows. All three are called from `registerRunsCommands` in
 * runs.ts.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type Batch,
  type RunFile,
  fmtSize,
  renderTranscript,
  summariseTranscript,
} from "./runs.ts";

/**
 * Level 2 of the `/runs` viewer: pick a child within a batch, then show it
 * via level 3. Children-per-batch is usually 1–6 so no pagination is needed
 * here.
 */
export async function showRunChildren(ctx: ExtensionCommandContext, batch: Batch): Promise<void> {
  const childLabels = childLabelRows(batch);
  const childPick = await ctx.ui.select(`Children in ${batch.runId}`, childLabels);
  if (!childPick) return;
  const child = batch.children[childLabels.indexOf(childPick)];
  if (!child) return;
  await showRunInEditor(ctx, child);
}

/**
 * Level 3 of the `/runs` viewer: render a single child's transcript summary
 * and show it in a scrollable editor (read-only; the edited text is
 * discarded).
 */
async function showRunInEditor(ctx: ExtensionCommandContext, child: RunFile): Promise<void> {
  const parsed = await summariseTranscript(child.path);
  const rendered = renderTranscript(child, parsed);
  // ui.editor returns the (possibly edited) text on save, undefined on Esc.
  // We use it as a read-only viewer; discard the return value.
  await ctx.ui.editor(`${child.role}${child.seq != null ? `-${child.seq}` : ""}`, rendered);
}

/** Build the child picker rows for a batch. */
function childLabelRows(batch: Batch): string[] {
  return batch.children.map((c) => {
    const tag = c.seq != null ? `${c.role}-${c.seq}` : c.role;
    return `${tag.padEnd(28)} · ${fmtSize(c.sizeBytes).padStart(6)}`;
  });
}

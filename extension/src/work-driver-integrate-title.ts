/**
 * work-driver-integrate-title — the explore step's cached issue title.
 *
 * Split from work-driver-integrate.ts (AGENTS.md §12 file-size gate) when
 * #1362's exemption threading pushed that file past the cap; the behaviour is
 * a pure move. `work-driver-integrate.ts` re-exports it so every existing
 * import path is unchanged.
 *
 * Issue title from the explore step's cached artifact; undefined on miss.
 *
 * Reads BOTH artifact shapes, anchored to the FIRST line so a body line
 * starting with `title:` can never shadow the real title (#818):
 *
 *   - `"${title}\n\n${body}"` — what `fetchIssueBodyViaGh` (the explore step,
 *     the format every production artifact uses) writes: a BARE title on
 *     line 1, no `title:` prefix. Pre-#818 the regex below only matched the
 *     `title:` shape, so it returned undefined for every production cycle
 *     (#771/#809 landed as `implement issue #N`).
 *   - `"title: ${title}\n${body}"` — the legacy `fetchIssueBodies` shape
 *     written by `work-entry.ts`; kept so pre-existing state files still
 *     resolve their title.
 */
import fs from "node:fs/promises";
import type { WorkState } from "./workflow-state-schema.ts";

export async function cachedIssueTitle(state: WorkState): Promise<string | undefined> {
  const artifact = state.pipelineState.issueBodyArtifact;
  if (!artifact) return undefined;
  try {
    const body = await fs.readFile(artifact, "utf8");
    const firstLine = body.split("\n")[0]?.trim() ?? "";
    const prefixed = firstLine.match(/^title:\s*(.+)$/);
    if (prefixed) return prefixed[1]?.trim();
    if (!firstLine) return undefined;
    return firstLine;
  } catch {
    return undefined;
  }
}

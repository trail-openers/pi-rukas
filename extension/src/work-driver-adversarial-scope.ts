/**
 * work-driver-adversarial-scope — the per-workstream review scope of the
 * adversarial fan-out (#1137). Split from work-driver-adversarial-fanout.ts
 * (AGENTS.md §12 file-size limit). Pure: builds the `scope` a reviewer is
 * judged within from the workstream map; no I/O. The map supplies only the
 * sibling / out-of-scope list here; the review set itself is the caller's.
 */

import type { PipelineState } from "./workflow-state-schema.ts";

/**
 * The per-workstream scope the reviewer is judged within: the workstream's
 * own declared paths + scope, and every sibling's, so the prompt can say
 * "judge only this; the rest is out of scope." Absent on N=1 (no siblings) —
 * the whole issue is the scope, pre-#1137 behaviour.
 */
export function scopeFor(wsMap: PipelineState["workstreams"], id: string) {
  const keys = Object.keys(wsMap ?? {});
  if (keys.length <= 1) return undefined;
  return {
    own: wsMap?.[id] ? { id, scope: wsMap[id].scope, paths: wsMap[id].paths } : undefined,
    siblings: keys
      .filter((other) => other !== id)
      .map((other) => {
        const w = wsMap?.[other];
        return w ? { id: other, scope: w.scope, paths: w.paths } : undefined;
      })
      .filter((w): w is NonNullable<typeof w> => w !== undefined),
  };
}

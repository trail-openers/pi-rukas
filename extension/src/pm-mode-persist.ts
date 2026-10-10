/**
 * pm-mode-persist — PM mode outlives the process.
 *
 * `pm-mode.ts` keeps the mode in memory, which is right while one process owns
 * the session. A session reopened by another process (`pi --session <id>`, how
 * a headless client continues a conversation after its operator answered)
 * would start with edit and write available and no preamble. The mode is
 * therefore recorded as a custom session entry, which is not part of the model
 * context, and restored from it on `session_start`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPmModeActive, restorePmMode } from "./pm-mode.ts";

export const PM_MODE_ENTRY = "pi-rukas:pm-mode";

interface BranchEntry {
  type?: string;
  customType?: string;
}
interface SessionCtx {
  sessionManager?: { getBranch?: () => BranchEntry[] };
}

/**
 * @param onRestore called when a reopened session is put back in PM mode; the
 *   caller strips the tools there, so this file needs no tool API.
 */
export function registerPmModePersistence(
  pi: Pick<ExtensionAPI, "on" | "appendEntry">,
  onRestore: () => void,
): void {
  let recorded = false;

  pi.on("session_start", (_event, ctx) => {
    const entries = (ctx as SessionCtx).sessionManager?.getBranch?.() ?? [];
    recorded = entries.some((e) => e.type === "custom" && e.customType === PM_MODE_ENTRY);
    if (!recorded) return;
    restorePmMode();
    onRestore();
  });

  pi.on("agent_start", () => {
    if (recorded || !isPmModeActive()) return;
    recorded = true;
    pi.appendEntry(PM_MODE_ENTRY, { armed: true });
  });
}

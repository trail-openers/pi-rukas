/**
 * child-codemode — the single activation seam for Pi codemode in spawned
 * subagents (epic #1026, sub-issue #1030).
 *
 * Why a shared seam: codemode must be appended to the ACTIVE tool set inside
 * EVERY child, in exactly one place per child —
 *   - trust-mode children: child-guards.ts's `session_start` (this file is
 *     loaded into every child via `--extension <child-guards path>`);
 *   - strict/headless children: permission-subagent-guard.ts's
 *     `registerSubagentGuard` (the companion no-ops there under
 *     PI_ENSEMBLE_SUBAGENT_MODE=1, so it owns nothing in that mode).
 * Two inline copies of the append would drift (one side forgetting the
 * flag, or replacing instead of appending), so both registration sites call
 * this one function.
 *
 * The append (never a replace): Pi's `setActiveTools` REPLACES the whole
 * loadout. A replace built from anything less than the current set drops
 * the `mcp__codebase_memory__*` tools and every other tool the session
 * holds. So the current set (`getActiveTools()`) plus `codemode` is written
 * back. `--exclude-tools` still applies (excluded tools are removed from
 * the registry, so they are absent from `getActiveTools()` already and
 * unreachable from codemode scripts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace } from "./trace.ts";

/**
 * Whether codemode is enabled in subagent children.
 *
 * Default ON. `PI_ENSEMBLE_CHILD_CODEMODE=0` restores today's behaviour on
 * both sides of the seam: the child argv carries no `-e builtin:codemode`
 * (spawn-support.ts reads the flag itself) and this function makes no
 * `setActiveTools` call (both registration sites read the flag through here).
 */
export function childCodemodeEnabled(): boolean {
  return process.env.PI_ENSEMBLE_CHILD_CODEMODE !== "0";
}

/**
 * Append `codemode` to the child's active tool set. Safe to run on every
 * session_start: it is a no-op when the flag is off or codemode is already
 * active (e.g. a restored session), and `setActiveTools` ignores names that
 * are not registered (older Pi without the builtin).
 */
export function enableChildCodemode(pi: ExtensionAPI): void {
  if (!childCodemodeEnabled()) {
    trace("child-codemode: PI_ENSEMBLE_CHILD_CODEMODE=0 — activation skipped");
    return;
  }
  try {
    const active = pi.getActiveTools();
    if (active.includes("codemode")) return;
    pi.setActiveTools([...active, "codemode"]);
    trace(
      `child-codemode: codemode appended to the active tool set (${active.length} → ${active.length + 1})`,
    );
  } catch (err) {
    trace(
      `child-codemode: activation failed (child continues without it): ${(err as Error).message}`,
    );
  }
}

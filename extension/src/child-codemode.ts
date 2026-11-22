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
 * back.
 *
 * Defence-in-depth — reviewer write/edit exclusion through codemode: it
 * holds because Pi's `executeCodemode` (pi-coding-agent `src/core/agent.ts`)
 * builds its `sandboxTools` from `getCodemodeCallableTools(ctx.tools)` — the
 * codemode sandbox exposes only callable tools and routes calls through the
 * same `executeTool` + `tool_call` hooks as a direct call. `--exclude-tools` removes the tool from the session registry, so an excluded
 * `write`/`edit` is absent from `getCodemodeCallableTools` and unreachable
 * from scripts (verified against the installed Pi by
 * `extension/smoke-tests/test-codemode-reviewer-rejection.ts`, the live
 * canary to run on every Pi version bump — it is on the Pi-bump checklist
 * in AGENTS.md §4). The exclusion therefore survives the codemode path
 * without any extra gate on this side.
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

/** The env name Pi (>= 1.4.0) reads for its per-process codemode worker cap. */
const CODEMODE_MAX_WORKERS_ENV = "PI_CODEMODE_MAX_WORKERS";

/** Pi's own default is 2; each worker may use up to 256 MB, so 4 bounds a child at 1 GB. */
const DEFAULT_CHILD_CODEMODE_MAX_WORKERS = 4;

/**
 * The worker cap stamped into a codemode child's env.
 *
 * Pi queues a script that finds every worker busy (up to 60s) rather than
 * failing it, so a child firing parallel codemode calls waits for a slot
 * instead of losing the turn to a transient retry; the cap sets how many run at
 * once. `PI_ENSEMBLE_CHILD_CODEMODE_MAX_WORKERS` overrides the default with a
 * positive integer; anything else keeps the default, the same rule Pi applies
 * to its own variable. Empty when codemode is off, so that child's env is
 * unchanged. Below Pi 1.4.0 the variable is unknown and inert.
 */
export function childCodemodeWorkersEnv(): Record<string, string> {
  if (!childCodemodeEnabled()) return {};
  const n = Number(process.env.PI_ENSEMBLE_CHILD_CODEMODE_MAX_WORKERS);
  const workers = Number.isInteger(n) && n > 0 ? n : DEFAULT_CHILD_CODEMODE_MAX_WORKERS;
  return { [CODEMODE_MAX_WORKERS_ENV]: String(workers) };
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

/**
 * child-guards — the companion extension that carries the mode-independent
 * `tool_call` guards INTO spawned subagents in every mode (#926).
 *
 * The bug: the mode-independent guards were registered ONLY inside the full
 * pi-rukas extension (permission-guard.ts / permission-subagent-guard.ts).
 * spawn.ts forwarded that extension to children only in strict/headless mode;
 * a trust-mode child (the interactive default) got `PI_ENSEMBLE_TRUST_MODE=1`,
 * no broker socket, and no pi-rukas extension — so none of the guards ran in
 * the child. Live-proven: an ops child's `gh pr merge 999999 --squash`
 * reached gh.
 *
 * The fix: this file is the harness-owned companion, loaded into EVERY child
 * via `--extension <this file>` from spawn-support.ts (childGuardsArgs),
 * independent of subagentGuardEnabled / PI_ENSEMBLE_DISABLE_SUBAGENT_GUARD /
 * PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD. It calls the shared block
 * (registerModeIndependentGuards in subagent-guard-guards.ts), which is the
 * single list of the three mode-independent guards — never the parent-only
 * ones (registerPmBashGuard stays where it is). The #716 oo-rewrite guard is
 * NOT in the shared block: it is registered by the strict/headless path in
 * permission-subagent-guard.ts, right after the shared block call, and stays
 * out of trust-mode children (see the call site there).
 *
 * No double registration in strict/headless: there the full pi-rukas
 * extension is ALSO forwarded with PI_ENSEMBLE_SUBAGENT_MODE=1 (index.ts →
 * registerPermissionGuard → registerSubagentGuard), so this file's default
 * export NO-OPS when `PI_ENSEMBLE_SUBAGENT_MODE === "1"`. A child therefore
 * has exactly one set of guard hooks in every mode.
 *
 * A missing file must fail the dispatch with a named error, never produce a
 * silently unguarded child — hence the preflight stat in spawn.ts
 * (spawnSpecialistInner, the #893 reporter-preflight.ts pattern).
 */

import { statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerModeIndependentGuards } from "./subagent-guard-guards.ts";
import { trace } from "./trace.ts";

/**
 * The child-guards companion path, resolved relative to this source file
 * (same __dirname seam as FACTS_REPORTER_PATH in facts-reporter.ts). Loaded
 * via `--extension <path>` at spawn time — never auto-discovered from
 * `~/.pi/agent/extensions/`.
 */
export const CHILD_GUARDS_PATH = `${__dirname}/child-guards.ts`;

/**
 * The `--extension` flags that load this companion into a child. Always
 * present, in every mode: the default export self-gates on
 * PI_ENSEMBLE_SUBAGENT_MODE, so strict/headless children (which also receive
 * the full pi-rukas extension) end up with exactly one set of guard hooks.
 */
export function childGuardsArgs(): string[] {
  return ["--extension", CHILD_GUARDS_PATH];
}

/**
 * The pre-spawn existence check for the companion (the #893
 * reporter-preflight.ts pattern): called from spawnSpecialistInner BEFORE
 * buildChildArgs, so a missing file (a stale install or restructure) is a
 * named dispatch failure, never a silently unguarded child. ANY stat failure
 * (ENOENT, EACCES, …) throws. The stat is a diagnostic (fail fast with a
 * named error), not an integrity or security boundary.
 */
export function preflightChildGuards(): void {
  try {
    statSync(CHILD_GUARDS_PATH);
  } catch (err) {
    const reason = (err as Error).message;
    throw new Error(
      `child-guards extension unavailable at ${CHILD_GUARDS_PATH}: ${reason} — run ./install.sh`,
    );
  }
}

/**
 * Register the mode-independent guards into a spawned child.
 *
 * NO-OP when `PI_ENSEMBLE_SUBAGENT_MODE === "1"`: in strict/headless mode the
 * full pi-rukas extension is also forwarded into the child and already
 * registers these guards via registerSubagentGuard — a second registration
 * would install a second `tool_call` hook and run the merge guard's gh/git
 * exec chain twice per merge attempt.
 */
export default function registerChildGuards(pi: ExtensionAPI): void {
  if (process.env.PI_ENSEMBLE_SUBAGENT_MODE === "1") {
    trace(
      "child-guards: PI_ENSEMBLE_SUBAGENT_MODE=1 — full pi-rukas extension registers the guards; no-op",
    );
    return;
  }
  // The shared block is the single list of the three mode-independent guards;
  // registerPmBashGuard stays parent-only (it is not in the block). All three
  // fire before any trust/sandbox bypass by construction.
  //
  // registerOoRewriteGuard (#716) is deliberately NOT registered here. The
  // strict/headless path registers it in permission-subagent-guard.ts, right
  // after its own registerModeIndependentGuards call; the companion also
  // loads into every trust-mode child, and adding the oo-rewrite there would
  // be a behaviour change outside #926's scope. See the call site in
  // permission-subagent-guard.ts.
  registerModeIndependentGuards(pi);
  trace("child-guards: registered the mode-independent guards for this child");
}

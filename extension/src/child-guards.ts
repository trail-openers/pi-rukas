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
 * PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD. It registers the same
 * mode-independent guard block the subagent path uses (the three guards in
 * subagent-guard-guards.ts, registered here explicitly in the same order) —
 * never the parent-only ones (registerPmBashGuard stays where it is), and
 * NOT the #716 oo-rewrite guard, which the shared block carries for
 * strict/headless children but is deliberately out of #926's scope here.
 *
 * No double registration in strict/headless: there the full pi-rukas
 * extension is ALSO forwarded with PI_ENSEMBLE_SUBAGENT_MODE=1 (index.ts →
 * registerPermissionGuard → registerSubagentGuard), so this file's default
 * export NO-OPS when `PI_ENSEMBLE_SUBAGENT_MODE === "1"`. A child therefore
 * has exactly one set of guard hooks in every mode.
 *
 * A missing file must fail the dispatch with a named error, never produce a
 * silently unguarded child — hence the preflight stat below (the #893
 * reporter-preflight.ts pattern, reused here).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerIssueCreationGuard } from "./issue-creation-guard.ts";
import { registerMergeGuard } from "./merge-guard.ts";
import { registerDestructiveGitGuard } from "./permission-subagent-guard.ts";
import { trace } from "./trace.ts";

/**
 * The child-guards companion path, resolved relative to this source file
 * (same __dirname seam as FACTS_REPORTER_PATH in facts-reporter.ts). Loaded
 * via `--extension <path>` at spawn time — never auto-discovered from
 * `~/.pi/agent/extensions/`.
 */
export const CHILD_GUARDS_PATH = `${__dirname}/child-guards.ts`;

/**
 * The preflight existence check for the companion, mirroring
 * reporter-preflight.ts: a missing path (a stale install or restructure) is a
 * named pre-spawn failure, not a silent unguarded child. Injectable for
 * tests so the missing case can be exercised without touching the real
 * filesystem.
 */
export async function statChildGuardsPath(
  p: string,
  check: (p: string) => Promise<unknown> = statDefault,
): Promise<void> {
  try {
    // The stat is a diagnostic (fail fast with a named error), not an
    // integrity or security boundary.
    await check(p);
  } catch {
    throw new Error(`child-guards extension missing: ${p} — run ./install.sh`);
  }
}

/**
 * The `--extension` flags that load this companion into a child. Always
 * present, in every mode: the default export self-gates on
 * PI_ENSEMBLE_SUBAGENT_MODE, so strict/headless children (which also receive
 * the full pi-rukas extension) end up with exactly one set of guard hooks.
 */
export function childGuardsArgs(): string[] {
  return ["--extension", CHILD_GUARDS_PATH];
}

async function statDefault(p: string): Promise<unknown> {
  const { stat } = await import("node:fs/promises");
  return stat(p);
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
  // The three mode-independent guards, in the same order as the shared block
  // (subagent-guard-guards.ts), so a trust-mode child and a strict-mode child
  // register identical hooks in identical order. registerPmBashGuard stays
  // parent-only (it is not in the block). All three fire before any
  // trust/sandbox bypass by construction.
  //
  // registerOoRewriteGuard (#716) is deliberately NOT registered here. The
  // shared block carries it for strict/headless children (unchanged
  // behaviour), but the companion also loads into every trust-mode child —
  // adding it there would newly activate the oo-rewrite inside those
  // children, a behaviour change outside #926's scope. See
  // subagent-guard-guards.ts for the shared registration site.
  registerDestructiveGitGuard(pi);
  registerIssueCreationGuard(pi);
  registerMergeGuard(pi);
  trace("child-guards: registered the mode-independent guards for this child");
}

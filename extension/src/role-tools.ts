/**
 * Per-role tool exclude lists for SPAWNED SUBAGENTS (PR #238 — Option A in
 * plan indexed-swimming-lovelace.md).
 *
 * Background: trust-mode (#215) stripped per-call permission gating, leaving
 * doctrine alone to keep agents in their roles. Under load, doctrine grip
 * slips. Research (Flue + LangGraph) names per-role tool gating at
 * the dispatch boundary as the primary structural lever — Flue's
 * `defineAgentProfile({ tools })` filters the model's toolbox so it cannot
 * call what it wasn't given, regardless of what the prompt says.
 *
 * Scope: this file gates **spawned subagents** (developer, ops, explore,
 * adversarial-developer, code-review-specialist). The parent Pi session
 * (which acts as PM when invoked via a /work slash command, but also acts
 * as a generic developer when the user iterates on pi-rukas itself) is
 * NOT gated here — its containment is via doctrine + the user's own
 * supervision, and structural per-step gating arrives with Option D
 * (checkpointed /work). Adding `--exclude-tools` to the parent would break
 * meta-work like "edit project-manager.md".
 *
 * Why exclude-list, not allow-list: Pi keeps adding tools (ctx7,
 * mcp__codebase_memory__* (pre-#959: codebase_memory_*), dispatch_*). An
 * exhaustive per-role allow-list would drift the moment Pi or pi-rukas adds
 * a tool. Exclude-list only names what we KNOW should not be on a role —
 * much more stable.
 *
 * What we exclude per role:
 *
 *  - adversarial-developer: write, edit, multiedit. This role is a
 *    skeptical READER; it must not modify the diff under review (silent
 *    edit + approve is a catastrophic regression that doctrine alone
 *    historically failed to prevent).
 *
 *  - code-review-specialist: write, edit, multiedit. Same reasoning —
 *    reviewer must not be able to mutate the code it reviews. agents.json
 *    has `write: deny` + `edit: deny` already; this is the structural
 *    backstop now that those are doctrine-only post-#215.
 *
 *  - explore: write, edit, multiedit. Explore is a researcher; the role
 *    prompt forbids file modifications, and now the runtime does too.
 *
 *  - developer, ops: empty exclude list. These roles legitimately need
 *    write/edit/bash to do their jobs. Tool-gating doesn't help here
 *    (developer SHOULD edit); their containment lives at the workflow
 *    layer (Option D — checkpointed /work, tracked in #237).
 *
 *  - project-manager (rarely spawned — usually the parent process, not a
 *    subagent): empty. If a future flow spawns PM as a subagent it inherits
 *    the same trust assumptions as the parent.
 */

import { isVersionOlder, settledPiVersion } from "./pi-version-probe.ts";

export type Role =
  | "project-manager"
  | "developer"
  | "ops"
  | "explore"
  | "adversarial-developer"
  | "code-review-specialist";

const ROLE_TOOL_EXCLUDES: Record<Role, string[]> = {
  "project-manager": [],
  developer: [],
  ops: [],
  explore: ["write", "edit", "multiedit"],
  "adversarial-developer": ["write", "edit", "multiedit"],
  "code-review-specialist": ["write", "edit", "multiedit"],
};

/** The first pi whose `--exclude-tools` accepts `*` patterns; older pis match names literally. */
const EXCLUDE_PATTERNS_MIN_PI = "1.0.4";

/**
 * Return the comma-separated `--exclude-tools` value for a role, or undefined
 * when the role has no exclusions (caller should omit the flag entirely in
 * that case). The empty-string case is handled defensively: an array of `[]`
 * returns undefined so spawn.ts skips appending an empty `--exclude-tools`
 * arg that Pi might reject or interpret as "exclude everything".
 *
 * When the running pi is known to accept patterns, each name becomes a
 * prefix pattern (`write*`), so a tool pi adds or renames under the same stem
 * (`write_file`) stays excluded. An unknown version (the probe has not
 * settled, or failed) gets the enumerated names, which every pi accepts.
 * Deltas (`+name`/`-name`) are a `--tools` form only, so they have no place here.
 */
export function excludeToolsFor(
  role: string,
  piVersion: string | null = settledPiVersion(),
): string | undefined {
  // Unknown role: no exclusions (matches the default — better to err open
  // than to break a future role we haven't added here yet).
  const list = ROLE_TOOL_EXCLUDES[role as Role];
  if (!list || list.length === 0) return undefined;
  if (piVersion === null || isVersionOlder(piVersion, EXCLUDE_PATTERNS_MIN_PI)) {
    return list.join(",");
  }
  return list.map((name) => `${name}*`).join(",");
}

/**
 * Test-only — returns the underlying exclude-list as an array so smokes can
 * assert the shape directly without parsing the CSV.
 */
export function excludeToolListFor(role: string): readonly string[] {
  return ROLE_TOOL_EXCLUDES[role as Role] ?? [];
}

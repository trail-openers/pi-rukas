/**
 * work-driver-protected-grant — the operator's per-cycle allowance for named
 * protected paths (#1090).
 *
 * The #406 gate halts a develop patch that touches `.github/`, `.pi/`,
 * `CODEOWNERS` or `agents.json`. That is right when the cycle edits them on
 * its own initiative and wrong when the issue IS the CI change: the developer
 * cannot satisfy the gate by trying again, and the only escape was the
 * process-wide `PI_ENSEMBLE_PROTECTED_PATHS=0`, which switches the gate off for
 * every path in every cycle that Pi process runs.
 *
 * `/work N --allow-protected <path>` names the exact paths one cycle may
 * write. Where it may come from is the whole design, for the same reason as
 * `--merge` (#380/#408): a cycle must not authorise its own capability edits.
 * So the grant is parsed only from the operator's slash-command arguments,
 * `start_work_driver` forces it empty, and nothing derived from the issue body,
 * explore or the planner is ever read as a grant. The gate reads it from the
 * `DriverContext`, never from the state file — that file sits in the repo a
 * child can write to, and is a record, not an authority.
 *
 * Matching is exact on the normalised path (`protectedPathKey`): a grant for
 * one workflow admits that file, not its directory and not `CODEOWNERS`.
 * Granted paths still go through the #285 scope/fanout gate.
 */

import { isDirectoryEntry, protectedPathKey } from "./work-driver-doctrine.ts";
import type { WorkState } from "./workflow-state.ts";

export const ALLOW_PROTECTED_FLAG = "--allow-protected";

/**
 * The protected paths in `hits` the grant does not name exactly.
 *
 * A directory entry is ALWAYS ungranted, whatever the grant says (#1090): a
 * grant admits one file, and a directory key matching would admit every file
 * under it. `grant` is already in key form (`splitProtectedGrant`).
 */
export function ungrantedProtectedPaths(
  hits: readonly string[],
  grant: readonly string[] | undefined,
): string[] {
  const granted = new Set((grant ?? []).map(protectedPathKey));
  return hits.filter((h) => isDirectoryEntry(h) || !granted.has(protectedPathKey(h)));
}

/**
 * Record the current invocation's grant on the state file — set when present,
 * removed when absent, so a resume without the flag never displays a stale one.
 */
export function recordProtectedGrant(
  state: WorkState,
  grant: readonly string[] | undefined,
): WorkState {
  const { protectedGrant: _prior, ...rest } = state;
  return grant && grant.length > 0 ? { ...rest, protectedGrant: [...grant] } : rest;
}

/** The PR-body / handoff record of a grant; empty when there is none. */
export function protectedGrantSectionOf(grant: readonly string[] | undefined): string {
  if (!grant || grant.length === 0) return "";
  return [
    "### Operator-granted protected paths",
    "",
    `This cycle ran with \`${ALLOW_PROTECTED_FLAG}\`, so develop was allowed to write these protected paths. Review them as changes to what verification means:`,
    "",
    ...grant.map((p) => `- \`${p}\``),
  ].join("\n");
}

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

import { isProtectedPath, protectedPathKey } from "./work-driver-doctrine.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { WorkState } from "./workflow-state.ts";

export const ALLOW_PROTECTED_FLAG = "--allow-protected";

/** Normalise an operator-written grant entry to the gate's comparison form. */
function grantKey(raw: string): string {
  return protectedPathKey(normaliseDeclaredPath(raw));
}

/**
 * Split `--allow-protected <path>` pairs out of `/work` tokens. The flag is
 * repeatable and its value may be comma-separated. The values are removed from
 * `rest` so a path is never read as an issue number (`parseInt("2fa/…") === 2`).
 */
export function splitProtectedGrant(
  tokens: readonly string[],
): { grant: string[]; rest: string[] } | { error: string } {
  const grant: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    if (t !== ALLOW_PROTECTED_FLAG) {
      rest.push(t);
      continue;
    }
    const value = tokens[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return {
        error: `pi-rukas: ${ALLOW_PROTECTED_FLAG} needs a path (e.g., /work 123 ${ALLOW_PROTECTED_FLAG} .github/workflows/ci.yml).`,
      };
    }
    i++;
    for (const raw of value.split(",")) {
      const key = grantKey(raw);
      if (key.length === 0) continue;
      // A grant names a protected file exactly; `..` or a path the gate never
      // halts on is a typo the operator should hear about, not a silent no-op.
      if (key.split("/").includes("..") || !isProtectedPath(key)) {
        return {
          error: `pi-rukas: ${ALLOW_PROTECTED_FLAG} ${raw} is not a protected path — it grants only files under .github/ or .pi/, CODEOWNERS or agents.json, named exactly.`,
        };
      }
      grant.push(key);
    }
  }
  return { grant: [...new Set(grant)].sort(), rest };
}

/** The protected paths in `hits` the grant does not name exactly. */
export function ungrantedProtectedPaths(
  hits: readonly string[],
  grant: readonly string[] | undefined,
): string[] {
  const granted = new Set((grant ?? []).map(grantKey));
  return hits.filter((h) => !granted.has(protectedPathKey(h)));
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

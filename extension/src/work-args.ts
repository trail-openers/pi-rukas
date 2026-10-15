/**
 * work-args — parsing `/work` arguments into a `WorkInvocation`.
 *
 * Split from `work-entry.ts` (file-size cap). The operator-only grants —
 * `--merge` (#380) and `--allow-protected` (#1090) — are parsed here and
 * nowhere else; `start_work_driver` overrides both after calling this.
 */

import { splitProtectedGrant } from "./work-driver-protected-grant.ts";

export interface WorkInvocation {
  issues: number[];
  restart: boolean;
  /** Operator-only. Never settable from a tool — see work-entry.ts. */
  mergeGrant: boolean;
  /** #1090 — operator-only, like `mergeGrant`; the tool forces it empty. */
  protectedGrant: string[];
  headless?: boolean;
}

/**
 * Parse `/work` arguments.
 *
 * Returns an `error` string rather than throwing, so both the command and the
 * tool can render it in their own idiom.
 */
export function parseWorkArgs(args: string): WorkInvocation | { error: string } {
  const split = splitProtectedGrant(args.trim().split(/\s+/).filter(Boolean));
  if ("error" in split) return split;
  const tokens = split.rest;
  const issues = tokens
    .filter((t) => !t.startsWith("--"))
    .map((t) => Number.parseInt(t, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (issues.length === 0) {
    return {
      error:
        "pi-rukas: /work needs at least one issue number (e.g., /work 547, or /work 561 562 to analyze + group multi-issue).",
    };
  }
  // #1090 — a grant is for one issue's cycle; a queue would hand it to
  // unrelated cycles too.
  if (split.grant.length > 0 && issues.length > 1) {
    return {
      error:
        "pi-rukas: --allow-protected applies to a single issue — run the issue that needs it on its own (e.g., /work 123 --allow-protected .github/workflows/ci.yml).",
    };
  }
  return {
    issues,
    restart: tokens.includes("--restart"),
    // #380 — the operator's grant of merge authority for this run. The only
    // other source is an explicit grant in the project's AGENTS.md; with
    // neither, cycles open their PR and park.
    mergeGrant: tokens.includes("--merge"),
    protectedGrant: split.grant,
  };
}

/**
 * work-args — parsing `/work` arguments into a `WorkInvocation`.
 *
 * Split from `work-entry.ts` (file-size cap). The operator-only grants —
 * `--merge` (#380) and `--allow-protected` (#1090) — are parsed here and
 * nowhere else; `start_work_driver` overrides both after calling this.
 */

import { SAFE_PATH_RE, isProtectedPath, protectedPathKey } from "./work-driver-doctrine.ts";
import { ALLOW_PROTECTED_FLAG } from "./work-driver-protected-grant.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";

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

/** Normalise an operator-written grant entry to the gate's comparison form. */
function grantKey(raw: string): string {
  return protectedPathKey(normaliseDeclaredPath(raw));
}

/**
 * Split `--allow-protected <path>` (or `--allow-protected=<path>`) out of
 * `/work` tokens. The flag is repeatable and its value may be comma-separated.
 * The values are removed from `rest` so a path is never read as an issue
 * number (`parseInt("2fa/…") === 2`). A flag that yields no path is an error,
 * never a silently empty grant.
 */
export function splitProtectedGrant(
  tokens: readonly string[],
): { grant: string[]; rest: string[] } | { error: string } {
  const grant: string[] = [];
  const rest: string[] = [];
  const needsPath = {
    error: `pi-rukas: ${ALLOW_PROTECTED_FLAG} needs a path (e.g., /work 123 ${ALLOW_PROTECTED_FLAG} .github/workflows/ci.yml).`,
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    let value: string | undefined;
    if (t.startsWith(`${ALLOW_PROTECTED_FLAG}=`)) {
      value = t.slice(ALLOW_PROTECTED_FLAG.length + 1);
    } else if (t === ALLOW_PROTECTED_FLAG) {
      value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) return needsPath;
      i++;
    } else {
      rest.push(t);
      continue;
    }
    const keys = value
      .split(",")
      .map(grantKey)
      .filter((k) => k.length > 0);
    if (keys.length === 0) return needsPath;
    for (const key of keys) {
      // A grant names a protected file exactly, as a plain path token; `..`, a
      // path the gate never halts on, or one that cannot be rendered safely in
      // the PR body is a mistake the operator should hear about, not a no-op.
      if (key.split("/").includes("..") || !SAFE_PATH_RE.test(key) || !isProtectedPath(key)) {
        return {
          error: `pi-rukas: ${ALLOW_PROTECTED_FLAG} ${key} is not a grantable path — it grants only files under .github/ or .pi/, CODEOWNERS or agents.json, named exactly as plain path tokens.`,
        };
      }
      grant.push(key);
    }
  }
  return { grant: [...new Set(grant)].sort(), rest };
}

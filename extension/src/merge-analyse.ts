/**
 * merge-analyse — what one bash command merges, as the merge guard decides
 * it: the matched span, the PR/MR number and the repo (#912, #955), read
 * from the raw command AND from its canonical words (#962).
 *
 * The raw reading keeps the command's structure (substitutions, subshells,
 * shell-eval bodies); the canonical reading (merge-canonical.ts) sees the
 * words bash executes after quote removal (`\gh`, `g"h"`, `1"7"`). Neither
 * is complete on its own, so both run:
 *
 *   - either one finding an unsafe repo value refuses;
 *   - a merge either one finds is a merge;
 *   - when both find a merge but disagree on the number or the repo, the
 *     command is ambiguous and refused — the guard must never check the
 *     ledger for a different PR than the one the command merges.
 */

import { stripQuotedSegments } from "./bash-command-parser.ts";
import { mergesPr } from "./bash-merges-pr.ts";
import { canonicalCommand } from "./merge-canonical.ts";
import { extractMergeNumber, mergeVerbArgs, mergeVerbRepo } from "./merge-parse.ts";
import { REPO_VALUE_PATTERN } from "./merge-tokens.ts";

export type MergeAnalysis =
  | { kind: "none" }
  | { kind: "unsafe" }
  | { kind: "ambiguous" }
  | { kind: "merge"; span: string; prNumber: number | undefined; repo: string | undefined };

/**
 * Analyse `command` (raw and canonical). Throws only what the matcher
 * throws on pathological input; the caller refuses on a throw.
 */
export function analyseMergeCommand(command: string): MergeAnalysis {
  const raw = analyseText(command);
  const canonical = canonicalCommand(command);
  if (canonical === undefined || canonical === command) return raw;
  const canon = analyseText(canonical);
  if (raw.kind === "unsafe" || canon.kind === "unsafe") return { kind: "unsafe" };
  if (raw.kind !== "merge") return canon;
  if (canon.kind !== "merge") return raw;
  if (raw.prNumber !== canon.prNumber || raw.repo !== canon.repo) return { kind: "ambiguous" };
  return raw;
}

/** One reading of one command text (the guard's #955 extraction, unchanged). */
function analyseText(command: string): MergeAnalysis {
  const span = mergesPr(command);
  if (!span) return { kind: "none" };
  // The verb door (`gh pr merge …` / `glab mr merge …`) carries the number
  // in the arguments AFTER the matched verb; the REST doors
  // (`gh api …/pulls/N/merge`) carry it inside the matched span.
  const fromVerb = mergeVerbArgs(command);
  // The repo is read from the WHOLE command: the -R flag can precede the
  // verb (`gh -R o/r pr merge 17`). An invalid value (`o/r; touch /tmp/x`)
  // is a shell injection — refused, never interpolated (#955 lens fix 1).
  const fromRepo = mergeVerbRepo(command);
  if (fromRepo?.kind === "unsafe") return { kind: "unsafe" };
  // On the REST doors `mergeVerbRepo` cannot see the command (they use
  // `api`, not the merge verb), so the REST invocation's own repo flag
  // (`gh -R o/r api …/pulls/N/merge`) is threaded instead (#955 adversarial
  // round 5).
  const repo = fromRepo?.kind === "repo" ? fromRepo.repo : restRepoFor(command);
  const prNumber = fromVerb !== undefined ? extractMergeNumber(fromVerb) : extractPrNumber(span);
  return { kind: "merge", span, prNumber, repo };
}

/**
 * The repo flag on a REST-door invocation (`gh -R o/r api …`, `glab
 * --project o/r api …`, and the `=` spellings), anchored to the repo shape
 * (`REPO_VALUE_PATTERN`) so an injected value can never be threaded into an
 * exec string. A REST READ never reaches here (`mergesPr` returns
 * undefined first). `--project` is the repo flag the verb door already
 * accepts for glab (#962: the REST thread read only `-R`/`--repo`).
 */
function restRepoFor(command: string): string | undefined {
  const c = stripQuotedSegments(command);
  // No `\b` before the flag: `-R` / `--repo` begin with a non-word
  // character, so a leading word-boundary assertion never matches (the
  // guard would silently read no repo and verify the PR in the CWD's repo).
  const m = new RegExp(
    `(?:^|[;&|\\s])(?:-R|--repo|--project)(?:\\s+|=)(${REPO_VALUE_PATTERN.source.slice(1, -1)})`,
  ).exec(c);
  return m?.[1];
}

/**
 * The PR number inside a REST-door span (`gh api …/pulls/12/merge` → 12,
 * `glab api …/mr/7/merge` → 7). Read from the matched span ONLY — the
 * whole command would pick up unrelated numbers (`cd /data/3 && …`) — and
 * from the path segment before `/merge` (#962: the first number in
 * `projects/1/merge_requests/17/merge` is the project id, not MR 17).
 */
function extractPrNumber(matched: string): number | undefined {
  const m = /\/(\d+)\/merge(?:[?&#]|$)/.exec(matched);
  return m?.[1] ? Number.parseInt(m[1], 10) : undefined;
}

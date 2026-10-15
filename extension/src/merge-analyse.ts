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

import { mergesPr } from "./bash-merges-pr.ts";
import { canonicalCommand } from "./merge-canonical.ts";
import { scanMergeHeads } from "./merge-heads.ts";
import {
  extractMergeNumber,
  mergeVerbArgs,
  mergeVerbRepo,
  repoFlagInTokens,
} from "./merge-parse.ts";
import { isValidRepoValue, shellSegments } from "./merge-tokens.ts";

export type MergeAnalysis =
  | { kind: "none" }
  | { kind: "unsafe" }
  | { kind: "ambiguous" }
  | { kind: "multiple" }
  | { kind: "nested" }
  | { kind: "repos" }
  | { kind: "merge"; span: string; prNumber: number | undefined; repo: string | undefined };

/**
 * Analyse `command` (raw and canonical). Throws only what the matcher
 * throws on pathological input; the caller refuses on a throw.
 */
export function analyseMergeCommand(command: string): MergeAnalysis {
  // Cheap pre-filter for the common non-merge call: every merge shape names
  // `merge` once line continuations, quotes and escapes are removed. An
  // ANSI-C `$'…'` string can spell it in escapes and a brace list can
  // assemble it (`m{e,}rge`), so either one always runs the full analysis.
  const plain = command.replace(/\\\n/g, "").replace(/["'\\]/g, "");
  if (!plain.includes("merge") && !command.includes("$'") && !/\{[^}]*,/.test(command)) {
    return { kind: "none" };
  }
  const raw = analyseText(command);
  const canonical = canonicalCommand(command);
  // An unclosed quote (`undefined`) is a bash syntax error — nothing runs —
  // and the raw reading already fails closed on it.
  if (canonical === undefined || canonical === command) return raw;
  const canon = analyseText(canonical);
  if (raw.kind === "unsafe" || canon.kind === "unsafe") return { kind: "unsafe" };
  if (raw.kind === "nested" || canon.kind === "nested") return { kind: "nested" };
  if (raw.kind === "multiple" || canon.kind === "multiple") return { kind: "multiple" };
  if (raw.kind === "repos" || canon.kind === "repos") return { kind: "repos" };
  if (raw.kind !== "merge") return canon;
  if (canon.kind !== "merge") return raw;
  if (raw.prNumber !== canon.prNumber || raw.repo !== canon.repo) return { kind: "ambiguous" };
  return raw;
}

/** One reading of one command text (the guard's #955 extraction, unchanged). */
function analyseText(command: string): MergeAnalysis {
  const span = mergesPr(command);
  if (!span) return { kind: "none" };
  // #962 / #1317: the number and repo come from the FIRST merge read, so
  // every merge head must be found and judged — at every depth. A second
  // merge (`gh pr merge 17 && gh pr merge 5`, `bash -c "… && …"`) or one
  // hidden in a substitution (`gh pr merge 17 "$(gh pr merge 5)"`) would
  // otherwise run unchecked. merge-heads.ts walks all of them.
  const scan = scanMergeHeads(command);
  if (scan.deep || scan.nested) return { kind: "nested" };
  if (scan.heads > 1) return { kind: "multiple" };
  // #1317: gh and glab take the LAST repo selector; the guard reads the
  // first. A merge naming two repos is refused, never checked against one.
  if (scan.repoSelectors > 1) return { kind: "repos" };
  const merging = shellSegments(command).filter((seg) => mergesPr(seg) !== undefined);
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
  const rest = fromRepo ?? restRepoFor(merging[0] ?? command);
  if (rest?.kind === "unsafe") return { kind: "unsafe" };
  const repo = rest?.repo;
  const prNumber = fromVerb !== undefined ? extractMergeNumber(fromVerb) : extractPrNumber(span);
  return { kind: "merge", span, prNumber, repo };
}

/**
 * The repo flag on a REST-door invocation (`gh -R o/r api …`, `glab
 * --project o/r api …`), read by the SAME token reader the verb door uses
 * (`repoFlagInTokens`: every `=` / glued `-RVALUE` / quoted spelling, #962)
 * over the segment that carries the merge (never an unrelated segment's
 * flag: `gh -R a/b pr view 1; gh api …/merge`). A REST READ never reaches here (`mergesPr` returns
 * undefined first). An invalid or empty value is unsafe — refused, never
 * interpolated and never silently replaced by the CWD's repo.
 */
function restRepoFor(seg: string): { kind: "repo"; repo: string } | { kind: "unsafe" } | undefined {
  const v = repoFlagInTokens(seg);
  if (v === undefined) return undefined;
  return isValidRepoValue(v) ? { kind: "repo", repo: v } : { kind: "unsafe" };
}

/**
 * The PR number inside a REST-door span (`gh api …/pulls/12/merge` → 12,
 * `glab api …/mr/7/merge` → 7). Read from the matched span ONLY — the
 * whole command would pick up unrelated numbers (`cd /data/3 && …`) — and
 * from the path segment before `/merge` (#962: the first number in
 * `projects/1/merge_requests/17/merge` is the project id, not MR 17).
 */
function extractPrNumber(matched: string): number | undefined {
  const m = /\/(\d+)\/merge\b/.exec(matched);
  return m?.[1] ? Number.parseInt(m[1], 10) : undefined;
}

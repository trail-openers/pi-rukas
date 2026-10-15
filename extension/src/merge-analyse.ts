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
 *
 * #1317: a reading that FAILS (the canonical words cannot be built, a brace
 * group is not enumerable) and a merge-like command (merge-like.ts) with no
 * readable merge head are refused, never read as "not a merge". A merge head
 * whose number argument cannot be read is refused too — only a head with NO
 * positional argument may resolve its PR from the current branch.
 */

import { mergesPr, restDoorTokens } from "./bash-merges-pr.ts";
import { parseArgsAfterVerb } from "./merge-args.ts";
import { canonicalCommand } from "./merge-canonical.ts";
import { scanMergeHeads } from "./merge-heads.ts";
import { executableText, mergeLike } from "./merge-like.ts";
import { mergeVerbArgs, mergeVerbRepo, repoFlagInTokens } from "./merge-parse.ts";
import {
  isSeparatorToken,
  isValidRepoValue,
  rawTokens,
  shellSegments,
  unquoteArg,
  verbForge,
} from "./merge-tokens.ts";
import { matchMergeVerb } from "./merge-verb-head.ts";

export type MergeAnalysis =
  | { kind: "none" }
  | { kind: "unsafe" }
  | { kind: "ambiguous" }
  | { kind: "multiple" }
  | { kind: "nested" }
  | { kind: "repos" }
  /** The canonical reading failed and the command is merge-like (#1317). */
  | { kind: "unparsed" }
  /** A merge head whose PR number argument (or REST path number) is unreadable (#1317). */
  | { kind: "unreadable" }
  /** Merge-like text with no readable merge head (#1317 backstop). */
  | { kind: "unrecognised" }
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
  if (
    !plain.includes("merge") &&
    !command.includes("$'") &&
    !/\{[^}]*,/.test(command) &&
    !EXPANSION.test(command)
  ) {
    return { kind: "none" };
  }
  const canonical = canonicalCommand(command);
  const result = reconcile(command, analyseText(command), canonical);
  if (result.kind !== "none") return result;
  // #1317 backstop: merge-like text that no reading turned into a merge head
  // is refused, whatever shape it has. echo/printf segments are inert data.
  const mergish =
    mergeLike(executableText(command)) ||
    (canonical !== undefined && mergeLike(executableText(canonical))) ||
    expansionHidesVerb(command);
  return mergish ? { kind: "unrecognised" } : result;
}

/** Characters that make a word's value depend on the shell at run time. */
const EXPANSION = /[$`*?[]/;

/**
 * A forge command whose command word or verb is built by an expansion
 * (`gh pr m$X 17`, `gh pr m$(echo e)rge 17`, `g$X pr merge 17`): the words bash
 * runs are unknown, so the merge it makes cannot be read. Positions are read
 * from the first plain `gh`/`glab` word (within the first three), so an
 * expansion in an argument (`gh pr view $N`, `echo $(gh pr view 1)`) is not a
 * verb. A command word built by an expansion counts when the segment names a
 * forge verb. Single-quoted words are literal and never count.
 */
function expansionHidesVerb(command: string): boolean {
  if (!EXPANSION.test(command)) return false;
  return shellSegments(command).some((seg) => {
    const toks = rawTokens(seg);
    if (toks.terminated === false) return false;
    const words = toks.list.filter((t) => !isSeparatorToken(t));
    const live = (w: string) => !w.startsWith("'") && !w.startsWith("$'") && EXPANSION.test(w);
    const plain = words.map((w) => unquoteArg(w).split("/").pop() ?? "");
    const k = plain.slice(0, 3).findIndex((w) => w === "gh" || w === "glab");
    if (k !== -1) return words.slice(k, k + 3).some(live);
    return live(words[0] ?? "") && plain.some((w) => /^(?:gh|glab|pr|mr|api)$/.test(w));
  });
}

/** Combine the raw reading with the canonical one (see the module doc). */
function reconcile(
  command: string,
  raw: MergeAnalysis,
  canonical: string | undefined,
): MergeAnalysis {
  // The words bash runs are unknown (an unclosed quote, a heredoc body, a
  // brace group past the bound). A merge-like command is refused; a command
  // that is not merge-like keeps its raw reading, as before.
  if (canonical === undefined) return mergeLike(command) ? { kind: "unparsed" } : raw;
  if (canonical === command) return raw;
  const canon = analyseText(canonical);
  if (raw.kind === "unsafe" || canon.kind === "unsafe") return { kind: "unsafe" };
  if (raw.kind === "nested" || canon.kind === "nested") return { kind: "nested" };
  if (raw.kind === "multiple" || canon.kind === "multiple") return { kind: "multiple" };
  if (raw.kind === "repos" || canon.kind === "repos") return { kind: "repos" };
  if (raw.kind === "merge" && canon.kind === "merge") {
    if (raw.prNumber !== canon.prNumber || raw.repo !== canon.repo) return { kind: "ambiguous" };
    return raw;
  }
  if (raw.kind === "unreadable" || canon.kind === "unreadable") return { kind: "unreadable" };
  return raw.kind === "merge" ? raw : canon;
}

/** One reading of one command text (the guard's #955 extraction). */
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
  // #1317: a repo selector on another segment (`gh -R a/b pr view 1; gh pr
  // merge 17`) names a repo this merge does not use — refused unless it is
  // the merge's own repo.
  if (strayRepoSelector(command, repo)) return { kind: "repos" };
  if (fromVerb !== undefined) {
    const parsed = parseArgsAfterVerb(fromVerb, verbForge(command));
    // #1317 item B: a positional that is not a plain number (`$PR`, `x17`) is
    // a PR the guard cannot read — refused, never resolved from the branch.
    if (parsed.unreadable) return { kind: "unreadable" };
    return { kind: "merge", span, prNumber: parsed.number, repo };
  }
  // The REST door: the number must be read from the matched path (`pulls/N/merge`,
  // with or without a leading slash). `pulls/merge` has none — refused.
  const prNumber = extractPrNumber(span);
  if (prNumber === undefined) return { kind: "unreadable" };
  return { kind: "merge", span, prNumber, repo };
}

/** True when a non-merge segment carries a repo selector other than `repo` (#1317). */
function strayRepoSelector(command: string, repo: string | undefined): boolean {
  return shellSegments(command).some((seg) => {
    if (matchMergeVerb(seg) !== undefined || restDoorTokens(seg) !== undefined) return false;
    const value = repoFlagInTokens(seg);
    return value !== undefined && value !== repo;
  });
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
 * `gh api pulls/12/merge` → 12, `glab api …/mr/7/merge` → 7). Read from the
 * matched span ONLY — the whole command would pick up unrelated numbers
 * (`cd /data/3 && …`) — and from the path segment before `/merge` (#962: the
 * first number in `projects/1/merge_requests/17/merge` is the project id, not
 * MR 17). The leading slash is optional (#1317).
 */
function extractPrNumber(matched: string): number | undefined {
  const m = /(?:^|\/)(\d+)\/merge\b/.exec(matched);
  return m?.[1] ? Number.parseInt(m[1], 10) : undefined;
}

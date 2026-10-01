/**
 * merge-parse — the command-side half of the merge guard (#912, defect fix
 * #955): which raw command merges a PR/MR, and what target (number, repo)
 * the matched merge verb names.
 *
 * Two defects from the lievo incident (2026-10-01, PR #17) fixed here:
 * 1. The verb door matched a SPAN that stopped at the whitespace after
 *    `merge`, so the PR number was never inside the matched text — every
 *    numbered merge fell back to current-branch resolution.
 * 2. A merge wrapped in a subshell (`bash -c '… gh pr merge 17 …'`) was
 *    invisible: stripQuotedSegments DELETES the quoted -c body, so no
 *    merge verb remained to match — a genuine bypass.
 *
 * Round-2 hardening (#955, adversarial round 2): the legacy matcher still
 * missed every merge hidden behind a process wrapper (`timeout 30 gh pr
 * merge 17`, `command …`, `nohup …`, `sudo …`, `nice …`, `time …`, `oo …`,
 * `stdbuf …`, `env -u FOO …`, `exec …`), a forge PATH (`/usr/bin/gh pr
 * merge 17`), or a subshell / command-substitution construct
 * (`( gh pr merge 17 )`, `x=$(gh pr merge 17)`, backticks). Those shapes now
 * match: every shell segment is matched segment-by-segment against the
 * wrapper-stripped head (`matchMergeVerb`, merge-verb-head.ts), and the
 * bodies of `( … )`, `$( … )` and backtick constructs are extracted and
 * matched recursively, the same as `bash -c` bodies. Recursion past the
 * depth budget fails CLOSED (a merge with no number → the fallback
 * refusal), never open.
 *
 * Design (per the #955 decisions):
 * - Subshell/wrapper unwrapping on the RAW command, recursively (depth 3),
 *   with unescaping (\" → ") for double-quoted layers. The guard matches
 *   and extracts on the INNERMOST segment that contains the merge verb.
 * - The PR number / repo are parsed from the arguments AFTER the matched
 *   verb, with a quote-aware tokenizer that skips flag values. The number
 *   is the first bare positional integer (quoted or unquoted — the shell
 *   strips the quotes), a `#N`, or a `/pull/N` / `/pulls/N` /
 *   `/merge_requests/N` URL. Digits before the verb never count (the
 *   `cd /data/3` canary). glab's `--project`/`-R` flag names the repo
 *   (like gh's `-R`/`--repo`).
 * - The REST doors (bash-merges-pr.ts) keep their span-based extraction
 *   and run over the command AND its `( … )` / `$( … )` / backtick
 *   bodies — a REST-door call in a subshell is a live merge, fail-closed.
 *
 * The matcher (`mergesPr`) lives in bash-merges-pr.ts; the token walk and
 * the segment-head unwrapping live in merge-tokens.ts / merge-verb-head.ts.
 */

import { isValidRepoValue, mergeVerbSpanRegex, rawTokens, shellSegments } from "./merge-tokens.ts";
import { innerBodies, matchMergeVerb, mergeVerbUnwrapOne } from "./merge-verb-head.ts";

/**
 * The arguments that follow the matched merge verb, verbatim (the raw tail
 * of the innermost segment that carried the verb). `undefined` when the
 * command does not merge; the empty string when a merge verb matched with
 * nothing after it (the no-number fallback). The REST doors carry their
 * number inside the matched span — that path stays in merge-guard.ts.
 *
 * #955 round 2: an unparseable command (a quote never closes, or a merge
 * hidden past the unwrap budget) is treated as a merge with no number (the
 * empty string) — the fallback refusal, never a clean pass.
 * #955 lens fix 5: an unbalanced `(`/`)` or an odd backtick count in the
 * raw command, combined with a merge verb somewhere in the text, is
 * likewise treated as a merge with no number — the same fail-closed
 * treatment as an unparseable command (handled inside matchMergeVerbTail,
 * which returns the empty-string tail when a null result is combined with
 * a merge verb in the raw text).
 */
export function mergeVerbArgs(command: string): string | undefined {
  return matchMergeVerbTail(command);
}

/**
 * The forge repo the matched merge verb names: the value of `-R`/`--repo`,
 * or the owner/repo inside a PR/MR URL argument. `undefined` when the
 * command does not merge or names no repo. An INVALID repo value (one that
 * could be interpolated into a shell exec string and execute arbitrary
 * commands) is rejected at this boundary — the guard refuses with
 * "unsafe repo value" and never interpolates it (#955 lens fix 1, HIGH).
 */
export function mergeVerbRepo(
  command: string,
): { kind: "repo"; repo: string } | { kind: "unsafe"; raw: string } | undefined {
  const args = mergeVerbArgs(command);
  if (args === undefined) return undefined;
  const tailRepo = parseArgsAfterVerb(args).repo;
  if (tailRepo) {
    if (!isValidRepoValue(tailRepo)) return { kind: "unsafe", raw: tailRepo };
    return { kind: "repo", repo: tailRepo };
  }
  // The repo flag may also sit BEFORE the verb (`gh -R o/r pr merge 17`).
  const preRepo = repoFlagBeforeVerb(command);
  if (preRepo !== undefined && !isValidRepoValue(preRepo)) {
    return { kind: "unsafe", raw: preRepo };
  }
  return preRepo !== undefined ? { kind: "repo", repo: preRepo } : undefined;
}

/**
 * Parse the PR/MR number from the arguments following the merge verb.
 *
 * The number is the first bare positional integer, a `#N`, or a `/pull/N` /
 * `/pulls/N` / `/merge_requests/N` URL. Flag values that take an argument
 * are skipped, so `--subject "x 12"` never reads as PR 12. A quoted run
 * wraps a literal argument — the shell strips the quotes before parsing,
 * so a quoted number (`gh pr merge "17"`) IS the number.
 */
export function extractMergeNumber(args: string): number | undefined {
  return parseArgsAfterVerb(args).number;
}

/**
 * Unwrap ONE shell-eval layer (`bash -c …`, `sh -c …`, `eval …`, with
 * `env`/`oo` wrappers) to its quoted string argument. Re-exported from
 * merge-verb-head.ts (the name the round-1 callers imported) so the merge
 * guard can walk the layers itself when extracting the repo flag (which can
 * appear before the verb, in the pre-verb portion of the command).
 */
export { mergeVerbUnwrapOne };

/** The repo (see `mergeVerbRepo`) parsed from post-verb arguments alone. */
export function extractMergeRepo(args: string): string | undefined {
  return parseArgsAfterVerb(args).repo;
}

// ---------------------------------------------------------------------------
// internals

/**
 * The argument tail after the matched merge verb in `command` (see
 * `mergeVerbArgs`). Walks the shell-eval layers (depth 3) and then every
 * shell segment's head against the wrapper-stripped `matchMergeVerb`
 * (process wrappers, forge paths), recursing into the bodies of subshell /
 * command-substitution constructs.
 *
 * Returns:
 * - the argument tail of the FIRST segment (or inner body) whose head
 *   carries the merge verb (possibly the empty string — the no-number
 *   fallback);
 * - the empty string when the command is UNPARSEABLE (a quote never
 *   closes, an unbalanced construct, or a merge hidden past the unwrap
 *   budget) — the fail-closed signal: a merge with no number, the fallback
 *   refusal, never a clean pass;
 * - `undefined` when the command does not merge (or the matched verb has no
 *   argument tail at all — the same no-number fallback, surfaced as the
 *   empty tail).
 *
 * The inner-body recursion is unbounded in PRACTICE but TERMINATING:
 * every extracted body is a strict substring of the text that produced it,
 * so the recursion depth is bounded by the text length — a pathological
 * command with 3000 backticks terminates in O(n) total work, no throw, no
 * exponential blowup.
 */
function matchMergeVerbTail(command: string): string | undefined {
  let text = command;
  for (let d = 0; d < 3; d++) {
    const inner = mergeVerbUnwrapOne(text);
    if (inner !== undefined) {
      text = inner;
      continue;
    }
    break;
  }
  const tail = matchSegmentsTail(text);
  // A `null` tail is the fail-closed signal (unparseable / unbalanced /
  // exhausted budget). Fail closed ONLY when the raw text carries a merge
  // verb — an unterminated quote in a NON-merge command (`echo "( hi`)
  // must NOT trigger the no-number fallback refusal (#955 adversarial
  // round 1, finding 6).
  if (tail === null) {
    if (hasMergeVerbInRaw(command)) return "";
    return undefined;
  }
  return tail;
}

/**
 * Match every shell segment of `text`, and every extracted inner-body
 * construct, recursively. Returns the argument tail of the FIRST segment
 * (or inner body) that carries the merge verb, `null` when an unbalanced
 * construct or an unparseable segment was hit (fail closed), or `undefined`
 * when no segment matches.
 *
 * The recursion terminates: every body is a strict substring of the text
 * that produced it, so each recursive call operates on a strictly shorter
 * string — no exponential blowup, no throw on pathological input.
 */
function matchSegmentsTail(text: string): string | null | undefined {
  const segments = shellSegments(text);
  if (segments.length === 0) return null; // the raw text had an unterminated quote
  for (const seg of segments) {
    if (matchMergeVerb(seg) !== undefined) {
      // The span regex expects the forge word at the start (or after a
      // separator). A subshell segment like `(gh pr merge 17)` starts with
      // `(` — strip a leading paren so the regex can locate the verb.
      const probe = seg.startsWith("(") ? seg.slice(1) : seg;
      const m = mergeVerbSpanRegex().exec(probe);
      // Fail closed: if the verb matched via matchMergeVerb but the span
      // regex can't locate it (should not happen), the command carries a
      // merge with no readable tail — the no-number fallback.
      if (m) {
        const offset = seg.startsWith("(") ? 1 : 0;
        return seg.slice(offset + m.index + m[0].length);
      }
      return "";
    }
    const bodies = innerBodies(seg);
    for (const body of bodies) {
      const inner = matchSegmentsTail(body);
      if (inner === null) return null; // unparseable inner — fail closed
      if (inner !== undefined) return inner; // the inner merge's tail
    }
  }
  return undefined;
}

/** True when the raw command text contains a merge verb (scan-not-anchor). */
function hasMergeVerbInRaw(command: string): boolean {
  return /(?:^|\s)(?:pr|mr)\s+merge\b/.test(command);
}

/**
 * The repo flag placed BEFORE the merge verb (`gh -R o/r pr merge 17`).
 * The token walk is quote-aware (a quoted `"-R"` is not a flag); only
 * unquoted flag tokens count. Runs segment-by-segment over the WHOLE
 * command (scan-not-anchor — the flag can sit in any segment).
 */
function repoFlagBeforeVerb(command: string): string | undefined {
  for (const seg of shellSegments(command)) {
    if (matchMergeVerb(seg) === undefined) continue;
    const tokens = rawTokens(seg);
    if (tokens.terminated === false) continue;
    for (let i = 0; i < tokens.list.length; i++) {
      const t = tokens.list[i] ?? "";
      if (t === "-R" || t === "--repo" || t === "--project") {
        const v = tokens.list[i + 1];
        if (v === undefined || v.length === 0) continue;
        const q = v[0];
        return q === "'" || q === '"' ? v.slice(1, -1) : v;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// verb-argument parsing

/** The PR/MR number and forge repo carried by the post-verb arguments. */
function parseArgsAfterVerb(args: string): {
  number: number | undefined;
  repo: string | undefined;
} {
  // A trailing `&` (job control, `nohup gh pr merge 17 &`) is part of the
  // invocation — the shell runs the command in the background; it is NOT
  // a separator that ends the argument list. Trim it before tokenising so
  // the number / repo in the same invocation still parse.
  const cleaned = args.replace(/\s+&\s*$/, " ").replace(/\s+&&\s*$/, " ");
  // Flags whose value is the next token (it must not be read as the number).
  const TAKES_VALUE = new Set([
    "-s",
    "--subject",
    "-t",
    "--title",
    "-b",
    "--body",
    "-F",
    "--body-file",
    "--match-head-commit",
    "-m",
    "--message",
    "-A",
    "--author-email",
    "-R",
    "--repo",
    // glab's repo flag (same shape as -R): its value must not be read
    // as the MR number.
    "--project",
  ]);
  const tokens = rawTokens(cleaned);
  if (tokens.terminated === false) return { number: undefined, repo: undefined };
  let repo: string | undefined;
  for (let i = 0; i < tokens.list.length; i++) {
    let t = tokens.list[i] ?? "";
    // A trailing `)` (subshell close glued to the token by rawTokens) is
    // stripped before matching — `17)` is the number 17 in `(gh pr merge 17)`.
    if (t.endsWith(")") && t.length > 1) t = t.slice(0, -1);
    if (t === "") continue;
    if (t.startsWith("-")) {
      // `--flag=value` form: the value is inside the token and is never a
      // positional number.
      const eq = t.indexOf("=");
      if (eq > 0) {
        const flagName = t.slice(0, eq);
        if (flagName === "--repo" || flagName === "--project") repo = t.slice(eq + 1);
        continue;
      }
      if (t === "-R" || t === "--repo" || t === "--project") {
        const v = tokens.list[i + 1];
        if (v !== undefined && v.length > 0) {
          const q = v[0];
          repo = q === "'" || q === '"' ? v.slice(1, -1) : v;
          i++;
        }
        continue;
      }
      if (TAKES_VALUE.has(t)) {
        i++; // skip the value token
        continue;
      }
      continue;
    }
    if (t === ";" || t === "&&" || t === "|" || t === "||") {
      // A shell separator ends this invocation's argument list.
      break;
    }
    // Positional argument: a bare integer, a #N, a PR/MR URL, or a quoted
    // integer (the shell strips the quotes — a quoted number is the number).
    const bare = /^(\d+)$/.exec(t) ?? /^"(\d+)"$/.exec(t) ?? /^'(\d+)'$/.exec(t);
    if (bare?.[1]) return { number: Number.parseInt(bare[1], 10), repo };
    const hash = /^#(\d+)$/.exec(t);
    if (hash?.[1]) return { number: Number.parseInt(hash[1], 10), repo };
    const url = /\/(?:pull|pulls|merge_requests)\/(\d+)/.exec(t);
    if (url?.[1]) {
      const ownerRepo = /(?:^|\/)(?:github\.com|gitlab\.com)\/([^/?#]+)\/([^/?#]+)/.exec(t);
      if (ownerRepo?.[1] && ownerRepo[2]) {
        const or = `${ownerRepo[1]}/${ownerRepo[2]}`;
        return { number: Number.parseInt(url[1], 10), repo: or };
      }
      return { number: Number.parseInt(url[1], 10), repo };
    }
    if (repo === undefined && !t.startsWith("<")) {
      // A bare `owner/repo` positional (not a number, not a URL) names the
      // repo the same way -R does.
      const r = /^[-\w]+\/[-\w.]+$/.exec(t);
      if (r?.[0]) repo = r[0];
    }
  }
  return { number: undefined, repo };
}

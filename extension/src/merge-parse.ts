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
 * `stdbuf …`), a forge PATH (`/usr/bin/gh pr merge 17`), or a subshell /
 * command-substitution construct (`( gh pr merge 17 )`, `x=$(gh pr merge 17)`,
 * backticks). Those shapes now match: each shell segment is matched
 * segment-by-segment against a wrapper-stripped head (`matchMergeVerb`,
 * merge-verb-head.ts), and the bodies of `( … )`, `$( … )` and backtick
 * constructs are extracted and matched recursively, the same as `bash -c`
 * bodies. Recursion past the depth budget fails CLOSED (a merge with no
 * number → the fallback refusal), never open.
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
 * - The REST doors keep their existing span-based extraction.
 *
 * The matcher (`mergesPr`) lives in bash-merges-pr.ts; the token walk and
 * the segment-head unwrapping live in merge-tokens.ts / merge-verb-head.ts.
 */

import { rawTokens, shellSegments } from "./merge-tokens.ts";
import { innerBodies, matchMergeVerb, mergeVerbUnwrapOne } from "./merge-verb-head.ts";

/**
 * The arguments that follow the matched merge verb, verbatim (the raw tail
 * of the innermost segment that carried the verb). `undefined` when the
 * command does not merge; the empty string when a merge verb matched with
 * nothing after it (the no-number fallback). The REST doors carry their
 * number inside the matched span — that path stays in merge-guard.ts.
 *
 * #955 round 2: an unterminated quote in the raw command is an UNPARSEABLE
 * command — the #955 rule for unparseable inner strings (treat as a merge
 * with no number → the fallback refusal), not a clean pass.
 */
export function mergeVerbArgs(command: string): string | undefined {
  // Walk the shell-eval layers (depth 3) first, then match the verb and
  // return the argument tail. `matchMergeVerbTail` returns undefined when
  // the command does not merge (or is unparseable) — that is the "not a
  // merge" signal for the REST doors. The fail-closed path (unparseable →
  // treat as a merge with no number) is handled by `mergeVerbSeen`:
  // when `shellSegments` returns an empty array (unterminated quote), the
  // command is treated as a merge with no number (empty tail).
  //
  // IMPORTANT: `matchMergeVerbTail` returning undefined does NOT mean the
  // command is unparseable — it also means "no merge verb found" (which
  // is the normal case for non-merge commands and REST-door commands).
  // The fail-closed path is only triggered when `shellSegments` returns
  // an empty array (a genuinely unparseable command).
  const seen = mergeVerbSeen(command);
  if (seen === undefined) return "";
  return matchMergeVerbTail(command);
}

/**
 * The forge repo the matched merge verb names: the value of `-R`/`--repo`,
 * or the owner/repo inside a PR/MR URL argument. `undefined` when the
 * command does not merge or names no repo.
 */
export function mergeVerbRepo(command: string): string | undefined {
  const args = mergeVerbArgs(command);
  if (args === undefined) return undefined;
  const tailRepo = parseArgsAfterVerb(args).repo;
  if (tailRepo) return tailRepo;
  // The repo flag may also sit BEFORE the verb (`gh -R o/r pr merge 17`).
  return repoFlagBeforeVerb(command);
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
 * The recursive merge-verb matcher (no unwrap budget): shell-eval layers
 * (`bash -c` / `sh -c` / `eval`, with `env`/`oo`) are unwrapped first, then
 * each shell segment's head is tested with the wrapper-stripped
 * `matchMergeVerb` (process wrappers, forge paths), and the bodies of
 * subshell / command-substitution constructs are matched recursively.
 *
 * The depth budget is the `bash -c` layers (depth 3 — a merge 3 shell-eval
 * layers deep is already beyond any real shell shape; deeper nesting is the
 * "unparseable" case that fails closed in `mergeVerbSeen` /
 * `matchMergeVerbTail`). The inner-body recursion is unbounded — those
 * bodies are strictly shorter than their parent, so the recursion
 * terminates, and a merge hidden in a 4-level subshell is exactly the
 * shape that must NOT escape.
 *
 * Returns true when the command merges (some inner segment carries the
 * merge verb), false when it does not, and undefined when the command is
 * unparseable (a quote never closes) — the caller fails closed.
 */
function matchMergeVerbDeep(text: string, depth: number): boolean | undefined {
  let cur = text;
  for (let d = 0; d < 3; d++) {
    const inner = mergeVerbUnwrapOne(cur);
    if (inner !== undefined) {
      cur = inner;
      continue;
    }
    break;
  }
  return matchSegments(cur, depth);
}

/**
 * Match every shell segment of `text`, and every extracted inner-body
 * construct, recursively. Returns true on the first merge verb found,
 * false when no segment matches, undefined when an unbalanced construct or
 * an unparseable segment was hit (fail closed).
 */
function matchSegments(text: string, depth: number): boolean | undefined {
  const segments = shellSegments(text);
  if (segments.length === 0) return undefined; // the raw text had an unterminated quote
  for (const seg of segments) {
    if (matchMergeVerb(seg) !== undefined) return true;
    for (const body of innerBodies(seg)) {
      const inner = matchMergeVerbDeep(body, depth + 1);
      if (inner === true) return true;
      if (inner === undefined) return undefined; // unparseable inner — fail closed
    }
  }
  return false;
}

/**
 * The argument tail after the matched merge verb in `command` (see
 * `mergeVerbArgs`). Walks the same layers as `matchMergeVerbDeep` and
 * returns the tail of the FIRST segment whose head matches the merge verb
 * (the post-verb parser is quote-aware, so the tail is consumed verbatim).
 * Returns undefined when the command does not merge or is unparseable.
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
  return matchSegmentsTail(text, 0);
}

/**
 * The segment-tail companion of `matchSegments`: like `matchSegments`, but
 * returns the argument tail of the first matching segment (or undefined).
 */
function matchSegmentsTail(text: string, depth: number): string | undefined {
  const segments = shellSegments(text);
  if (segments.length === 0) return undefined; // unparseable — fail closed
  for (const seg of segments) {
    if (matchMergeVerb(seg) !== undefined) {
      const m =
        /(?:^|[\s;&|])(?:\/\S*\/)?(?:gh|glab)(?:\s+(?:-R|--repo|--project)\s+\S+)?\s+(?:pr|mr)\s+merge\b/.exec(
          seg,
        );
      // Fail closed: if the verb matched via matchMergeVerb but the span
      // regex can't locate it (should not happen), treat as a merge with
      // no number (empty tail).
      if (m) return seg.slice(m.index + m[0].length);
      return "";
    }
    for (const body of innerBodies(seg)) {
      const tail = matchMergeVerbDeepTail(body, depth + 1);
      if (tail !== undefined) return tail;
      // tail === undefined means unparseable — fail closed (return "").
      if (tail === undefined && innerBodies(seg).length > 0) return "";
    }
  }
  return undefined;
}

/** The deep tail companion of `matchMergeVerbDeep` (see its doc). */
function matchMergeVerbDeepTail(text: string, depth: number): string | undefined {
  let cur = text;
  for (let d = 0; d < 3; d++) {
    const inner = mergeVerbUnwrapOne(cur);
    if (inner !== undefined) {
      cur = inner;
      continue;
    }
    break;
  }
  return matchSegmentsTail(cur, depth);
}

/**
 * The verb-seen companion of `matchSegmentsTail`: true when any segment (or
 * nested construct) carries the merge verb, false when none do, undefined
 * when the text is unparseable (the fail-closed signal).
 */
function mergeVerbSeen(command: string): boolean | undefined {
  let text = command;
  for (let d = 0; d < 3; d++) {
    const inner = mergeVerbUnwrapOne(text);
    if (inner !== undefined) {
      text = inner;
      continue;
    }
    break;
  }
  // Fail closed: if the raw command has an unterminated quote (an
  // unparseable command), treat it as a merge with no number. The
  // #955 rule for unparseable inner strings.
  const segs = shellSegments(text);
  if (segs.length === 0) return undefined; // unparseable → fail closed
  return matchSegments(text, 0);
}

/**
 * The length of the matched verb span in the segment: the (optionally
 * path-qualified) forge word, an optional `-R`/`--repo` value, and the
 * `pr merge` / `mr merge` verb — the argument tail starts just past it.
 */
function verbSpanLength(seg: string): number {
  const m =
    /(?:^|[\s;&|])(?:\/\S*\/)?(?:gh|glab)(?:\s+(?:-R|--repo)\s+\S+)?\s+(?:pr|mr)\s+merge\b/.exec(
      seg,
    );
  if (!m) return 0;
  // The matched span may start with a leading separator character (a space
  // or &/; /|) — strip those so the slice length is the verb span only.
  return m[0].replace(/^\s*[;&|]?\s*/, "").length;
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
    const t = tokens.list[i] ?? "";
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

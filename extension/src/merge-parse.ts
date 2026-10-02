/**
 * merge-parse — the command-side half of the merge guard (#912, defect fix
 * #955): which raw command merges a PR/MR, and what target (number, repo)
 * the matched merge verb names.
 *
 * The verb door matches every shell segment's head against the
 * wrapper-stripped `matchMergeVerb` (merge-verb-head.ts), recursing into
 * `( … )` / `$( … )` / backtick bodies and shell-eval layers (depth 3).
 * Recursion past the budget fails CLOSED (a merge with no number → the
 * fallback refusal), never open. The PR number / repo are parsed from the
 * arguments AFTER the matched verb, with a quote-aware tokenizer that
 * skips flag values. The REST doors (bash-merges-pr.ts) keep their
 * span-based extraction and run over the command AND its inner-body
 * constructs. The token walk lives in merge-tokens.ts; the segment-head
 * unwrapping in merge-verb-head.ts.
 */

import {
  isValidRepoValue,
  mergeVerbSpanRegex,
  rawTokens,
  shellSegments,
  unquoteArg,
} from "./merge-tokens.ts";
import { innerBodies, matchMergeVerb, mergeVerbUnwrapOne } from "./merge-verb-head.ts";
export { mergeVerbUnwrapOne };

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
 * The repo parsed from post-verb arguments alone. Returns `undefined` when
 * the arguments name no repo, or when the value is not a valid repo (an
 * invalid value — one that could be interpolated into a shell exec string
 * and execute arbitrary commands — is refused at this boundary, the same
 * way `mergeVerbRepo` handles unsafe values; #955 lens fix 1, HIGH).
 */
export function extractMergeRepo(args: string): string | undefined {
  const repo = parseArgsAfterVerb(args).repo;
  if (repo !== undefined && !isValidRepoValue(repo)) return undefined;
  return repo;
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
  const layers = 3;
  let used = 0;
  while (used < layers) {
    const inner = mergeVerbUnwrapOne(text);
    if (inner === undefined) break;
    text = inner;
    used++;
    // #955 adversarial round 4 (finding 1): an unwrapped layer that does not
    // terminate (an unterminated quote in the inner text — the shell-eval
    // body is not a valid command) is treated as UNPARSEABLE: the fail-closed
    // no-number signal, never a match on the malformed inner text. (The
    // depth-4 canary case: `bash -c '(sh -c '(gh pr merge 12)')'` unwraps to
    // `(sh -c '(gh pr merge 12)')` — an unterminated single quote — and must
    // refuse, not extract a tail from the malformed text.)
    if (rawTokens(text).terminated === false) return "";
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
    // #955 round-4: the whole-command shell-eval unwrap (mergeVerbUnwrapOne
    // in matchMergeVerbTail) only fires when the shell-eval word starts the
    // WHOLE command — a shell-eval word in a LATER segment (`cd x && bash -c
    // "gh pr merge 17"`, `gh pr view 17; eval "gh pr merge 17"`, `exec
    // bash -c …` after a separator) was missed. `segmentMergeTail` unwraps
    // per segment and returns the argument tail parsed from the unwrapped
    // INNER text (matchMergeVerbTail on the inner), which is where the verb
    // and its arguments actually live. The raw segment's span regex cannot
    // reach the verb inside the quoted body.
    const segTail = segmentMergeTail(seg);
    if (segTail !== undefined) return segTail;
    const bodies = innerBodies(seg);
    for (const body of bodies) {
      const inner = matchSegmentsTail(body);
      if (inner === null) return null; // unparseable inner — fail closed
      if (inner !== undefined) return inner; // the inner merge's tail
    }
  }
  return undefined;
}

/**
 * Match a segment's head against the merge verb, or — when the segment
 * carries a shell-eval wrapper in a LATER segment (`cd x && bash -c "gh pr
 * merge 17"`, invisible to the whole-command unwrap) — unwrap the segment
 * via `mergeVerbUnwrapOne` and return the argument tail parsed from the
 * UNWRAPPED inner text by `matchMergeVerbTail` (the shared 3-layer budget).
 *
 * Returns the argument tail (possibly the empty string — the no-number
 * fallback) when the segment carries the merge verb, or `undefined` when it
 * does not. The inner text is the authoritative source for the tail: the
 * raw segment's span regex cannot see the verb inside a quoted `bash -c`
 * body, so probing the raw segment would lose the PR number and silently
 * fall back to branch resolution (#955 defect class).
 *
 * A quoted body keeps its inert-ness: `cd x && bash -c "echo hi"` unwraps
 * to `echo hi`, which matches no merge verb — the segment stays a non-merge.
 */
function segmentMergeTail(seg: string): string | undefined {
  if (matchMergeVerb(seg) !== undefined) {
    // The span regex expects the forge word at the start (or after a
    // separator). A subshell segment like `(gh pr merge 17)` starts with
    // `(` — strip a leading paren so the regex can locate the verb.
    const probe = seg.startsWith("(") ? seg.slice(1) : seg;
    const m = mergeVerbSpanRegex().exec(probe);
    if (m) {
      const offset = seg.startsWith("(") ? 1 : 0;
      return seg.slice(offset + m.index + m[0].length);
    }
    // #955 adversarial round 4 (finding 1): `matchMergeVerb` matched via a
    // shell-eval invocation (the glued-paren path — `(sh -c …` — the
    // span regex cannot locate the verb in this form because the forge
    // word is not present in the segment; the verb lives in the UNWRAPPED
    // body). Unwrap the segment and return the argument tail parsed from
    // the inner text, the same way the LATER-segment path does.
    const inner = mergeVerbUnwrapOne(seg);
    if (inner !== undefined) return matchMergeVerbTail(inner);
    // No readable tail (the inner text is malformed) — the fail-closed
    // no-number signal.
    return "";
  }
  // #955 round-4 per-segment unwrap: the whole-command shell-eval unwrap
  // (mergeVerbUnwrapOne in matchMergeVerbTail) only fires when the
  // shell-eval word starts the WHOLE command. Unwrap PER SEGMENT here, at
  // the same depth budget: the unwrapped inner text is re-entranted through
  // matchMergeVerbTail (which re-derives the inner's segments and recurses
  // through innerBodies), so nested layers are still budgeted by the
  // 3-iteration walk and exhaustion fails closed the same way.
  const inner = mergeUnwrappedLayerText(seg);
  if (inner === undefined) return undefined;
  if (inner !== null) return inner;
  // The unwrapped layer is malformed (an unterminated quote in the inner
  // text) — the same fail-closed no-number signal as the top level.
  return "";
}

/** True when the raw command text contains a merge verb (scan-not-anchor). */
function hasMergeVerbInRaw(command: string): boolean {
  return /(?:^|\s)(?:pr|mr)\s+merge\b/.test(command);
}

/**
 * The per-segment shell-eval unwrap (the LATER-segment path in
 * `segmentMergeTail`): unwrap one layer via `mergeVerbUnwrapOne` and
 * re-enter the shared walk on the inner text. The inner text is the
 * authoritative source for the tail: the raw segment's span regex cannot
 * see the verb inside a quoted `bash -c` body.
 *
 * Returns the argument tail (possibly the empty string — the no-number
 * fallback) when the inner text carries the merge verb, `undefined` when
 * the segment is not a shell-eval invocation at all, or `null` when the
 * segment IS a shell-eval invocation but its inner text does not terminate
 * (an unterminated quote — the body is not a valid command): the caller
 * applies the fail-closed no-number signal when the segment carries a
 * merge verb (#955 adversarial round 4, finding 1 — the whole-command
 * path's malformed-layer check had no per-segment counterpart).
 */
function mergeUnwrappedLayerText(seg: string): string | null | undefined {
  const inner = mergeVerbUnwrapOne(seg);
  if (inner === undefined) return undefined;
  if (rawTokens(inner).terminated === false) return null;
  return matchMergeVerbTail(inner);
}

/**
 * The repo flag placed BEFORE the merge verb (`gh -R o/r pr merge 17`),
 * including the pre-verb portion of a shell-eval body: `bash -c "gh -R
 * o/r pr merge 17"` merges exactly the same PR, and the flag sits in the
 * INNER text (the raw outer segment has no unquoted `-R` token at all).
 * #955: the flag was scanned only over the raw command's segments, so the
 * unwrapped tail carried the repo for the NUMBER but not for the repo —
 * the guard verified the PR in the CWD's repo instead of `o/r` (a
 * wrong-target ledger check). The walk now scans the raw segments AND,
 * for every segment carrying a merge, the segment's unwrapped inner text
 * (the same `mergeVerbUnwrapOne` the tail path uses, per segment, so the
 * repo always comes from the SAME tail that yields the number). The
 * value is read exactly like the post-verb path (quoted value → inner
 * text, trailing unbalanced `)` stripped), and a value read from an
 * inner body is validated at the `mergeVerbRepo` boundary like the tail
 * value (an unsafe inner value is refused there, never interpolated).
 *
 * The token walk is quote-aware (a quoted `"-R"` is not a flag); only
 * unquoted flag tokens count. Runs segment-by-segment (scan-not-anchor —
 * the flag can sit in any merge segment).
 */
function repoFlagBeforeVerb(command: string): string | undefined {
  // The pre-verb flag can only sit in a segment that is itself a merge
  // invocation — a raw segment, or the segment's unwrapped inner text
  // (a shell-eval body that matchMergeVerb cannot see through). The inner
  // walk mirrors the tail path's 3-layer budget exactly: each unwrapped
  // layer's segments are the same `shellSegments` the tail path uses, and
  // each inner layer is re-entered with one less budget, so the repo
  // always comes from the SAME tail that yields the number (including
  // nested bodies past a single unwrap — and exhaustion fails closed the
  // same way the tail path does).
  const walk = (text: string, depth: number): string | undefined => {
    for (const seg of shellSegments(text)) {
      // The raw segment is scanned only when it is itself a merge
      // invocation — a `gh -R o/r pr merge 17` segment, or a wrapper head
      // (`timeout 30 gh -R o/r pr merge 17`) that matchMergeVerb strips.
      // (Scanning every raw segment would pick up a repo flag from an
      // UNRELATED segment in a multi-segment command.)
      if (matchMergeVerb(seg) !== undefined) {
        const direct = repoFlagInTokens(seg);
        if (direct !== undefined) return direct;
      }
      // The segment's shell-eval body: the flag can sit in the inner text
      // (a body that matchMergeVerb cannot see through) at ANY depth — the
      // inner is re-entered through shellSegments with the shared 3-layer
      // budget, exactly the way the tail path (matchMergeVerbTail) walks
      // the layers, so the repo comes from the SAME tail that yields the
      // number. A non-merge segment (`cd x`) is skipped: its `bash -c` body
      // (if any) belongs to the merge's own layer walk, not to an unrelated
      // segment's.
      if (depth <= 0) continue; // budget exhausted — the tail path fails closed here too
      const inner = mergeVerbUnwrapOne(seg);
      if (inner === undefined) continue;
      const found = walk(inner, depth - 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(command, 3);
}

/**
 * Read the `-R`/`--repo`/`--project` flag (with its value) from one
 * segment's raw tokens, or `undefined` when the segment carries no repo
 * flag. Quoted values are unquoted the way the post-verb path reads them
 * (the shell strips the quotes), and a trailing unbalanced `)` glued to
 * the value is stripped (the same coping `parseArgsAfterVerb` applies
 * before matching its tokens, where `17)` is the number 17 in
 * `(gh pr merge 17)`).
 */
function repoFlagInTokens(seg: string): string | undefined {
  const tokens = rawTokens(seg);
  if (tokens.terminated === false) return undefined;
  for (let i = 0; i < tokens.list.length; i++) {
    const t = tokens.list[i] ?? "";
    if (t === "-R" || t === "--repo" || t === "--project") {
      const v = tokens.list[i + 1];
      if (v === undefined || v.length === 0) continue;
      // #955 adversarial round 4: unquote via `unquoteArg` — a double-quoted
      // value whose escaped quote closes early (a `\"` inside the value)
      // leaves a literal `"` in the unquoted form, which the `isValidRepoValue`
      // boundary check refuses (unsafe, never interpolated). A naive
      // `v.slice(1, -1)` would keep that escaped quote inside the value and
      const q = v[0];
      const val = q === "'" || q === '"' ? v.slice(1, -1) : v;
      return stripGluedParen(val);
    }
  }
  return undefined;
}

/**
 * Strip a trailing unbalanced `)` from a raw repo-value token — the
 * subshell's closing paren glued to the value by `rawTokens` (the same
 * coping `parseArgsAfterVerb` applies before matching its tokens, where
 * `17)` is the number 17 in `(gh pr merge 17)`). Balanced parens inside
 * a repo value are not a repo shape and stay as-is (they fail the
 * `isValidRepoValue` boundary check upstream — refused, never interpolated).
 */
/**
 * Strip a trailing unbalanced `)` from a raw token — the subshell's closing
 * paren glued to the token by `rawTokens` (the same coping
 * `parseArgsAfterVerb` applies before matching its tokens, where `17)` is
 * the number 17 in `(gh pr merge 17)`). Balanced parens inside a value are
 * not a repo shape and stay as-is (they fail the `isValidRepoValue` boundary
 * check upstream — refused, never interpolated).
 */
function stripGluedParen(value: string): string {
  if (value.endsWith(")") && value.length > 1) return value.slice(0, -1);
  return value;
}

// ---------------------------------------------------------------------------
// verb-argument parsing

/**
 * The PR/MR number and forge repo carried by the post-verb arguments.
 *
 * NOTE: an UNTERMINATED token list (a quote never closes) returns
 * `{ number: undefined, repo: undefined }` — indistinguishable from
 * numberless args. Callers that need fail-closed semantics must use
 * `mergeVerbArgs` (which carries the fail-closed empty-string tail signal
 * for that case), not this function directly.
 */
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
    const raw = tokens.list[i] ?? "";
    let t = raw;
    // #955 adversarial round 4 (finding 1, repo path): a quoted token whose
    // quote is unbalanced (a value that, in the UNWRAPPED body the tail came
    // from, is itself a quoted value — `bash -c 'glab --project \"o/r\" mr
    // merge 7'` tokenises the value as `\"o/r\"`, a double-quoted run whose
    // escape closes the quote early) is unquoted the way the shell would
    // unquote it at the top level (`unquoteArg`): the result is the value
    // the inner command actually carries, and an unbalanced escape is left
    // as a literal `"`, which the `isValidRepoValue` boundary refuses (the
    // naive `v.slice(1, -1)` would keep the escape inside the value and
    // validate it as a repo the guard then interpolated — a false-safe).
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
        if (flagName === "--repo" || flagName === "--project")
          repo = stripGluedParen(t.slice(eq + 1));
        continue;
      }
      if (t === "-R" || t === "--repo" || t === "--project") {
        const v = tokens.list[i + 1];
        if (v !== undefined && v.length > 0) {
          const q = v[0];
          repo = stripGluedParen(q === "'" || q === '"' ? v.slice(1, -1) : v);
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

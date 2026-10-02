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
  MAX_CONSTRUCT_DEPTH,
  isValidRepoValue,
  mergeVerbSpanRegex,
  parseArgsAfterVerb,
  rawTokens,
  shellSegments,
  stripGluedParen,
  unquoteArg,
} from "./merge-tokens.ts";
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
  // #955 (perf): the substring pre-filter lives in mergesPr (bash-merges-pr.ts) —
  // same rationale, shared at the matcher entry. Eval-of-variable is out of
  // scope (the guard only sees the raw command text, not what a variable
  // expands to).
  if (!command.includes("merge")) return undefined;
  return matchMergeVerbTail(command);
}

/**
 * The forge repo the matched merge verb names: the value of `-R`/`--repo`,
 * or the owner/repo inside a PR/MR URL argument. `undefined` when the
 * command does not merge or names no repo. An INVALID repo value (one that
 * could be interpolated into a shell exec string and execute arbitrary
 * commands) is rejected at this boundary — the guard refuses with
 * "unsafe repo value" and never interpolates it (#955 lens fix 1, HIGH).
 * Both the `--repo VALUE` and `--repo=VALUE` forms are validated (the eq
 * form parses to the same unquoted value, so both reach this check —
 * #955 round 14).
 */
export function mergeVerbRepo(
  command: string,
): { kind: "repo"; repo: string } | { kind: "unsafe"; raw: string } | undefined {
  // #955 (perf): same substring pre-filter as `mergeVerbArgs` (shared
  // rationale in mergesPr, bash-merges-pr.ts).
  if (!command.includes("merge")) return undefined;
  const args = mergeVerbArgs(command);
  if (args === undefined) return undefined;
  const tailRepo = parseArgsAfterVerb(args).repo;
  if (tailRepo !== undefined) {
    // A repo value was read (possibly via `--repo=`/`--project=` — the
    // eq form lands in the same field as the space form). Validate it:
    // an invalid value fails closed as unsafe (the guard refuses with
    // "unsafe repo value" and never interpolates it). A VALID value is
    // the repo. When no repo flag is present, fall through to the
    // pre-verb flag / URL repo (below).
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
 * The inner-body recursion is bounded by `MAX_CONSTRUCT_DEPTH`
 * (merge-tokens.ts): past the ceiling the walk stops descending and
 * fails closed (the null signal below, gated on `hasMergeVerbInRaw` so a
 * non-merge command with deep constructs still reads as not-a-merge). The
 * bound is what keeps a 20000-level nested-substitution command from
 * overflowing the JS call stack (the old unbounded walk — every frame
 * carries a multi-KB closure — threw RangeError at ~11k frames on that
 * input); every body remains a strict substring of the text that produced
 * it, so the walk is O(n) and terminates for any depth under the ceiling.
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
  const tail = matchSegmentsTail(text, MAX_CONSTRUCT_DEPTH);
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
 * The recursion terminates and is bounded: every body is a strict
 * substring of the text that produced it (no exponential blowup), and
 * `depth` (the remaining budget, capped at `MAX_CONSTRUCT_DEPTH` by the
 * caller) is decremented per level — past the ceiling the walk stops
 * descending and fails closed (the null signal), so no input can overflow
 * the JS stack. The ceiling sits far above the deepest canary (a 1150-
 * level `$(…)` chain), so realistic and canary-shaped commands analyse
 * unchanged; only pathologically deep input hits the bound.
 */
function matchSegmentsTail(text: string, depth: number): string | null | undefined {
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
    if (depth <= 0) return null; // budget exhausted — fail closed (the caller gates on hasMergeVerbInRaw)
    for (const body of bodies) {
      const inner = matchSegmentsTail(body, depth - 1);
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
    // #955 lens round 6: the head walk (matchMergeVerb) now matches on
    // UNQUOTED tokens (the shell removes quotes around a whole word before
    // execution — `gh pr "merge" 17`, `"gh" pr merge 17`), while this span
    // regex runs over the raw text where the quotes are still there. Run
    // the regex over an unquoted probe (each token unquoted, spacing kept):
    // the quote-less text the shell actually executes, so the span's start
    // offset lands on the real verb and the tail extraction below is
    // unaffected (a whole-word quote adds no characters to the stream).
    // The probe is the UNQUOTED segment (the head walk matches on unquoted
    // tokens — the shell removes whole-word quotes before execution), with
    // a glued leading `(` removed so the span regex can anchor the forge
    // word (the old raw-text probe did the same slice).
    const probeSeg = seg.startsWith("(") ? seg.slice(1) : seg;
    const probeToks = rawTokens(probeSeg);
    const probe =
      probeToks.terminated && probeToks.list.length > 0
        ? probeToks.list.map(unquoteArg).join(" ")
        : undefined;
    if (probe === undefined) return "";
    const m = mergeVerbSpanRegex().exec(probe);
    if (m) {
      // The tail is the segment after the MATCHED SPAN: the span carries
      // the optional repo flag (`gh -R o/r pr merge 17` → the tail is
      // after `merge`, the repo flag out of the number parse). #955 lens
      // round 6: the probe is the UNQUOTED form (the head walk matches on
      // unquoted tokens — the shell removes whole-word quotes before
      // execution), so the span's end is a position in the unquoted text
      // and the tail is sliced from there (a whole-word quote adds no
      // tokens, so the unquoted tail is exactly what the number/repo
      // parser reads; for unquoted commands it is the old tail verbatim).
      // The tail is sliced from the same unquoted text the span was
      // located in (a whole-word quote adds no tokens, so the unquoted
      // tail is exactly what the number/repo parser reads; for unquoted
      // commands it is the old tail verbatim). A glued closing `)` stays
      // in the tail — the number/repo parser strips a trailing `)` from a
      // glued token (`17)` is the number 17 in `(gh pr merge 17)`).
      return probe.slice(m.index + m[0].length);
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
 * fallback) when the inner text carries the merge verb, or `undefined`
 * when the segment is not a shell-eval invocation at all.
 *
 * The `null` branch (an unterminated quote in the inner text) is
 * unreachable in practice: the top-level `hasMergeVerbInRaw` gate in
 * `matchMergeVerbTail` protects these shapes before the per-segment walk
 * reaches this function. The `null` return type is kept for the
 * structural contract (the caller's `=== null` check is the fail-closed
 * signal), but in practice the caller always sees `undefined` or a
 * string.
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

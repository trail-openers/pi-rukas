/**
 * merge-parse — the command-side half of the merge guard (#912, defect fix
 * #955): which raw command merges a PR/MR, and what target (number, repo)
 * the matched merge verb names.
 *
 * Two defects from the lievo incident (2026-10-01, PR #17) fixed here:
 *
 * 1. The verb door (`gh pr merge …` / `glab mr merge …`) matched a SPAN that
 *    stopped at the whitespace after `merge`, so the PR number was never
 *    inside the matched text — every numbered merge fell back to
 *    current-branch resolution (merge-target.ts `resolvePrNumber`) and
 *    failed closed on a checkout not on the PR branch.
 * 2. A merge wrapped in a subshell (`bash -c '… gh pr merge 17 …'`,
 *    `sh -c "…"`, `eval "…"`) was invisible: stripQuotedSegments DELETES the
 *    quoted -c body, so no merge verb remained to match — a genuine bypass.
 *
 * Design (per the #955 decisions):
 *
 * - Subshell/wrapper unwrapping happens on the RAW command, BEFORE
 *   quote-stripping, and recursively (depth 3): for `bash`/`sh`/`zsh`/
 *   `dash` with `-c` or `-lc`, and for `eval`, the quoted string argument
 *   becomes the new command and the whole matcher re-runs on it. The guard
 *   matches and extracts on the INNERMOST segment that contains the merge
 *   verb.
 * - The PR number / repo are parsed from the arguments AFTER the matched
 *   verb, with a quote-aware tokenizer that skips the values of flags that
 *   take an argument (`-s/--subject`, `-t/--title`, `-b/--body`,
 *   `-F/--body-file`, `--match-head-commit`, `-m/--message`,
 *   `-A/--author-email`, `-R/--repo`). The number is the first bare
 *   positional integer, a `#N`, or a `/pull/N` / `/merge_requests/N` URL.
 *   Digits before the verb never count (the `cd /data/3` canary).
 * - The REST doors (`gh api …/pulls/N/merge`, `glab api …/merge_requests/
 *   N/merge`) keep their existing span-based extraction — the endpoint path
 *   already carries the number.
 *
 * The matcher itself (`mergesPr`) lives in bash-merges-pr.ts and is
 * re-exported from bash-command-parser.ts — both import sites (the issue
 * creation guard, the merge guard) are untouched.
 */

/**
 * The arguments that follow the matched merge verb, verbatim (the raw tail
 * of the innermost segment that carried the verb). `undefined` when the
 * command does not merge; the empty string when a merge verb matched with
 * nothing after it (the no-number fallback). The REST doors carry their
 * number inside the matched span — that path stays in merge-guard.ts.
 */
export function mergeVerbArgs(command: string): string | undefined {
  let text = command;
  for (let depth = 0; depth < 3; depth++) {
    const inner = unwrapShellEval(text);
    if (inner !== undefined) {
      text = inner;
      continue;
    }
    return matchVerbArgs(text);
  }
  // Unwrap budget exhausted: fall through to the quote-stripped match, the
  // way the legacy matcher did, so a merge still matches (extraction then
  // falls back to current-branch resolution rather than missing the door).
  return matchVerbArgs(stripForMatch(command));
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
  let text = command;
  for (let depth = 0; depth < 3; depth++) {
    const inner = unwrapShellEval(text);
    if (inner !== undefined) {
      text = inner;
      continue;
    }
    return repoFlagBeforeVerb(text);
  }
  return repoFlagBeforeVerb(stripForMatch(command));
}

/**
 * Parse the PR/MR number from the arguments following the merge verb.
 *
 * The number is the first bare positional integer, a `#N`, or a `/pull/N` /
 * `/merge_requests/N` URL. Flag values that take an argument are skipped, so
 * `--subject "x 12"` never reads as PR 12; quoted runs are skipped the way
 * the shell would (a quoted string is a literal argument, not the number).
 */
export function extractMergeNumber(args: string): number | undefined {
  return parseArgsAfterVerb(args).number;
}

/** The repo (see `mergeVerbRepo`) parsed from post-verb arguments alone. */
export function extractMergeRepo(args: string): string | undefined {
  return parseArgsAfterVerb(args).repo;
}

// ---------------------------------------------------------------------------
// internals

// The merge-verb regex shared by every entry point. It is the exact verb
// branch of the legacy `mergesPr` matcher (scan-not-anchor, optional `oo`
// wrapper).
function mergeVerbRegex(): RegExp {
  return /(?:^|[;&|]|\s)(?:oo\s+)?(?:gh|glab)\s+(?:pr\s+merge|mr\s+merge)(?:\s|$)/;
}

/**
 * Match the verb in the (already unwrapped) segment. Returns the argument
 * tail when the verb matches (possibly empty), or undefined.
 */
function matchVerbArgs(text: string): string | undefined {
  const m = mergeVerbRegex().exec(text);
  if (!m) return undefined;
  const span = m[0].trim();
  const idx = text.lastIndexOf(span);
  // The tail is consumed verbatim — the post-verb parser is quote-aware,
  // so no quote-stripping happens here (a quoted `"x 12"` stays a quoted
  // argument the parser skips, exactly as the shell treats it).
  return text.slice(idx + span.length);
}

// A global `-R`/`--repo` flag placed BEFORE the merge verb (`gh -R o/r pr
// merge 17`). The token walk is quote-aware (a quoted `"-R"` is not a
// flag); only unquoted flag tokens count.
function repoFlagBeforeVerb(text: string): string | undefined {
  const m = mergeVerbRegex().exec(text);
  if (!m) return undefined;
  const span = m[0].trim();
  const idx = text.lastIndexOf(span);
  const head = text.slice(0, idx + span.length);
  const tokens = rawTokens(head);
  if (tokens.terminated === false) return undefined;
  for (let i = 0; i < tokens.list.length; i++) {
    const t = tokens.list[i] ?? "";
    if (t === "-R" || t === "--repo") {
      const v = tokens.list[i + 1];
      if (v === undefined || v.length === 0) return undefined;
      const q = v[0];
      return q === "'" || q === '"' ? v.slice(1, -1) : v;
    }
  }
  return undefined;
}

/**
 * Unwrap ONE level of shell eval: `bash`/`sh`/`zsh`/`dash` with `-c` or
 * `-lc`, and `eval`, become their quoted string argument.
 *
 * The token walk is over the RAW command (quote-aware, offsets preserved —
 * unlike stripQuotedSegments, which drops quoted interiors and cannot be
 * used to locate argument text). The invocation is identified among
 * UNQUOTED tokens; the argument is the first quoted token that follows it.
 * This is what makes `bash -c 'echo "pr merge"'` safe: the recursive match
 * then runs on `echo "pr merge"`, where the quoted verb is inert the same
 * way `echo "gh pr merge 12"` is inert at the top level.
 *
 * Returns the inner string, or undefined when the command does not invoke
 * one of these shells (an `env VAR=…` prefix is consumed transparently —
 * the walk lands on the real command word, so `env FOO=1 bash -c '…'`
 * unwraps to `…`).
 */
function unwrapShellEval(command: string): string | undefined {
  const tokens = rawTokens(command);
  if (tokens.terminated === false) return undefined;
  let i = 0;
  const n = tokens.list.length;
  while (i < n) {
    const t = tokens.list[i] ?? "";
    if (t === ";" || t === "&&" || t === "|" || t === "||") {
      i++;
      continue; // a new segment starts — the invocation must head a segment
    }
    if (t === "oo") {
      i++;
      continue; // the oo wrapper: the real command word follows
    }
    if (t === "env") {
      i++;
      while (i < n && /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(tokens.list[i] ?? "")) i++;
      if (i >= n) return undefined;
      continue; // re-loop: the command word follows the env assignments
    }
    const q = t[0];
    if (q === "'" || q === '"') return undefined; // a quoted token is not a command word
    if (t === "bash" || t === "sh" || t === "zsh" || t === "dash") {
      // Consume flag tokens up to (and including) the -c/-lc flag; the
      // quoted string argument is the first quoted token after it.
      let j = i + 1;
      let sawC = false;
      while (j < n) {
        const f = tokens.list[j] ?? "";
        if (f === "-c" || f === "-lc") {
          sawC = true;
          j++;
          break;
        }
        if (f.startsWith("-")) {
          j++;
          continue;
        }
        break;
      }
      if (!sawC) return undefined;
      const arg = tokens.list[j];
      if (arg === undefined) return undefined;
      const aq = arg[0];
      if (aq !== "'" && aq !== '"') return undefined; // unquoted -c body is not the shape the guard unwraps
      const inner = arg.slice(1, -1);
      return inner.length > 0 ? inner : undefined;
    }
    if (t === "eval") {
      const arg = tokens.list[i + 1];
      if (arg === undefined) return undefined;
      const aq = arg[0];
      if (aq !== "'" && aq !== '"') return undefined;
      const inner = arg.slice(1, -1);
      return inner.length > 0 ? inner : undefined;
    }
    return undefined; // any other first token: this is not a shell-eval command
  }
  return undefined;
}

/**
 * The raw-command token walk used by `unwrapShellEval` and
 * `parseArgsAfterVerb`: quoted runs are kept as a single token WITH their
 * outer quotes (so the reader can strip them); separators are their own
 * tokens. `terminated` is false when a quote never closes — the caller
 * treats that as "unparseable" (fail-closed upstream).
 */
function rawTokens(raw: string): { list: string[]; terminated: boolean } {
  const list: string[] = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const ch = raw[i] ?? "";
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "&" && (raw[i + 1] ?? "") === "&") {
      list.push("&&");
      i += 2;
      continue;
    }
    if (ch === "|" && (raw[i + 1] ?? "") === "|") {
      list.push("||");
      i += 2;
      continue;
    }
    if (ch === ";" || ch === "|") {
      list.push(ch);
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const q = ch;
      i++;
      let closed = false;
      let buf = "";
      while (i < n) {
        const c2 = raw[i] ?? "";
        if (q === '"' && c2 === "\\" && i + 1 < n) {
          buf += c2 + (raw[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (c2 === q) {
          closed = true;
          i++;
          break;
        }
        buf += c2;
        i++;
      }
      if (!closed) return { list, terminated: false };
      list.push(q + buf + q);
      continue;
    }
    const start = i;
    while (i < n && !/\s/.test(raw[i] ?? "") && raw[i] !== "'" && raw[i] !== '"') i++;
    list.push(raw.slice(start, i));
  }
  return { list, terminated: true };
}

/**
 * The quote-stripping used only for the final, quote-stripped match after
 * the unwrap budget is exhausted — the same semantics as
 * stripQuotedSegments (reimplemented here rather than imported from
 * bash-command-parser.ts, which this module is imported BY through the
 * mergesPr re-export path — importing it back would be a cycle):
 *
 * Single-quoted runs are dropped; double-quoted runs are dropped except
 * `$` and backtick (they execute inside double quotes); an unterminated
 * quote returns the raw command (fail-closed).
 */
function stripForMatch(command: string): string {
  let result = "";
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i] ?? "";
    if (ch === "'") {
      i++;
      let found = false;
      while (i < n) {
        if (command[i] === "'") {
          found = true;
          i++;
          break;
        }
        i++;
      }
      if (!found) return command;
    } else if (ch === '"') {
      i++;
      let found = false;
      while (i < n) {
        if (command[i] === "\\" && i + 1 < n) {
          i += 2;
          continue;
        }
        if (command[i] === '"') {
          found = true;
          i++;
          break;
        }
        if (command[i] === "$" || command[i] === "`") result += command[i] ?? "";
        i++;
      }
      if (!found) return command;
    } else {
      result += ch;
      i++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// verb-argument parsing

/** The PR/MR number and forge repo carried by the post-verb arguments. */
function parseArgsAfterVerb(args: string): {
  number: number | undefined;
  repo: string | undefined;
} {
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
  ]);
  const tokens = rawTokens(args);
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
        if (flagName === "--repo") repo = t.slice(eq + 1);
        continue;
      }
      if (t === "-R" || t === "--repo") {
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
    // Positional argument: a bare integer, a #N, or a PR/MR URL.
    if (/^\d+$/.test(t)) return { number: Number.parseInt(t, 10), repo };
    const hash = /^#(\d+)$/.exec(t);
    if (hash?.[1]) return { number: Number.parseInt(hash[1], 10), repo };
    const url = /\/(?:pull|merge_requests)\/(\d+)/.exec(t);
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

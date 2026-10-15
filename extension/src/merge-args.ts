/**
 * merge-args — the post-verb argument parser of the merge guard (#955,
 * #1317): the PR/MR number and forge repo named by the arguments that follow
 * a merge verb. Split out of merge-tokens.ts (500-line cap); the token walk
 * stays there.
 *
 * `unreadable` is set when the arguments carry a positional that is not a
 * plain number, `#N`, a PR/MR URL or an owner/repo (`$PR`, `"$N"`, `x17`), or
 * a second number, and when a bare integer is present but no number was read
 * (a value flag swallowed it). The guard cannot tell which PR such a command
 * merges, so it refuses. Only a head with NO positional argument may resolve
 * its PR from the current branch (#1317 item B). Redirections are not
 * arguments: `>f`, `2>&1`, `&>f` and their target are skipped, and `N>` (fd
 * prefix) is one operator token (see rawTokens).
 */

import { gluedRepoValue, isSeparatorToken, rawTokens, stripGluedParen } from "./merge-tokens.ts";

export interface PostVerbArgs {
  number: number | undefined;
  repo: string | undefined;
  /** A positional the parser cannot read as the PR, or an unreadable token list. */
  unreadable: boolean;
}

/**
 * Value-taking flags of `gh pr merge`, from gh's own flag table (#1317). The
 * merge-method flags are BARE for gh: `-m`/`--merge`, `-s`/`--squash`,
 * `-r`/`--rebase`, `-d`/`--delete-branch`, `--auto`, `--admin`. So
 * `gh pr merge -m 17` merges PR 17.
 */
const GH_TAKES_VALUE = new Set([
  "-t",
  "--subject",
  "-b",
  "--body",
  "-F",
  "--body-file",
  "-A",
  "--author-email",
  "--match-head-commit",
]);

/**
 * Value-taking flags of `glab mr merge`. `-m` is the MR's merge message here
 * (bare for gh), so the two forges must not share one table.
 */
const GLAB_TAKES_VALUE = new Set(["-m", "--message", "--squash-message", "--sha"]);

/**
 * The arguments after a merge verb, parsed for the PR/MR number and the repo.
 * `forge` selects the flag table; when it is unknown, a flag the two forges
 * read differently (`-m`) is treated as unreadable rather than guessed.
 */
export function parseArgsAfterVerb(args: string, forge?: "gh" | "glab"): PostVerbArgs {
  // A trailing `&` (job control, `nohup gh pr merge 17 &`) is part of the
  // invocation, not a separator that ends the argument list.
  const cleaned = args.replace(/\s+&\s*$/, " ").replace(/\s+&&\s*$/, " ");
  const tokens = rawTokens(cleaned);
  if (tokens.terminated === false) return { number: undefined, repo: undefined, unreadable: true };
  const list = tokens.list;
  const valueFlags = forge === "glab" ? GLAB_TAKES_VALUE : GH_TAKES_VALUE;
  let number: number | undefined;
  let repo: string | undefined;
  let unreadable = false;
  for (let i = 0; i < list.length; i++) {
    let t = list[i] ?? "";
    // A trailing `)` is the subshell close glued by rawTokens (`17)` is 17 in
    // `(gh pr merge 17)`).
    if (t.endsWith(")") && t.length > 1) t = t.slice(0, -1);
    if (t === "") continue;
    if (isSeparatorToken(t)) break;
    // A redirection is not an argument. Its target (the next word) is not one
    // either, unless the target is inside the operator (`2>&1`, `>&-`).
    if (/^(?:\d*[<>]|&>)/.test(t)) {
      if (!/&(?:\d+|-)$/.test(t)) i++;
      continue;
    }
    if (t.startsWith("-")) {
      const glued = gluedRepoValue(t);
      if (glued !== undefined) {
        // `--repo="o/r"` / `--repo=` (value in the next token, #962). The value
        // is kept verbatim (quotes stripped) so an invalid value reaches the
        // `isValidRepoValue` boundary and is refused, never interpolated.
        let val = glued;
        if (val === "") {
          val = list[i + 1] ?? "";
          i++;
        }
        const q = val[0];
        if (number === undefined)
          repo = stripGluedParen(q === "'" || q === '"' ? val.slice(1, -1) : val);
        continue;
      }
      if (t.indexOf("=") > 0) continue;
      if (t === "-R" || t === "--repo" || t === "--project") {
        const v = list[i + 1];
        if (v !== undefined && v.length > 0) {
          const q = v[0];
          if (number === undefined)
            repo = stripGluedParen(q === "'" || q === '"' ? v.slice(1, -1) : v);
          i++;
        }
        continue;
      }
      // With no forge known, a flag the two tables disagree on cannot be
      // parsed safely: refuse rather than guess which token it consumes.
      if (forge === undefined && GH_TAKES_VALUE.has(t) !== GLAB_TAKES_VALUE.has(t)) {
        unreadable = true;
        continue;
      }
      if (valueFlags.has(t)) i++;
      continue;
    }
    // Positional: a bare integer, a quoted integer (the shell strips the
    // quotes), `#N`, or a PR/MR URL (which may name the repo).
    // The first number is the PR; a later number is ignored (a number the
    // shell joined from quoted pieces is compared by the canonical reading).
    // The repo is read from the arguments BEFORE the number only: the tail is
    // the unquoted probe (merge-parse.ts), so a repo value after the number
    // is not read faithfully here — the raw reading owns it.
    const num = positionalNumber(t);
    if (num !== undefined) {
      if (number === undefined) {
        number = num.number;
        if (num.repo !== undefined) repo = num.repo;
      }
      continue;
    }
    // A bare `owner/repo` positional names the repo the way -R does.
    if (number === undefined && repo === undefined && /^[-\w]+\/[-\w.]+$/.test(t)) {
      repo = t;
      continue;
    }
    unreadable = true;
  }
  // A bare integer that is not the PR (a value flag swallowed it: `glab mr
  // merge -m 17`) must never resolve the PR from the current branch.
  if (number === undefined && list.some((t) => /^["']?\d+["']?\)?$/.test(t))) unreadable = true;
  return { number, repo, unreadable };
}

/** A positional read as a PR/MR number (and the repo a URL names), or undefined. */
function positionalNumber(t: string): { number: number; repo?: string } | undefined {
  const bare = /^(\d+)$/.exec(t) ?? /^"(\d+)"$/.exec(t) ?? /^'(\d+)'$/.exec(t);
  if (bare?.[1]) return { number: Number.parseInt(bare[1], 10) };
  const hash = /^#(\d+)$/.exec(t);
  if (hash?.[1]) return { number: Number.parseInt(hash[1], 10) };
  const url = /\/(?:pull|pulls|merge_requests)\/(\d+)/.exec(t);
  if (url?.[1]) {
    const ownerRepo = /(?:^|\/)(?:github\.com|gitlab\.com)\/([^/?#]+)\/([^/?#]+)/.exec(t);
    const repo = ownerRepo?.[1] && ownerRepo?.[2] ? `${ownerRepo[1]}/${ownerRepo[2]}` : undefined;
    return { number: Number.parseInt(url[1], 10), repo };
  }
  return undefined;
}

/**
 * merge-landing-form — #2125 Rescope 2 (S1): the pre-check the merge guard
 * asks a non-ops child, before any hold code is computed. S3: these roles
 * never land a PR and the guard catches mistakes, not adversaries — children
 * run as the operator's own user — so a raw-text landing scan is proportionate
 * for them; `ops` and the parent (role unset) keep the classifier unchanged.
 *
 * Token walks only, never a regex with overlapping alternations under `*`:
 * that form backtracked catastrophically. The tool word is REQUIRED in front
 * of `pr`/`mr`; dropping it freed 48 more field rows but released 92 that only
 * MENTION the pair, which R3's zero-release bar refuses.
 *
 * A shell de-quotes before it reads a token, so `m'er'ge`, `m\erge` and
 * `/usr/bin/gh` reach `exec` as `merge`, `merge` and `gh` while a walk over
 * raw text reads none of them — every one of those is a landing an earlier
 * build released. Normalising the WHOLE LINE instead is the opposite failure:
 * it makes the quoted contents of `vipune add 'gh pr <kw> 12 is the accepted
 * form'` look like an executed landing, and the R3 replay of that build
 * released 0 of 1643 non-ops rows. The distinction the scan has to make is
 * exactly the one the shell makes, so it is made with one tokeniser:
 *
 *   - `words` is what the shell hands `exec`, quote by quote, backslash by
 *     backslash, with the basename taken off a command word. A tool word, a
 *     noun, a verb or a runner is matched against THAT, which is what closes
 *     the quote-split, the escaped and the path-qualified bypass at once.
 *   - `data` is the text of every QUOTED span, which the shell never executes
 *     as a word. Prose is only ever data: `grep -rn "gh pr <kw>" .` and the
 *     `vipune` note stay released, and — because a quoted word is not a word
 *     — `'gh' pr merge 12` is not a tool word either unless the quote sits
 *     inside one word (`g"h"`), which `exec` really does receive as `gh`.
 *   - A quoted span that a RUNNER will execute is a landing (`bash -c '…'`),
 *     so `data` is scanned by `verbIsData` and nothing else.
 */
const KW = "merge"; // the landing verb; `accept` is glab's word for it
const REST = /(pulls|merge_requests)\/\d+\/merge\b/i;
// A substitution can carry a whole landing the scan cannot see.
const SUBST = /\$[({]|`/;
// A bare `$VAR` counts only beside the verb: `$` is ordinary in jq programs.
const BARE_VAR = /\$[A-Za-z_]\w*/;
// R2's runners EXECUTE their argument, so a landing hides in the quoted text
// the shell will run. That is the INLINE forms — `-e`/`-c` and the bare `sh`/
// `bash` script position — where the argument IS the program. `bun <file>`
// executes a file's CONTENTS, not its name, so a verb in the filename is not
// an executed landing and the row stays released. A whole COMMAND-WORD match
// (never a path character, so `test-merge-guard.ts` is not a runner) and only
// beside the verb, keeping `bun run build` released.
const RUNNER =
  /(?:^|[\s;|&(`'])(?:sh|bash|zsh|dash|ksh|python3?|node|bun|deno|ruby|perl|eval|xargs)(?:[\s;|&)'"/]|$)/;
const RUNNER_WORDS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "python",
  "python3",
  "node",
  "bun",
  "deno",
  "ruby",
  "perl",
  "eval",
  "xargs",
]);
const INLINE = /(?:^|\s)(?:-(?:e|c)|--command|--eval)(?:\s|$)/;
const HAS_KW = new RegExp(`(?:^|[^\\w])${KW}(?:[^\\w]|$)`, "i");
// The verb inside a quoted span: an argument the runner will execute.
const QUOTED_KW = new RegExp(`['"][^'"]*(?:^|[^\\w])${KW}(?:[^\\w]|$)`, "i");
// A GraphQL landing names its mutation, not a shell verb, so it rides neither
// the token walk nor the REST path: `gh api graphql -f query='mutation{…}'`
// is invisible to both. Matched on the line with its quotes and backslashes
// removed, where the camelCase and snake_case spellings of the two forges'
// mutations — `mergePullRequest`, `merge_merge_request` — collapse to one test.
const GRAPHQL = /merge[-_]?pull[-_]?request|merge[-_]?merge[-_]?request/i;

/** One word as the shell hands it to `exec`: basename, lowercase. */
const basename = (w: string) => (w.split("/").pop() ?? "").toLowerCase();

/** Quote and backslash characters — the shell removes both before a word is
 * read, so the REST path and the mutation name are compared without them. */
function stripShellSyntax(text: string): string {
  return text.replace(/['"]/g, "").replace(/\\/g, "");
}

/** One token of a quoted span: quotes out, backslash escapes honoured. */
function unquote(token: string, quoted: boolean): string {
  if (!quoted) return token;
  let out = "";
  let esc = false;
  for (const c of token) {
    if (esc) {
      out += c;
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c !== "'" && c !== '"' && c !== "`") out += c;
  }
  return out;
}

/**
 * Split a line the way the shell does, keeping the two kinds of text apart.
 * `words` is the command words the shell would exec (a word that carried ANY
 * quote loses its path prefix exactly as `exec` sees it); `data` is the
 * contents of the quoted spans, which the shell never execs. Whitespace inside
 * a quote is one word here and many words in a naive `split(/\s+/)` — that
 * difference is the whole of the prose/landing distinction.
 */
function scan(line: string): { words: string[]; data: string[] } {
  const words: string[] = [];
  const data: string[] = [];
  let cur = "";
  let had = false;
  const flush = () => {
    if (!had) return;
    words.push(cur);
    cur = "";
    had = false;
  };
  let i = 0;
  while (i < line.length) {
    const c = line[i] ?? "";
    if (c === " " || c === "\t" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      flush();
      i++;
      continue;
    }
    if (c === "\\") {
      cur += line[i + 1] ?? "";
      had = true;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
      const inner = line.slice(i + 1, j);
      data.push(inner);
      cur += unquote(inner, true);
      had = true;
      i = j + 1;
      continue;
    }
    cur += c;
    had = true;
    i++;
  }
  flush();
  return { words, data };
}

/**
 * Is the verb present as DATA the shell will execute — inside a quoted
 * argument, or after an inline-script flag? A verb that appears only inside a
 * bare word (a test filename like `test-guard-role-scoped-merge-2125.ts`) is
 * not executed text: `bun <file>` runs the file's CONTENTS, so the name is not
 * a landing. That is what separates the field's most-held shape from R2's
 * `bash -c 'gh pr <kw> 1'`, which stays held.
 */
function verbIsData(line: string, data: string[]): boolean {
  if (INLINE.test(line) && HAS_KW.test(line)) return true;
  if (QUOTED_KW.test(line)) return true;
  return data.some((d) => HAS_KW.test(d));
}

/**
 * S2's landing forms on one line; `api … pulls/N/<kw>` is the REST path and
 * the mutation name is the GraphQL one — both read on the line with its quotes
 * and backslashes removed, so either split by quotes reads as the landing.
 */
function landing(line: string): boolean {
  if (SUBST.test(line)) return true;
  const plain = stripShellSyntax(line);
  if (REST.test(plain) || GRAPHQL.test(plain)) return true;
  const { words, data } = scan(line);
  const w = words.map(basename);
  if ((RUNNER.test(line) || w.some((x) => RUNNER_WORDS.has(x))) && verbIsData(line, data))
    return true;
  // Verb and noun are EXECUTED words only: a landing inside a quoted span is
  // caught above as the runner's data, and never here as a command word.
  const at = (word: string, from: number) => w.findIndex((x, i) => i >= from && x === word);
  if (at(KW, 0) >= 0 && BARE_VAR.test(line)) return true;
  for (let i = 0; i < w.length; i++) {
    const word = w[i] ?? "";
    if (word === "gh" || word === "glab") {
      const kw = at(word === "gh" ? "pr" : "mr", i + 1);
      if (kw >= 0 && (at(KW, kw + 1) >= 0 || (word === "glab" && at("accept", kw + 1) >= 0)))
        return true;
    } else if (word === "git") {
      // `git <kw>`: only git's global options (and a -C/-c value) between.
      for (let j = i + 1; j < w.length; j++) {
        const tj = w[j] ?? "";
        if (tj === KW) return true;
        if (!tj.startsWith("-")) break;
        if (tj === "-c" || tj === "-C") j++;
      }
    } else if (word === "hub" && at(KW, i + 1) >= 0) return true;
  }
  return false;
}

/**
 * `release` for a child that cannot land a PR; `hold` falls through to the
 * classifier. The role is a PARAMETER, read by the caller: the guard's source
 * states the scoping at its own call site, and `test-merge-guard.ts` pins
 * `PI_ENSEMBLE_ROLE` to exactly that one occurrence rather than pinning the
 * guard role-agnostic — the guard is role-SCOPED for non-landing text and
 * holds every landing form for every role, this predicate included.
 */
export function roleScopedMergeVerdict(
  role: string | undefined,
  command: string,
): "release" | "hold" {
  const r = role?.trim().toLowerCase() ?? "";
  if (r === "" || r === "ops") return "hold";
  // Anything not a plain string (`test-merge-guard-allowlist.ts` hands over a
  // non-string to drive the classifier-threw arm) is held: the pre-check may
  // only shorten a hold, so an unreadable value falls through to the reader,
  // which owns the fail-closed refusal.
  if (typeof command !== "string") return "hold";
  return command.split("\n").some(landing) ? "hold" : "release";
}

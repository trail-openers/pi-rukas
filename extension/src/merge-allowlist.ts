/**
 * merge-allowlist — which bash commands the merge guard (merge-guard.ts)
 * treats as a merge, and the one shape of merge it will check.
 *
 * #962. The guard used to parse arbitrary shell to find a merge wherever it
 * hid; every review round found a shape it read differently from bash. This
 * module replaces that with a strict allowlist, in two steps:
 *
 *   0. READ-ONLY GH. A command that lexes as ONE simple command under the
 *      strict lexer, whose words are `gh` followed by a genuine read or a
 *      creation (`pr view|list|checks|diff|status|create`, `issue view|list|create`,
 *      `release list|view`, `search *`, `label list`, `repo view`) is not a
 *      merge, whatever merge words its titles, bodies or searches carry.
 *      Comments, edits, reviews, workflow dispatches and run re-runs are NOT
 *      exempt: they fall through to step 1, so they are refused only when they
 *      carry a merge word (use `--body-file` for prose).

 *   1. TRIGGER (cheap, on the raw text, case-insensitive). A command is
 *      refused outright, without reading it, when:
 *        - it names a forge, HTTP client or interpreter (`gh`, `glab`, `hub`,
 *          `curl`, `wget`, `http(s)`, `python`, `node`, `bun`, `deno`, `ruby`,
 *          `perl`, `octokit`, `api.github.com`, `gitlab`) AND a merge word
 *          (`merge` as a whole word, or a GraphQL/forge merge name such as
 *          `mergeRequestAccept`, `mergePullRequest`, `automerge`); or it
 *          mentions a GraphQL `mutation` alongside any `merge` substring;
 *        - it says `pr merge` / `mr merge` / `mr accept` at all;
 *        - a merge word appears and a segment's command word (after `VAR=…`
 *          assignments) is an expansion or quoted/escaped (`"$GH" pr merge`,
 *          `$G api …/merge`, `g"h" pr merge`);
 *        - a forge `api`/`graphql` call or an HTTP client aimed at a forge
 *          reads its body from a file, stdin or a shell expansion
 *          (`body-indirect`: `-f query="$(cat q)"`, `-d @body`, `-T f`,
 *          `--post-file f`);
 *        - a forge name appears with an unquoted `{a,b}` or `{a..b}` pattern
 *          that bash would expand (`brace-expansion`: `gh pr m{erge,} 17`).
 *      The words are looked for in the raw text and in a widened view that
 *      undoes bash quoting (`g"h"`, `m"erge"`, `$'\x6d'erge`). No trigger →
 *      `none`: not a merge.
 *   2. A triggered command must be EXACTLY one simple command in the grammar
 *      below, or it is `refused` with a reason code saying what to change:
 *
 *        gh   [-R|--repo OWNER/REPO | --repo=OWNER/REPO] pr merge [N] [FLAGS]
 *        glab [-R|--repo GROUP/…/REPO]                   mr merge [N] [FLAGS]
 *
 *      Words are split on blanks; quotes are removed as bash removes them.
 *      Outside single quotes the text may not contain any shell
 *      metacharacter, expansion or control character (inside double quotes
 *      only `$`, backtick, `\` and `!` are dangerous), so every word bash
 *      would see is exactly the word read here.
 *
 * Threat model (docs/troubleshooting.md): an honest-but-forgetful agent, not
 * an adversary. A merge whose words never appear in the command text — one
 * assembled entirely from expansions (`gh pr m$X 17`), or run from a script
 * file (`bash x.sh`) — never triggers and is a documented residual.
 */

/** What the guard does with a bash command. */
export type MergeCommand =
  | { kind: "none" }
  | { kind: "refused"; reason?: string }
  | { kind: "merge"; forge: "github" | "gitlab"; prNumber?: number; repo?: string };

/** A repo value safe to pass to gh/glab: `owner/repo` (GitLab: `group/sub/repo`). */
export const REPO_VALUE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_.-]+)+$/;

/** Whether a repo value is safe to interpolate into a forge exec string. */
export function isValidRepoValue(value: string): boolean {
  return REPO_VALUE_PATTERN.test(value);
}

const FORGE_WORD =
  /(?:^|[^a-z0-9_])(?:gh|glab|hub|curl|wget|https?|python3?|node|bun|deno|ruby|perl)(?![a-z0-9_])|api\.github\.com|gitlab|octokit/i;
/**
 * `pr merge` / `mr merge` / `mr accept` (glab's alias) — a merge verb even
 * when the forge CLI runs under another name (`./g pr merge 17`).
 */
const VERB_PAIR = /(?:^|[^a-z0-9_])[pm]r\s+(?:merge|accept)(?![a-z0-9_])/i;
const MERGE_WORD =
  /(?:^|[^a-z0-9_])merge(?![a-z0-9_])|mergepullrequest|enablepullrequestautomerge|mergerequestaccept|acceptmergerequest|mergerequestmerge|mergemergerequest|automerge|mergebranch|mergequeue|enqueuepullrequest/i;
const FORGE_NAME = /(?:^|[^a-z0-9_])(?:gh|glab)(?![a-z0-9_])/i;
const API_WORD = /(?:^|[\s'"])(?:api|graphql)(?![a-z0-9_])/i;
const HTTP_CLIENT = /(?:^|[^a-z0-9_])(?:curl|wget|https?|httpie)(?![a-z0-9_])/i;
const FORGE_HOST = /api\.github\.com|github\.com|gitlab|graphql/i;
/**
 * A body the request reads from a file or stdin: `k=@f` (gh -F, curl -F,
 * httpie), `-d @f`, `-T f`, `--data-binary @f`, `--data-urlencode name@f`,
 * `--input f`, `--post-file f`, `--upload-file f`. Matched on the raw text,
 * so a file reference inside single quotes (which gh still reads) counts.
 */
const BODY_FILE =
  /(?:^|\s)[^\s=]*=@|(?:^|\s)-[dFT]\s*@|(?:^|\s)-T\b|--(?:data[\w-]*|form)\s+@|--data-urlencode\s+[^\s=@"']*@|--(?:upload-file|post-file|input)\b/;
/**
 * A `{a,b}` or `{a..b}` pattern bash would expand (matched on the unquoted
 * view). Runs are bounded so the match is linear: an unbounded pair of runs
 * backtracks quadratically on `{` followed by a long `a,a,a,…` (#962 review).
 */
const BRACE_EXPANSION = /\{[^{}\s,]{0,256}(?:,|\.\.)[^{}\s]{0,256}\}/;

/** Outside quotes, any of these refuses (metacharacters, expansions, comments). */
const FORBIDDEN = new Set("$`\\;|&<>(){}*?[#~!");
/** Inside double quotes only these still expand, escape or history-expand. */
const DQ_FORBIDDEN = new Set("$`\\!");

/** ANSI-C escapes that spell one character. Anything else stays literal. */
const ANSI_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};
const ANSI_ESCAPE_PATTERN =
  /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|[\s\S])/g;

/**
 * Decode the escapes of an ANSI-C `$'…'` body. An escape bash would not
 * decode (out-of-range code point, `\x` with no digits, unknown letter) is
 * kept literal as `\` plus its text, never dropped.
 */
function ansiC(body: string): string {
  return body.replace(ANSI_ESCAPE_PATTERN, (whole, e: string) => {
    if (e.length > 1 && /^[xuU]/.test(e)) {
      const code = Number.parseInt(e.slice(1), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (/^[0-7]/.test(e)) return String.fromCodePoint(Number.parseInt(e, 8));
    return ANSI_ESCAPES[e] ?? whole;
  });
}

/**
 * The command with the contents of single quotes removed (they are literal
 * to bash), and of double quotes too unless `keepDouble`. The quote marks
 * stay, so a removed word still leaves its `''` / `""` behind. Escaped
 * characters are skipped whole so a `\"` cannot open or close a quote.
 */
function quotedView(command: string, keepDouble: boolean): string {
  let out = "";
  let quote: "'" | '"' | undefined;
  const chars = [...command];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? "";
    if (ch === "\\" && quote !== "'") {
      const next = chars[i + 1] ?? "";
      i += 1;
      if (quote === undefined || keepDouble) out += ch + next;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        quote = undefined;
        out += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = undefined;
        out += ch;
      } else if (keepDouble) out += ch;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    out += ch;
  }
  return out;
}

/** Whether the command calls a forge's API or an HTTP client aimed at a forge. */
function isForgeOrHttpCall(command: string): boolean {
  return (
    (FORGE_NAME.test(command) && API_WORD.test(command)) ||
    (HTTP_CLIENT.test(command) && FORGE_HOST.test(command))
  );
}

/** A request body that is not a literal: a file, stdin or a shell expansion. */
function bodyIndirect(command: string): boolean {
  return /[$`]|<\(/.test(quotedView(command, true)) || BODY_FILE.test(command);
}

/** Split on unquoted command separators; each piece is the raw text of one simple command. */
function segments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (const ch of command) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (/[;&|\n`()]/.test(ch)) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** A segment whose command word (after `VAR=…` assignments) is expanded, quoted or escaped. */
function hasComplexCommandWord(command: string): boolean {
  return segments(command).some((seg) => {
    const word = seg
      .trim()
      .split(/\s+/)
      .find((w) => !/^[A-Za-z_]\w*=/.test(w));
    return word !== undefined && /[$`'"\\]/.test(word);
  });
}

/**
 * Step 1: does this command need the strict grammar at all? Returns the
 * refusal code for a trigger that refuses without reading (`expansion-command-word`,
 * `body-indirect`, `brace-expansion`), `""` for an ordinary trigger the grammar
 * judges, or undefined for no trigger. The widened view only widens the
 * trigger; the grammar in `lex` decides.
 */
function triggerCode(command: string): string | undefined {
  const widened = command
    .replace(/\$'((?:[^'\\]|\\[\s\S])*)'/g, (_, body: string) => ansiC(body))
    .replace(/\\\r?\n/g, "")
    .replace(/\$(?=['"])/g, "")
    .replace(/['"\\]/g, "");
  const texts = [command, widened];
  const verb = texts.some((t) => VERB_PAIR.test(t));
  const merge = texts.some((t) => MERGE_WORD.test(t));
  const forge = texts.some((t) => FORGE_WORD.test(t));
  if ((merge || verb) && hasComplexCommandWord(command)) return "expansion-command-word";
  if (isForgeOrHttpCall(command) && bodyIndirect(command)) return "body-indirect";
  if (forge && BRACE_EXPANSION.test(quotedView(command, false))) return "brace-expansion";
  if (verb) return "";
  const graphqlMutation = texts.some((t) => /mutation/i.test(t) && /merge/i.test(t));
  return forge && (merge || graphqlMutation) ? "" : undefined;
}

/**
 * Split into words with bash's quote removal, or a reason code when the text
 * holds anything this reading could get wrong: a forbidden character outside
 * single quotes (or one of `$` `` ` `` `\` `!` inside double quotes), a
 * control or non-ASCII character outside single quotes, or an unbalanced quote.
 */
function lex(command: string): { words: string[] } | { code: string } {
  const words: string[] = [];
  let word: string | undefined;
  let quote: "'" | '"' | undefined;
  for (const ch of command) {
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else word += ch;
      continue;
    }
    const forbidden = quote === '"' ? DQ_FORBIDDEN : FORBIDDEN;
    if (forbidden.has(ch)) return { code: `forbidden-char:${ch}` };
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 0x20 && ch !== "\t") || code > 0x7e) return { code: "control-or-non-ascii" };
    if (quote === '"') {
      if (ch === '"') quote = undefined;
      else word += ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (word !== undefined) words.push(word);
      word = undefined;
      continue;
    }
    word ??= "";
    if (ch === "'" || ch === '"') quote = ch;
    else word += ch;
  }
  if (quote !== undefined) return { code: "quote-unbalanced" };
  if (word !== undefined) words.push(word);
  return { words };
}

/**
 * gh subcommands that are genuine reads or creations: a merge word in their
 * arguments is prose. Everything else (comment, edit, review, ready, close,
 * reopen, workflow, run, release create|upload|delete, label create|edit,
 * issue edit|comment|close) is judged by the trigger, so a merge word in it
 * refuses — those verbs can mutate a PR, or fire a merge bot or workflow.
 */
const READ_ONLY_GH = new Set([
  "pr view",
  "pr list",
  "pr checks",
  "pr diff",
  "pr status",
  "pr create",
  "issue view",
  "issue list",
  "issue create",
  "release list",
  "release view",
  "label list",
  "repo view",
]);

/** Whether the words are one of the known read-only or creating gh subcommands. */
function isReadOnlyGh(words: string[]): boolean {
  if (words[0] !== "gh") return false;
  const [, noun = "", verb = ""] = words;
  if (noun === "search") return true;
  return READ_ONLY_GH.has(`${noun} ${verb}`);
}

interface ForgeGrammar {
  forge: "github" | "gitlab";
  tool: string;
  noun: string;
  /** Exact `/`-separated segment count of a repo value; undefined = any (≥ 2). */
  repoSegments?: number;
  /** Flags that take no value. A `--long=value` entry is matched whole. */
  bool: ReadonlySet<string>;
  /** Flags whose value is the next word, or `--long=value`. */
  valued: ReadonlySet<string>;
  /** Whether `--repo=VALUE` is accepted. */
  repoEq: boolean;
  /** A flag every merge must carry (the deferred-merge opt-out, glab). */
  requiredFlag?: string;
}

// Deferred merges (gh `--auto`, glab `--when-pipeline-succeeds`/`--auto-merge`)
// are refused: they run later, against whatever head the PR has by then, so
// the guard's one-time ledger and head check would not cover them. Recent glab
// queues one by default, so a glab merge must carry `--auto-merge=false`.
const GH: ForgeGrammar = {
  forge: "github",
  tool: "gh",
  noun: "pr",
  repoSegments: 2,
  bool: new Set([
    "--squash",
    "-s",
    "--merge",
    "-m",
    "--rebase",
    "-r",
    "--delete-branch",
    "-d",
    "--delete-branch=true",
    "--delete-branch=false",
    "--disable-auto",
  ]),
  valued: new Set([
    "--subject",
    "-t",
    "--body",
    "-b",
    "--body-file",
    "-F",
    "--match-head-commit",
    "--author-email",
    "-A",
  ]),
  repoEq: true,
};

const GLAB: ForgeGrammar = {
  forge: "gitlab",
  tool: "glab",
  noun: "mr",
  bool: new Set([
    "--squash",
    "-s",
    "--remove-source-branch",
    "-d",
    "--rebase",
    "-r",
    "--yes",
    "-y",
    "--auto-merge=false",
  ]),
  valued: new Set(["--message", "-m", "--squash-message", "--sha"]),
  repoEq: false,
  requiredFlag: "--auto-merge=false",
};

/** Read a repo selector at `words[i]`: the words it spans and its value, or undefined. */
function repoAt(
  g: ForgeGrammar,
  words: string[],
  i: number,
): { span: number; repo: string } | undefined {
  const w = words[i] ?? "";
  if (w === "-R" || w === "--repo") return { span: 2, repo: words[i + 1] ?? "" };
  if (g.repoEq && w.startsWith("--repo=")) return { span: 1, repo: w.slice("--repo=".length) };
  return undefined;
}

const refuse = (reason: string): MergeCommand => ({ kind: "refused", reason });

/** Step 2: the strict grammar over already-lexed words. */
function parse(g: ForgeGrammar, words: string[]): MergeCommand {
  let repo: string | undefined;
  const takeRepo = (sel: { repo: string }): string | undefined => {
    if (repo !== undefined) return "repo-repeated";
    if (!isValidRepoValue(sel.repo)) return "repo-value";
    if (g.repoSegments !== undefined && sel.repo.split("/").length !== g.repoSegments) {
      return "repo-count";
    }
    repo = sel.repo;
    return undefined;
  };
  let i = 1;
  const head = repoAt(g, words, i);
  if (head) {
    const bad = takeRepo(head);
    if (bad) return refuse(bad);
    i += head.span;
  }
  if (words[i] !== g.noun || words[i + 1] !== "merge") return refuse("not-pr-merge");
  i += 2;
  let prNumber: number | undefined;
  let optedOut = false;
  const n = words[i];
  if (n !== undefined && !n.startsWith("-")) {
    if (!/^[1-9][0-9]*$/.test(n) || !Number.isSafeInteger(Number(n))) return refuse("not-a-number");
    prNumber = Number(n);
    i += 1;
  }
  while (i < words.length) {
    const w = words[i] as string;
    const sel = repoAt(g, words, i);
    if (sel) {
      const bad = takeRepo(sel);
      if (bad) return refuse(bad);
      i += sel.span;
    } else if (g.bool.has(w)) {
      if (w === g.requiredFlag) optedOut = true;
      i += 1;
    } else if (g.valued.has(w)) {
      if (i + 1 >= words.length) return refuse("flag-missing-value");
      i += 2;
    } else if (w.startsWith("--") && w.includes("=") && g.valued.has(w.slice(0, w.indexOf("=")))) {
      i += 1;
    } else if (w.startsWith("-")) {
      return refuse(`unknown-flag:${w.slice(0, 40)}`);
    } else {
      return refuse("extra-command");
    }
  }
  if (g.requiredFlag !== undefined && !optedOut) return refuse("glab-auto-merge");
  return { kind: "merge", forge: g.forge, prNumber, repo };
}

/** Classify a bash command for the merge guard. Linear in the command length. */
export function readMergeCommand(command: string): MergeCommand {
  const lexed = lex(command);
  if ("words" in lexed && isReadOnlyGh(lexed.words)) return { kind: "none" };
  const trigger = triggerCode(command);
  if (trigger === undefined) return { kind: "none" };
  if (trigger !== "") return refuse(trigger);
  if (!("words" in lexed)) return refuse(lexed.code);
  const words = lexed.words;
  const g = words[0] === GH.tool ? GH : words[0] === GLAB.tool ? GLAB : undefined;
  return g ? parse(g, words) : refuse("not-a-forge-command");
}

/** The refusal for a glab merge that does not opt out of deferred auto-merge. */
export const GLAB_AUTO_MERGE_REFUSAL =
  "merge refused: `glab mr merge` without `--auto-merge=false` queues a deferred auto-merge when the pipeline is still running, so it can merge commits pushed after the review. Use the accepted form, run on its own: `glab mr merge <N> --auto-merge=false` (or `glab -R GROUP/REPO mr merge <N> --auto-merge=false`). Operator override: PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1";

/** The guard's refusal for a triggered command outside the grammar. */
export const MERGE_FORM_REFUSAL =
  "merge refused: the merge guard checks only one plain merge command — `gh [-R OWNER/REPO] pr merge [N] [flags]` or `glab [-R GROUP/REPO] mr merge [N] [flags]`, run on its own: no pipes, chains, substitutions, variables, wrappers (env/sudo/nice/time/exec/oo), `bash -c`, `eval`, `gh api`/curl REST or GraphQL merges, a request body read from a file, stdin or a shell expansion, no deferred `--auto` merge. A command that names gh/glab/curl/an interpreter and the word `merge` anywhere (even in prose) is held to this form: put a PR or comment body in a file (`--body-file <file>`) and a commit message in `git commit -F <file>`. Operator override: PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1";

/** The form refusal, with the reason code that says what to change. */
export function mergeFormRefusal(reason?: string): string {
  return reason === undefined ? MERGE_FORM_REFUSAL : `${MERGE_FORM_REFUSAL} [reason: ${reason}]`;
}

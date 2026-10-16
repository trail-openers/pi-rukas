/**
 * merge-allowlist — which bash commands the merge guard (merge-guard.ts)
 * treats as a merge, and the one shape of merge it will check.
 *
 * #962. The guard used to parse arbitrary shell to find a merge wherever it
 * hid; every review round found a shape it read differently from bash. This
 * module replaces that with a strict allowlist, in three steps:
 *
 *   0a. SIZE BOUND (#955, restored by #1417 — merge-size.ts). A long command
 *      naming `gh`/`glab` that spells a merge word is `refused` with
 *      `too-large`: never resolved to the current branch's PR. A long command
 *      that spells NO merge word — a `gh pr view` with a 9 kB `--jq`, a
 *      changelog pasted into `gh pr create --body` — answers `none` as a short
 *      one would: the bound holds merge-bearing text, not long text.
 *   0b. READ-ONLY GH. A command lexing as ONE simple command whose words are
 *      `gh` + a genuine read (or a creation with no inline body) is not a
 *      merge, whatever merge words its titles or searches carry —
 *      `READ_ONLY_GH` is the list, `BODY_FLAGS` the creation split.
 *      Comments, edits, reviews and workflow/run verbs are NOT exempt: refused
 *      when they carry a merge word (put prose in `--body-file`).

 *   1. TRIGGER (cheap, on the raw text, case-insensitive — merge-trigger.ts
 *      owns the patterns and their reason codes). Refused outright, without
 *      reading: forge/HTTP-client/interpreter + a merge word; `pr merge` /
 *      `mr merge` / `mr accept` at all; an expanded, quoted or escaped command
 *      word; a forge or HTTP body read from a file, stdin or an expansion; a
 *      forge name with a brace pattern bash would expand. No trigger → `none`.
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
 * Threat model, the accepted flags and the full list of what is refused:
 * docs/troubleshooting.md. An honest-but-forgetful agent, not an adversary: a
 * merge whose words never appear in the command text (`gh pr m$X 17`,
 * `bash x.sh`) never triggers and is a documented residual.
 *
 * #1417 — a `refused` result is a HOLD, not a merge verdict: "this text looks
 * merge-adjacent and I cannot read it", not "this merge is unreviewed". The
 * texts live in merge-refusals.ts, where only the MERGE refusals name the
 * `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE` hatch — an agent told to set a merge
 * safety switch to unblock a read is handed the wrong remedy.
 */

import { lexedWhy } from "./merge-refusals.ts";
import { analysisBound } from "./merge-size.ts";
import { triggerCode } from "./merge-trigger.ts";

/** What the guard does with a bash command. */
export type MergeCommand =
  | { kind: "none" }
  /**
   * A command the guard HELD rather than read as a merge (#1417).
   *
   * #1417 LOW — `reason` is a BARE code, `detail` its prose, in two fields.
   * They used to be one string (`"unknown-flag — the offending word is
   * `--auto`"`), which broke every exact comparison: the guard's own
   * `analysis.reason === "glab-auto-merge"` test only worked because that one
   * refusal happens to carry no clause. `holdReasonText` composes the two;
   * nothing downstream splits them. `detail` names WHAT was held (the trigger
   * word, the offending word), because a refusal that renders only a code
   * never explained itself: `[reason: body-ind…]`.
   */
  | { kind: "refused"; reason?: string; detail?: string }
  | { kind: "merge"; forge: "github" | "gitlab"; prNumber?: number; repo?: string };

/** A trigger's answer: the stable code every test/doc cites, and what was held. */
export type HoldReason = { code: string; detail: string };

/**
 * A repo value safe to pass to gh/glab — `owner/repo` (GitLab:
 * `group/sub/repo`) — and so safe to interpolate into a forge exec string.
 */
export const REPO_VALUE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_.-]+)+$/;

/** Whether a repo value matches the pattern above. */
export function isValidRepoValue(value: string): boolean {
  return REPO_VALUE_PATTERN.test(value);
}

export const FORGE_WORD =
  /(?:^|[^a-z0-9_])(?:gh|glab|hub|curl|wget|https?|python3?|node|bun|deno|ruby|perl)(?![a-z0-9_])|api\.github\.com|gitlab|octokit/i;
/**
 * `pr merge` / `mr merge` / `mr accept` (glab's alias) — a merge verb even
 * when the forge CLI runs under another name (`./g pr merge 17`).
 */
export const VERB_PAIR = /(?:^|[^a-z0-9_])[pm]r\s+(?:merge|accept)(?![a-z0-9_])/i;
export const MERGE_WORD =
  /(?:^|[^a-z0-9_])merge(?![a-z0-9_])|mergepullrequest|enablepullrequestautomerge|mergerequestaccept|acceptmergerequest|mergerequestmerge|mergemergerequest|automerge|mergebranch|mergequeue|enqueuepullrequest/i;
export const HTTP_CLIENT = /(?:^|[^a-z0-9_])(?:curl|wget|https?|httpie)(?![a-z0-9_])/i;
/**
 * A `{a,b}` / `{a..b}` pattern bash would expand (unquoted view). Runs are
 * bounded so the match stays LINEAR: unbounded, it backtracks quadratically on
 * `{` + a long `a,a,a,…` (#962 review).
 */
export const BRACE_EXPANSION = /\{[^{}\s,]{0,256}(?:,|\.\.)[^{}\s]{0,256}\}/;

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
export const ANSI_ESCAPE_PATTERN =
  /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|[\s\S])/g;

/**
 * Decode the escapes of an ANSI-C `$'…'` body. One bash would not decode
 * (out-of-range, no digits, unknown letter) stays literal, never dropped.
 */
export function ansiC(body: string): string {
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
 * The command with single-quoted contents removed (literal to bash), and
 * double-quoted contents too unless `keepDouble`. Quote marks stay, so a
 * removed word still leaves its `''` / `""` behind; escapes are skipped whole
 * so a `\"` cannot open or close a quote.
 */
export function quotedView(command: string, keepDouble: boolean): string {
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
export function hasComplexCommandWord(command: string): boolean {
  return segments(command).some((seg) => {
    const word = seg
      .trim()
      .split(/\s+/)
      .find((w) => !/^[A-Za-z_]\w*=/.test(w));
    return word !== undefined && /[$`'"\\]/.test(word);
  });
}

/**
 * Split into words with bash's quote removal, or a reason code when the text
 * holds anything that reading could get wrong: a forbidden character outside
 * single quotes (or `$` `` ` `` `\` `!` inside double), a control or non-ASCII
 * character, or an unbalanced quote.
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
 * issue edit|comment|close) is judged by the trigger — those verbs can
 * mutate a PR, or fire a merge bot or workflow. `pr create` / `issue create`
 * are not unconditionally exempt: see `isCreationWithBody`.
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
// run later, against whatever head the PR has by then, so the guard's one-time
// ledger and head check would not cover them. Recent glab queues one by
// default, so a glab merge must carry `--auto-merge=false`.
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

/** Read a repo selector at `words[i]`: its span and value, or undefined. */
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

const refuse = (reason: string, detail?: string): MergeCommand => ({
  kind: "refused",
  reason,
  ...(detail === undefined ? {} : { detail }),
});

/** Step 2: the strict grammar over already-lexed words. */
function parse(g: ForgeGrammar, words: string[]): MergeCommand {
  // #1417 — every refusal names the word it stopped at, so the agent reading
  // it knows what to change rather than guessing from a bare code. The code
  // and the clause are SEPARATE fields (#1417 LOW): `reason` stays exactly
  // the stable token a test or doc cites.
  const refuseAt = (code: string, word: string, more?: string): MergeCommand =>
    refuse(
      code,
      `the offending word is \`${word.slice(0, 40)}\`${more === undefined ? "" : `; ${more}`}`,
    );
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
  if (words[i] !== g.noun || words[i + 1] !== "merge") {
    return refuseAt(
      "not-pr-merge",
      words[i] ?? "<end of command>",
      `expected \`${g.noun} merge\` here, so this is not the merge the guard can check`,
    );
  }
  i += 2;
  let prNumber: number | undefined;
  let optedOut = false;
  const n = words[i];
  if (n !== undefined && !n.startsWith("-")) {
    if (!/^[1-9][0-9]*$/.test(n) || !Number.isSafeInteger(Number(n))) {
      return refuseAt("not-a-number", n, "a PR/MR number must be digits");
    }
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
      if (i + 1 >= words.length) return refuse("flag-missing-value", `\`${w}\` takes a value`);
      i += 2;
    } else if (w.startsWith("--") && w.includes("=") && g.valued.has(w.slice(0, w.indexOf("=")))) {
      i += 1;
    } else if (w.startsWith("-")) {
      return refuseAt("unknown-flag", w, "it is not a flag of the accepted merge form");
    } else {
      return refuseAt("extra-command", w, "only one command is read");
    }
  }
  if (g.requiredFlag !== undefined && !optedOut) return refuse("glab-auto-merge");
  return { kind: "merge", forge: g.forge, prNumber, repo };
}

/**
 * The inline body flags that cost a `gh pr create` / `issue create` its read
 * exemption (#1417 — the narrow half of the option the review offered). An
 * inline `--body` is a string the agent typed, and that is where a merge word
 * reaches the forge verbatim: `--body "gh pr merge 12"` is judged.
 *
 * The file forms (`--body-file` / `-F`) are NOT here: the guard cannot read
 * the file, so the flag is no evidence of a merge, and naming one is the
 * guard's OWN documented remedy for a merge word in prose ("put the prose in
 * a file") — refusing it would make the documented way out a dead end. It is
 * also how this harness posts bodies (`forge-commands.ts`, and the /work
 * driver's ops fallback). A title is prose and stays exempt.
 */
const BODY_FLAGS = new Set(["--body", "-b"]);

function isCreationWithBody(words: string[]): boolean {
  const [, noun = "", verb = ""] = words;
  if (verb !== "create" || (noun !== "pr" && noun !== "issue")) return false;
  return words.some((w) => BODY_FLAGS.has(w) || BODY_FLAGS.has(w.split("=")[0] ?? ""));
}

/** Whether the words are one of the known read-only or creating gh subcommands. */
function isReadOnlyGh(words: string[]): boolean {
  if (words[0] !== "gh") return false;
  if (isCreationWithBody(words)) return false;
  const [, noun = "", verb = ""] = words;
  if (noun === "search") return true;
  return READ_ONLY_GH.has(`${noun} ${verb}`);
}

/** Classify a bash command for the merge guard. Linear in the command length. */
export function readMergeCommand(command: string): MergeCommand {
  // #955 / #1417 — the size bound first, before the read allowlist, so a
  // merge-bearing command too long to read is HELD rather than falling through
  // to current-branch PR resolution. What it bounds is exactly the commands
  // the rest of this function would have had to read (merge-size.ts): a long
  // command naming no forge, and a long command spelling no merge word, answer
  // `none` here just as they would below the bound. Constant, predicate and
  // wording in merge-size.ts.
  const bounded = analysisBound(command);
  if (bounded !== undefined) return bounded;
  const lexed = lex(command);
  if ("words" in lexed && isReadOnlyGh(lexed.words)) return { kind: "none" };
  const trigger = triggerCode(command);
  if (trigger === undefined) return { kind: "none" };
  // A trigger that refuses without reading: the code carries its own detail.
  if (trigger.code !== "") return refuse(trigger.code, trigger.detail);
  if (!("words" in lexed)) {
    return refuse(
      lexed.code,
      `triggered by ${trigger.detail}; the text also holds ${lexedWhy(lexed.code)}`,
    );
  }
  const words = lexed.words;
  const g = words[0] === GH.tool ? GH : words[0] === GLAB.tool ? GLAB : undefined;
  if (g !== undefined) return parse(g, words);
  return refuse(
    "not-a-forge-command",
    `triggered by ${trigger.detail}, but the command word is \`${(words[0] ?? "<empty>").slice(0, 40)}\`, not \`gh\` or \`glab\`,`,
  );
}

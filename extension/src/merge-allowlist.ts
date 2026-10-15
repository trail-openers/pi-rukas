/**
 * merge-allowlist — which bash commands the merge guard (merge-guard.ts)
 * treats as a merge, and the one shape of merge it will check.
 *
 * #962. The guard used to parse arbitrary shell to find a merge wherever it
 * hid; every review round found a shape it read differently from bash. This
 * module replaces that with a strict allowlist, in two steps:
 *
 *   1. TRIGGER (cheap, on the raw text, case-insensitive): the text names a
 *      forge or HTTP client (`gh`, `glab`, `hub`, `curl`, `wget`, `http`,
 *      `https`, `api.github.com`, `gitlab`) AND a merge word (`merge` as a
 *      whole word, `mergepullrequest`, `enablepullrequestautomerge`). The
 *      words are also looked for after quote and backslash removal, so
 *      `g"h"` and `m"erge"` trigger. No trigger → `none`: not a merge.
 *   2. A triggered command must be EXACTLY one simple command in the grammar
 *      below, or it is `refused`:
 *
 *        gh   [-R|--repo OWNER/REPO | --repo=OWNER/REPO] pr merge [N] [FLAGS]
 *        glab [-R|--repo GROUP/…/REPO]                   mr merge [N] [FLAGS]
 *
 *      Words are split on blanks; quotes are removed as bash removes them.
 *      Outside single quotes the text may not contain any shell
 *      metacharacter, expansion or control character, so every word bash
 *      would see is exactly the word read here.
 *
 * Threat model (docs/troubleshooting.md): an honest-but-forgetful agent, not
 * an adversary. A merge assembled entirely from expansions (`$G pr m$X 17`)
 * never triggers and is a documented residual.
 */

/** What the guard does with a bash command. */
export type MergeCommand =
  | { kind: "none" }
  | { kind: "refused" }
  | { kind: "merge"; forge: "github" | "gitlab"; prNumber?: number; repo?: string };

/** A repo value safe to pass to gh/glab: `owner/repo` (GitLab: `group/sub/repo`). */
export const REPO_VALUE_PATTERN = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;
const GH_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Whether a repo value is safe to interpolate into a forge exec string. */
export function isValidRepoValue(value: string): boolean {
  return REPO_VALUE_PATTERN.test(value);
}

const FORGE_WORD =
  /(?:^|[^a-z0-9_])(?:gh|glab|hub|curl|wget|https?)(?![a-z0-9_])|api\.github\.com|gitlab/i;
const MERGE_WORD =
  /(?:^|[^a-z0-9_])merge(?![a-z0-9_])|mergepullrequest|enablepullrequestautomerge/i;

/** Outside single quotes, any of these refuses (metacharacters, expansions, comments). */
const FORBIDDEN = new Set("$`\\;|&<>(){}*?[#");

/**
 * Step 1: does this command need the strict grammar at all? Each word is
 * looked for in the raw text and after quote and backslash removal (`g"h"`,
 * `m'erge'`, `mer\⏎ge`); an ANSI-C `$'…'` string, whose escapes can spell
 * either word, stands in for whichever one is missing.
 */
function triggers(command: string): boolean {
  const dequoted = command
    .replace(/\\\r?\n/g, "")
    .replace(/\$(?=['"])/g, "")
    .replace(/['"\\]/g, "");
  const forge = FORGE_WORD.test(command) || FORGE_WORD.test(dequoted);
  const merge = MERGE_WORD.test(command) || MERGE_WORD.test(dequoted);
  return (forge && merge) || ((forge || merge) && command.includes("$'"));
}

/**
 * Split into words with bash's quote removal, or undefined when the text
 * holds anything this reading could get wrong: a forbidden character
 * outside single quotes, a control or non-ASCII character outside single
 * quotes, or an unbalanced quote.
 */
function lex(command: string): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  let quote: "'" | '"' | undefined;
  for (const ch of command) {
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else word += ch;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (FORBIDDEN.has(ch) || (code < 0x20 && ch !== "\t") || code > 0x7e) return undefined;
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
  if (quote !== undefined) return undefined;
  if (word !== undefined) words.push(word);
  return words;
}

interface ForgeGrammar {
  forge: "github" | "gitlab";
  tool: string;
  noun: string;
  repoPattern: RegExp;
  /** Flags that take no value. A `--long=value` entry is matched whole. */
  bool: ReadonlySet<string>;
  /** Flags whose value is the next word, or `--long=value`. */
  valued: ReadonlySet<string>;
  /** Whether `--repo=VALUE` is accepted. */
  repoEq: boolean;
}

const GH: ForgeGrammar = {
  forge: "github",
  tool: "gh",
  noun: "pr",
  repoPattern: GH_REPO_PATTERN,
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
    "--auto",
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
  repoPattern: REPO_VALUE_PATTERN,
  bool: new Set([
    "--squash",
    "-s",
    "--remove-source-branch",
    "-d",
    "--rebase",
    "-r",
    "--yes",
    "-y",
    "--when-pipeline-succeeds",
  ]),
  valued: new Set(["--message", "-m", "--squash-message", "--sha"]),
  repoEq: false,
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

/** Step 2: the strict grammar over already-lexed words. */
function parse(g: ForgeGrammar, words: string[]): MergeCommand {
  const refused: MergeCommand = { kind: "refused" };
  let repo: string | undefined;
  const takeRepo = (sel: { repo: string }) => {
    if (repo !== undefined || !g.repoPattern.test(sel.repo)) return false;
    repo = sel.repo;
    return true;
  };
  let i = 1;
  const head = repoAt(g, words, i);
  if (head) {
    if (!takeRepo(head)) return refused;
    i += head.span;
  }
  if (words[i] !== g.noun || words[i + 1] !== "merge") return refused;
  i += 2;
  let prNumber: number | undefined;
  const n = words[i];
  if (n !== undefined && /^[1-9][0-9]*$/.test(n)) {
    prNumber = Number(n);
    if (!Number.isSafeInteger(prNumber)) return refused;
    i += 1;
  }
  while (i < words.length) {
    const w = words[i] as string;
    const sel = repoAt(g, words, i);
    if (sel) {
      if (!takeRepo(sel)) return refused;
      i += sel.span;
    } else if (g.bool.has(w)) {
      i += 1;
    } else if (g.valued.has(w)) {
      if (i + 1 >= words.length) return refused;
      i += 2;
    } else if (w.startsWith("--") && w.includes("=") && g.valued.has(w.slice(0, w.indexOf("=")))) {
      i += 1;
    } else {
      return refused;
    }
  }
  return { kind: "merge", forge: g.forge, prNumber, repo };
}

/** Classify a bash command for the merge guard. Linear in the command length. */
export function readMergeCommand(command: string): MergeCommand {
  if (!triggers(command)) return { kind: "none" };
  const words = lex(command);
  if (words === undefined) return { kind: "refused" };
  const g = words[0] === GH.tool ? GH : words[0] === GLAB.tool ? GLAB : undefined;
  return g ? parse(g, words) : { kind: "refused" };
}

/** The guard's refusal for a triggered command outside the grammar. */
export const MERGE_FORM_REFUSAL =
  "merge refused: the merge guard checks only one plain merge command — `gh [-R OWNER/REPO] pr merge [N] [flags]` or `glab [-R GROUP/REPO] mr merge [N] [flags]`, run on its own: no pipes, chains, substitutions, variables, wrappers (env/sudo/nice/time/exec), `bash -c`, `eval`, `gh api`/curl REST or GraphQL merges. A command that names gh/glab/curl and the word `merge` anywhere (even in prose) is held to this form: put a PR or comment body in a file (`--body-file <file>`) and a commit message in `git commit -F <file>`. Operator override: PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1";

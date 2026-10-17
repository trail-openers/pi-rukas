/**
 * work-driver-plan-unfence-extract — #1167: what the issue actually requires.
 *
 * The extraction half of the plan-time unfence (the repair half lives in
 * work-driver-plan-unfence.ts). Two questions, both answered from the issue
 * body alone with no I/O:
 *
 * 1. Which sections are the issue's requirements? Only `DECISIONS`,
 *    `Resolved decisions` and `ACCEPTANCE CRITERIA`, matched as a WHOLE
 *    heading at any level and case-insensitively. `## Open questions about
 *    decisions` is not the decisions section; `## Context` and the issue's own
 *    `## Out of scope` are not requirements either. When no such heading
 *    exists the pass extracts nothing — silence is not a requirement, and a
 *    pass that unfenced from prose it merely resembled would weaken the fence
 *    on noise.
 *
 * 2. Which tokens in those sections name a file or a symbol? Paths and
 *    identifiers are the two kinds the issue can use to say "this file
 *    changes" — `extension/src/dispatch.ts` and `dispatchCore` are the same
 *    claim in #1020's own words. Prose, globs and prohibition sentences are
 *    not.
 *
 * Prohibitions are the part a naive implementation gets wrong: a line reading
 * "do not touch src/secret.ts" names the file, and removing that fence would
 * delete a boundary the issue itself asked for. So a sentence carrying a
 * negation is excluded from extraction entirely (the operator resolution of
 * 2026-10-17 recorded on #1167). The `no …` branch is anchored to a clause
 * boundary, because the issue's own prose uses a mid-sentence ", not the
 * spawn path" to qualify rather than to forbid.
 */

import { normaliseDeclaredPath } from "./work-driver-verify.ts";

/**
 * Headings whose text names one of the three sections the extraction reads
 * (`DECISIONS`, `Resolved decisions`, `ACCEPTANCE CRITERIA`) — matched
 * case-insensitively, at any heading level.
 */
const SECTION_HEADING = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const SECTION_NAMES = [/^decisions$/i, /^resolved\s+decisions$/i, /^acceptance\s+criteria$/i];

/** A sentence refusing an action — its paths are prohibitions, not requirements. */
const NEGATION =
  /\b(do\s+not|don'?t|does\s+not|doesn'?t|never|not\s+to\s+|must\s+not|may\s+not|cannot|can'?t|avoid|instead\s+of|rather\s+than|without|forbid|prohibit|refus|reject|excluded?|out\s+of\s+scope)\b|(?:^|[.!?;:]\s*|[-—]\s*)no\s+\w*(?:t|d)\b|(?:^|[.!?;:]\s*|[-—]\s*)no\s+(?:such|longer|changes?\b|commits?\b|tests?\b|files?\b|work\b|edits?\b|paths?\b|code\b|updates?\b|modif)/i;

/** Tokens that look like a repo path: they carry a `/` or a source extension. */
const PATH_LIKE =
  /[/]|\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py|rb|java|kt|sh|bash|json|md|yml|yaml|toml|css|scss|html|sql)$/i;

/** Globs and patterns are not files — `test-work-driver-plan*` names nothing. */
const GLOB = /[*?[\]{}]/;

/**
 * A code identifier: camelCase or snake_case. The second character must be
 * lower-case or a digit, so sentence-initial and proper-noun words (`The`,
 * `Issues`, `No`) are not names; the stop list below is what keeps ordinary
 * English out of the identifier set without demanding a camel hump that is
 * not in the issue's prose.
 */
const IDENTIFIER = /^[A-Za-z][a-z0-9][A-Za-z0-9]*(_[A-Za-z0-9]+)?$/;

/** English words a grep would resolve to something unrelated to the issue. */
const NOT_A_NAME = new Set([
  "and",
  "are",
  "but",
  "for",
  "not",
  "the",
  "with",
  "that",
  "this",
  "from",
  "then",
  "than",
  "when",
  "into",
  "over",
  "their",
  "there",
  "these",
  "those",
  "which",
  "while",
  "about",
  "after",
  "before",
  "under",
  "above",
  "across",
  "covers",
  "keeps",
  "takes",
  "makes",
  "uses",
  "gives",
  "has",
  "have",
  "must",
  "should",
  "could",
  "would",
  "will",
  "each",
  "every",
  "some",
  "most",
  "only",
  "also",
  "same",
  "both",
  "own",
  "all",
  "any",
  "none",
  "true",
  "false",
  "null",
  "undefined",
  "http",
  "https",
  "api",
  "todo",
  "example",
  "eg",
  "ie",
  "etc",
  "unknown",
  "default",
  "issue",
  "issues",
  "test",
  "tests",
  "spec",
  "specs",
  "plan",
  "plans",
  "driver",
  "drivers",
  "workstream",
  "workstreams",
  "acceptance",
  "criteria",
  "criterion",
  "decisions",
  "resolved",
  "closes",
  "fixes",
  "reopens",
  "workflow",
  "pr",
  "ui",
  "ok",
  "id",
]);

/** The issue body's decision / acceptance sections, as raw line blocks. */
export function decisionSectionsOf(body: string): string[] {
  const out: string[] = [];
  let current: string[] | undefined;
  const flush = (): void => {
    if (current) {
      out.push(current.join("\n"));
      current = undefined;
    }
  };
  for (const line of body.split("\n")) {
    const heading = SECTION_HEADING.exec(line);
    if (heading) {
      const text = (heading[1] ?? "").trim();
      // Any heading closes the section that was open — including a heading
      // that is itself one of the three names, which opens a fresh one.
      flush();
      if (SECTION_NAMES.some((re) => re.test(text))) current = [];
      continue;
    }
    if (current) current.push(line);
  }
  flush();
  return out;
}

/** Candidate tokens the issue named — prohibition sentences and globs excluded. */
export function issueNamedTokens(body: string): string[] {
  const tokens = new Set<string>();
  for (const section of decisionSectionsOf(body)) {
    for (const sentence of section.split(/(?<=[.!?])\s+|\n+/)) {
      if (NEGATION.test(sentence)) continue;
      // `/` is NOT a delimiter here: it is what distinguishes a path
      // (`extension/src/dispatch.ts`) from a `symbol/symbol` pair
      // (`dispatchCore/startJob`), and real issue bodies use both forms.
      for (const raw of sentence.split(/[\s,;(){}[\]|]+/)) {
        const token = raw.replace(/^["'`*]+|["'`*.,:]+$/g, "").trim();
        if (token.length < 2 || token.length > 200) continue;
        if (GLOB.test(token)) continue;
        // A path may carry a planner-style annotation (`src/a.ts (new)`) or
        // prose punctuation — normalise before deciding it is a path.
        const path = PATH_LIKE.test(token) ? normaliseDeclaredPath(token) : "";
        if (path && PATH_LIKE.test(path) && !GLOB.test(path) && looksLikeFilePath(path)) {
          tokens.add(path);
          continue;
        }
        // Not a file: check every `/`-separated half as an identifier, so
        // `dispatchCore/startJob` yields two symbol names rather than one
        // token that resolves nowhere.
        for (const part of token.split("/")) {
          if (isIdentifier(part)) tokens.add(part);
        }
      }
    }
  }
  return [...tokens];
}

function isPlainRelative(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith("/")) return false;
  if (p.split("/").includes("..")) return false;
  if (/[`$;&|<>(){}\\|"'\s]/.test(p)) return false;
  return true;
}

/**
 * A path names a file or a directory, not a prose list. The last segment must
 * either carry a known source extension or be a directory (the entry ends in
 * `/` — real fences carry `docs/` shapes); `dispatchCore/startJob` fails this
 * and is read as two symbol names instead.
 */
function looksLikeFilePath(p: string): boolean {
  if (!isPlainRelative(p)) return false;
  const segments = p.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  const last = segments[segments.length - 1] ?? "";
  if (/\.[A-Za-z][A-Za-z0-9]*$/.test(last)) return true;
  return p.endsWith("/");
}

function isIdentifier(token: string): boolean {
  if (token.includes("/")) return false;
  if (!IDENTIFIER.test(token)) return false;
  if (NOT_A_NAME.has(token.toLowerCase())) return false;
  return true;
}

/**
 * Files that can DEFINE a symbol. Prose and test files MENTION symbols far
 * more often than they define them, and a repo-wide `git grep` for a popular
 * name hits dozens of test files — so an identifier is resolved only against
 * files under a recognised code directory, which is what keeps a
 * widely-mentioned name from resolving to a test that merely calls it.
 */
const CODE_DIR = /(^|\/)(src|lib|app|pkg|cmd|internal|server|client|extension)\//;

/** Declaration keywords that introduce a definition, in the languages at home here. */
const DECL_KEYWORDS =
  "function|const|let|var|class|interface|type|enum|fn|func|def|struct|trait|impl";
const DECL_PREFIX =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:static\s+)?/;

/**
 * A line that DEFINES `name` rather than mentioning it: a declaration keyword
 * immediately followed by the name. The boundary check runs here in
 * TypeScript, not in the grep pattern — `git grep`'s BRE cannot be trusted
 * with `\s`/`\b`, and a silently-unsupported escape turns a definition check
 * into no check at all.
 */
export function definesSymbolLine(line: string, name: string): boolean {
  const stripped = line.replace(/^\s*/, "").replace(DECL_PREFIX, "");
  if (!new RegExp(`^(?:${DECL_KEYWORDS})\\b`).test(stripped)) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:${DECL_KEYWORDS})\\s+${escaped}(?:[\\s({<:=,)]|$)`).test(stripped);
}

/** True when any line of `text` defines `name`. */
export function definesSymbol(text: string, name: string): boolean {
  for (const line of text.split("\n")) {
    if (definesSymbolLine(line, name)) return true;
  }
  return false;
}

/**
 * Narrow a `git grep -l` candidate list to the single file that DEFINES the
 * symbol: only source files qualify, and exactly one of them has to carry a
 * definition line. Zero or several definitions is an ambiguous name — the
 * caller records a note and unfences nothing rather than opening a fence on a
 * guess (the issue's own named pitfall: a popular symbol name matches half the
 * repository, and `git grep -l` cannot tell a definition from a reference).
 */
export async function resolveDefiningFile(
  name: string,
  candidates: string[],
  read: (file: string) => Promise<string>,
): Promise<string | undefined> {
  const source = [...new Set(candidates.filter((f) => CODE_DIR.test(f)))];
  const defining: string[] = [];
  for (const file of source) {
    try {
      if (definesSymbol(await read(file), name)) defining.push(file);
    } catch {
      // An unreadable candidate is not a definition — it never unfences.
    }
  }
  return defining.length === 1 ? defining[0] : undefined;
}

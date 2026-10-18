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
 *
 * The prohibition vocabulary is deliberately wider than negation. The
 * adversarial review of #1167 reproduced eight phrasings that carry no
 * auxiliary at all — "keep X untouched", "leave X alone", "X remains
 * unchanged", "skip X", "X is not part of this change", "off-limits", "leave
 * X as is" — and an unfence that reads only "do not …" UNFENCES every one of
 * them, which is the wrong direction of failure. The rule this module follows
 * is fail-closed: **when in doubt, keep the fence**, so a sentence that reads
 * like a prohibition is treated as one.
 *
 * Code blocks are the other way the same defect arrives: an issue's DECISIONS
 * section quotes an example (`import x from "src/legacy.ts"`) and the fenced
 * file is not a requirement at all — it is an illustration of what the change
 * must not become. Example blocks are stripped before extraction, so nothing
 * inside one can name a fence.
 */

import { isPlainRepoRelativePath } from "./work-driver-plan-paths.ts";
import { stripCodeBlocks } from "./work-driver-plan-unfence-code.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";

// The DEFINITION half of the pass lives in work-driver-plan-unfence-defines.ts
// (the AGENTS.md §12 line cap) — a real seam, not a convenient cut: this module
// reads the ISSUE (which sections, which tokens), that one reads the REPO (which
// grep candidate actually DECLARES the name). Only `resolveDefiningFile` is
// re-exported, because that is the only name the pass imports through this path;
// `definesSymbol` / `definesSymbolLine` / `couldNotResolveWhy` are imported from
// the defines module directly (round-5 cleanup — the extra re-exports made two
// modules look like one API surface for no caller).
export { resolveDefiningFile } from "./work-driver-plan-unfence-defines.ts";

/**
 * Headings whose text names one of the three sections the extraction reads
 * (`DECISIONS`, `Resolved decisions`, `ACCEPTANCE CRITERIA`) — matched
 * case-insensitively, at any heading level.
 */
const SECTION_HEADING = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const SECTION_NAMES = [/^decisions$/i, /^resolved\s+decisions$/i, /^acceptance\s+criteria$/i];

/**
 * A sentence that REFUSES an action — its paths are prohibitions, not
 * requirements, and stay fenced.
 *
 * Fail-closed by design: a sentence that merely READS like a refusal is treated
 * as one (the rule the module header states — *when in doubt, keep the fence*),
 * because a pass that read only "do not …" removes the eight auxiliary-free
 * phrasings the #1167 adversarial review produced.
 *
 * The test is "does any rule in `NEGATIONS` below match this sentence?" — the
 * rules, not this function, are the rule being stated. `NEGATIONS` is built from
 * parts, but every part is a REGEX LITERAL rather than a string: an earlier
 * revision built the alternation from `"\\s"`-style strings and one missing
 * backslash turned `\s` into a literal `s`, so `does\s+not` silently became
 * `does\s` + `not` against the letter s. Literals cannot drift that way.
 *
 * Two families, anchored differently on purpose. An auxiliary refusal (`do
 * not`, `must not`, `never`, `cannot`, …) is unambiguous wherever it appears.
 * The bare verbs are ordinary English (`the plan keeps its own seam`, `keep
 * their existing tests green`), so `keep`/`leave`/`skip` only read as a
 * prohibition when what they govern is a path (`leave config/settings.ts
 * alone`) or a refusal word (`skip it`, `leave it alone`); a predicate
 * adjective (`untouched`, `as is`, `off-limits`, `unchanged`) must sit at the
 * end of the sentence or directly against a path. `keep X up to date` is a
 * maintenance obligation and is matched out first. That is the widest net that
 * still reads the issue's own requirements as requirements.
 */
const PATH_TAIL = String.raw`[\w./@-]*[\w./@-]`;
/**
 * Every source extension the extraction recognises, in ONE list (#1167
 * round-3 cleanup): `PATH_WORD` below and `PATH_LIKE` further down are built
 * from it, so a new language cannot be added to one and missed in the other
 * (the two copies previously differed only by an anchor).
 */
const SRC_EXTS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "rs",
  "go",
  "py",
  "rb",
  "java",
  "kt",
  "sh",
  "bash",
  "json",
  "md",
  "yml",
  "yaml",
  "toml",
  "css",
  "scss",
  "html",
  "sql",
];
const SRC_EXT = SRC_EXTS.join("|");
/** A path-shaped word ending in a known source extension, with nothing after it. */
const PATH_WORD = new RegExp(
  `(?:${PATH_TAIL}\\.(?:${SRC_EXT})/\\b|(?:${PATH_TAIL}\\.(?:${SRC_EXT}))(?:[\\s.,;:!?)]|$))`,
);
const REFUSAL_WORD = String.raw`(?:it|its|them|their|these|those|that|this)\s+\w+|alone|as\s+is|as-is|untouched|unchanged`;
/**
 * Where a bare verb may be governed by a refusal pronoun. Clause-initial
 * only: `skip it`, `. leave them alone`. Without the anchor `keeps its own
 * seam` reads as a refusal and the sentence's paths are silently dropped —
 * which is the #1020 regression this whole module exists to prevent, caused
 * by the widening intended to fix the opposite bug. `alone` / `as is` / the
 * predicate adjectives keep no anchor: they are not ordinary English nouns.
 */
const CLAUSE_START = String.raw`(?:^|[.!?;:]\s*|[-—]\s*|,\s*)`;

const NEGATIONS: RegExp[] = [
  // Auxiliary refusals — unambiguous anywhere in the sentence.
  /\b(?:do\s+not|don'?t|does\s+not|doesn'?t|never|not\s+to\s+|must\s+not|may\s+not|cannot|can'?t|avoid|instead\s+of|rather\s+than|without|forbid|prohibit|refus|reject|excluded?|out\s+of\s+scope)\b/i,
  // Clause-initial "no …" — anchored, because the issue's own prose uses a
  // mid-sentence ", not the spawn path" to qualify rather than to forbid.
  /(?:^|[.!?;:]\s*|[-—]\s*)no\s+\w*(?:t|d)\b/i,
  /(?:^|[.!?;:]\s*|[-—]\s*)no\s+(?:such|longer|changes?\b|commits?\b|tests?\b|files?\b|work\b|edits?\b|paths?\b|code\b|updates?\b|modif)/i,
  // "keep/leave/skip <path>" or "leave it alone" — never `keep their tests`.
  new RegExp(
    `\\b(?:keep|keeps|keeping|kept|left|leave|leaving|skips?)\\s+(?:${PATH_WORD.source}|${CLAUSE_START}${REFUSAL_WORD}|(?:^|\\s)(?:alone|as\\s+is|as-is|untouched|unchanged))\\b`,
    "i",
  ),
  // "keep X up to date" — a maintenance obligation, not a fence.
  /\b(?:keep|keeps|keeping|kept)\s+[\w./@-]*[\w./@-]\s+up(?:\s+to\s+date)?\b/i,
  // A predicate adjective at the end of the sentence, or hard against a path.
  // `intact` is deliberately NOT in these two lists, where an unanchored
  // predicate adjective does its damage: "the plan holds the report intact for
  // the caller" and "the change leaves src/behaviour.ts behaviour intact" are
  // ordinary English about a RESULT, and a pass that read either as a refusal
  // would drop a requirement sentence — the #1020 regression, reproduced by the
  // widening intended to fix its opposite. `intact` is caught by the two
  // explicit idioms below, which name the verb that means refusal.
  /(?:\s|^)(?:untouched|unchanged|unmodified|unaltered|as\s+is|as-is|off-?limits?|off\s+limits?|frozen|preserved)(?:\s*[.,;:!?)]|$)/i,
  new RegExp(
    `(?:\\s|^)(?:untouched|unchanged|unmodified|unaltered|as\\s+is|as-is|off-?limits?|off\\s+limits?|frozen|preserved)\\s+${PATH_TAIL}`,
    "i",
  ),
  // "remains / stays" + a predicate adjective — "X remains unchanged". The
  // verb is what makes these refusals, so `intact` is safe here.
  /\b(?:remains|remain|stays|stay)\s+(?:untouched|unchanged|unmodified|unaltered|as\s+is|as-is|the\s+same|same|off-?limits?|frozen|preserved|intact)\b/i,
  // "is/was left <predicate>" — the passive, which is genuinely a refusal.
  /\b(?:is|was)\s+left\s+(?:untouched|unchanged|unmodified|unaltered|as\s+is|as-is|the\s+same|same|off-?limits?|frozen|preserved|intact)\b/i,
  // "X is not modified" / "X must stay intact" — the two shapes a spec writes a
  // constraint in that name no refusal verb, so nothing above catches them.
  // `not` alone is not enough (a requirement reads "X is not yet wired"), so the
  // verb is enumerated; and `intact` is admitted only behind a copula plus
  // stay/remain/leave, never as a bare predicate — the anchored-result reason.
  /\b(?:is|are|was|were|shall|should|must|will|be)\s+not\s+(?:modified|touched|changed|edited|updated|altered|revised)\b/i,
  /\b(?:must|shall|should|will|is|are|was|were|be|remains?|stays?)\s+(?:stay|remain|keep|keeps|kept|leave|leaves|left)\s+intact\b/i,
  // "extension/src/x.ts, intact" — the file named first, the refusal after a
  // clause boundary. Anchored for the same reason the bare predicate is not.
  /(?:^|[.!?;:]\s*|[-—]\s*|,\s*)intact\b/i,
  // "X is not part of this change" — bare `not` is NOT enough (a requirement
  // can read "X is not yet wired"), so the whole exclusion idiom is matched.
  /\b(?:not|never)\s+(?:part\s+of|in\s+the\s+scope\s+of|covered\s+by|touched\s+by|affected\s+by|in\s+scope\s+for)\b/i,
  // Adjectives that are prohibitions wherever they appear.
  /\b(?:off-?limits?|do-not-touch|hands\s+off|frozen)\b/i,
];

/** True when the sentence refuses an action — its paths stay fenced. */
export function isProhibition(sentence: string): boolean {
  return NEGATIONS.some((re) => {
    re.lastIndex = 0;
    return re.test(sentence);
  });
}

/**
 * What a read that FAILED must be reported as (#1167 round-4), shaped to sit
 * beside `unresolvedIdentifierNote` in the operator's plan. A failed read is
 * never a no-match, and the plan must not claim one.
 */
export function couldNotResolveNote(name: string, why: string): string {
  return `could not resolve ${name}: ${why} — left fenced (a failed read is not a no-match)`;
}

/** Tokens that look like a repo path: they carry a `/` or a source extension. */
const PATH_LIKE = new RegExp(`[/]|\\.(?:${SRC_EXT})$`, "i");

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
  for (const line of stripCodeBlocks(body).split("\n")) {
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
  return issueNamedTokensWithRejections(body).tokens;
}

/**
 * `issueNamedTokens` plus the path-shaped tokens it REFUSED.
 *
 * The distinction is the point (#1167 round-3): an issue that named no path
 * and an issue whose every path was absolute, traversing or riddled with shell
 * metacharacters produced the same empty extraction, so the plan looked clean
 * for the wrong reason and nobody could tell which had happened. The rejected
 * list is what lets the pass say "we refused these" instead of saying nothing.
 */
export function issueNamedTokensWithRejections(body: string): {
  tokens: string[];
  rejected: string[];
} {
  const tokens = new Set<string>();
  const rejected = new Set<string>();
  for (const section of decisionSectionsOf(body)) {
    for (const sentence of section.split(/(?<=[.!?])\s+|\n+/)) {
      if (isProhibition(sentence)) continue;
      // `/` is NOT a delimiter here: it is what distinguishes a path
      // (`extension/src/dispatch.ts`) from a `symbol/symbol` pair
      // (`dispatchCore/startJob`), and real issue bodies use both forms.
      for (const raw of sentence.split(/[\s,;(){}[\]|]+/)) {
        const token = raw.replace(/^["'`*]+|["'`*.,:]+$/g, "").trim();
        if (token.length < 2 || token.length > 200) continue;
        // #1167 round-3 — a token that CARRIES a glob is a refusal, not a
        // non-event. The plan routinely fences with a glob (`dispatch-deck*.ts`,
        // `agents-base/**`), so the pass has to be able to say "the issue
        // pointed at files and a pattern names none of them" instead of
        // producing the same empty extraction as an issue that named nothing.
        // The token is recorded and then dropped, exactly as it always was —
        // a glob never unfences.
        if (GLOB.test(token)) {
          if (token.includes("/")) rejected.add(token);
          continue;
        }
        // A path may carry a planner-style annotation (`src/a.ts (new)`) or
        // prose punctuation — normalise before deciding it is a path.
        const path = PATH_LIKE.test(token) ? normaliseDeclaredPath(token) : "";
        if (path && PATH_LIKE.test(path) && !GLOB.test(path)) {
          if (looksLikeFilePath(path)) {
            // #1167 round-3 — `looksLikeFilePath` is the guard that rejects an
            // absolute, `..`-traversing or metacharacter token, and the
            // `continue` below meant such a token vanished without a trace:
            // downstream indistinguishable from an issue that named no path at
            // all. The pass needs the refusal to be *said*, so it is handed over
            // here — and never added to the set that can move a fence.
            if (!isPlainRepoRelativePath(path) || GLOB.test(path)) rejected.add(path);
            else tokens.add(path);
            continue;
          }
          // Path-LIKE but not a file (`dispatchCore/startJob`, `docs`): the
          // `/`-separated halves are symbol names, checked below.
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
  return { tokens: [...tokens], rejected: [...rejected] };
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
  // #1167 round-3 — the shape refusals are reported by the caller (see
  // `issueNamedTokensWithRejections`), so this stays a pure predicate.
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

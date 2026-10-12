/**
 * review-findings-match — the pure identity half of the per-branch
 * review-findings memory (#1105).
 *
 * A finding is identified from the HEAD FILE CONTENT, never from the diff, so
 * its identity survives line shifts: an insertion above a function moves the
 * cited line but not the function that encloses it.
 *
 *   - anchor      — the nearest declaration at or above the cited line
 *                   (function/class/method/fn/def/impl/interface/type/const
 *                   arrow), normalised to its identifier; `file` when none.
 *   - titleClass  — the lowercased title, stopwords removed, tokens sorted.
 *   - snippetHash — hash of the whitespace-normalised code ±2 lines around the
 *                   cited line. A finding with no resolvable line uses the
 *                   hash of the empty string and NEVER matches on it.
 *
 * A finding matches a stored row only when path and anchor are equal AND
 * (titleClass equal OR title-token Jaccard ≥ 0.6). A snippet match alone never
 * matches: two distinct findings on one line share a snippet, and a second
 * finding must get its own row (so it can be accepted separately). Storage and
 * I/O live in review-findings-store.ts; this module touches neither git nor the
 * disk.
 */

import { createHash } from "node:crypto";

/** Title-token Jaccard similarity at which two titles name the same finding. */
export const JACCARD_MATCH = 0.6;
/** Lines of context on each side of the cited line in the snippet hash. */
export const SNIPPET_RADIUS = 2;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "no",
  "not",
  "of",
  "on",
  "or",
  "the",
  "this",
  "that",
  "to",
  "when",
  "with",
]);

/** Declaration shapes, tried in order; the first capture is the identifier. */
const DECLARATIONS: readonly RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:function|fn|def|class|interface|type|impl|struct|enum|trait)\s+(?:<[^>]*>\s*)?([A-Za-z_$][\w$]*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
  /^\s*(?:(?:public|private|protected|static|async|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
];

/** Control-flow words a method-shaped line can open with (`if (x) {`). */
const NOT_A_DECLARATION = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "else",
  "do",
  "with",
  "function",
]);

/** The identity a finding carries; `path`, `anchor`, `titleClass`, `snippetHash` are the stored keys. */
export interface FindingIdentity {
  path: string;
  anchor: string;
  titleClass: string;
  title: string;
  snippetHash: string;
  /** True only when the cited line exists in the head file. */
  hasLine: boolean;
}

/** The fields of a stored row identity matching reads. */
export interface MatchableRow {
  id: string;
  path: string;
  anchor: string;
  titleClass: string;
  title: string;
  snippetHash: string;
  lastSeen: number;
}

/** SHA-256 of `text`, first 16 hex chars — enough to tell two snippets apart. */
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Lowercased, stopword-free, de-duplicated, sorted title tokens. */
export function titleTokens(title: string): string[] {
  const tokens = new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
  return [...tokens].sort();
}

/** The title class: its tokens joined in sorted order. */
export function titleClassOf(title: string): string {
  return titleTokens(title).join(" ");
}

/** Jaccard similarity of two token lists; 0 when either is empty. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared++;
  const union = new Set([...sa, ...sb]).size;
  return shared / union;
}

/** The declared identifier on one line, or undefined when it declares nothing. */
function declarationName(text: string): string | undefined {
  for (const re of DECLARATIONS) {
    const name = re.exec(text)?.[1];
    if (name && !NOT_A_DECLARATION.has(name)) return name;
  }
  return undefined;
}

/**
 * The anchor for a cited line: the nearest declaration at or above it in the
 * head file, or `file` when there is none (or no line).
 */
export function anchorAt(lines: readonly string[], line: number | undefined): string {
  if (!line || line < 1) return "file";
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const name = declarationName(lines[i] ?? "");
    if (name) return name;
  }
  return "file";
}

/** Whitespace-normalised code of the snippet around the cited line, hashed. */
export function snippetHashAt(lines: readonly string[], line: number | undefined): string {
  if (!line || line < 1 || line > lines.length) return hashText("");
  const lo = Math.max(0, line - 1 - SNIPPET_RADIUS);
  const hi = Math.min(lines.length, line + SNIPPET_RADIUS);
  const body = lines
    .slice(lo, hi)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .join("\n");
  return hashText(body);
}

/**
 * The identity of one finding against the head file's lines. An empty
 * `lines` (head file unreadable, or path deleted at head) yields `file` and
 * the empty-snippet hash with `hasLine: false`.
 */
export function identityOf(
  f: { path: string; line?: number; title: string },
  lines: readonly string[],
): FindingIdentity {
  const resolvable = !!f.line && f.line >= 1 && f.line <= lines.length;
  const line = resolvable ? f.line : undefined;
  return {
    path: f.path,
    anchor: anchorAt(lines, line),
    titleClass: titleClassOf(f.title),
    title: f.title,
    snippetHash: snippetHashAt(lines, line),
    hasLine: resolvable,
  };
}

/** True when a finding identity names the same finding as a stored row. */
export function sameIdentity(id: FindingIdentity, row: MatchableRow): boolean {
  if (row.path !== id.path || row.anchor !== id.anchor) return false;
  if (id.titleClass !== "" && row.titleClass === id.titleClass) return true;
  return jaccard(titleTokens(id.title), titleTokens(row.title)) >= JACCARD_MATCH;
}

/**
 * The stored row a finding matches, or undefined (a new finding). Among
 * several matches the equal-snippet row wins (only for a finding with a
 * resolvable line), then the most recently seen.
 */
export function pickMatch<R extends MatchableRow>(
  id: FindingIdentity,
  rows: readonly R[],
): R | undefined {
  let best: R | undefined;
  let bestSnippet = false;
  for (const row of rows) {
    if (!sameIdentity(id, row)) continue;
    const snippetEqual = id.hasLine && row.snippetHash === id.snippetHash;
    if (
      !best ||
      (snippetEqual && !bestSnippet) ||
      (snippetEqual === bestSnippet && row.lastSeen > best.lastSeen)
    ) {
      best = row;
      bestSnippet = snippetEqual;
    }
  }
  return best;
}

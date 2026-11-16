/**
 * work-driver-verify-develop-provenance-token — the classifier and the display forms for
 * one provenance token, split out of `work-driver-verify-develop-provenance.ts` along the
 * seam between *reading a tree* and *judging a string*.
 *
 * The gate module's job is git: pin one OID, list the added files, read their committed
 * bytes. This module's job is a string it has already read, and it has exactly one rule to
 * get right — which tokens this build may call absent and which it may only disclose. That
 * rule is why the split is here rather than inline: every judgement in this file is made
 * against the RAW bytes, before any normalisation, and a reader checking it should not have
 * to hold the git plumbing beside it.
 *
 * Leaf by policy: imports only the path helpers and the markdown neutraliser, so widening
 * the gate's dependency graph is not possible through this file.
 */

import { neutraliseMarkdownField } from "../../../src/comment-evidence.ts";
import { normaliseRelPath, pathProblem } from "../../../src/lean/specify-path.ts";
import { oneLine } from "../../../src/lean/text-fence.ts";

/** One row of the classification: what to do with one token under one key. A probe
 * candidate is carried verbatim — a backslash token's only defect is the character the
 * command tier refuses for EXECUTION, and `\` is a legal byte in a git path, so normalising
 * it away would read `a\b` and `ab` as one file. */
export type Classified = { kind: "probe"; probe: string } | { kind: "unverifiable"; why: string };

/** Why a token is not a repo-relative path this gate may probe, or undefined when it is.
 *
 * The absolute forms are tested on the RAW string, before any normalisation:
 * `normaliseRelPath("/etc/passwd")` yields `etc/passwd`, and a classifier that normalised
 * first would read an absolute host path as a safe repo-relative token. A token whose ONLY
 * defect is a backslash is a probe candidate — `\` is a legal byte in a git path, so
 * refusing it would disclose a real file as host provenance.
 */
function tokenProblem(token: string): string | undefined {
  if (token.startsWith("/") || token.startsWith("\\")) return "absolute path";
  if (/^[a-zA-Z]:[\\/]/.test(token)) return "drive-letter path";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token)) return "URL";
  if (/\s/.test(token)) return "text containing whitespace";
  if (/["'`$;&|<>`]/.test(token)) return "a character the runner would have to quote";
  if (token.includes("\\")) return undefined; // backslash-only defect: a probe candidate
  if (!/^[A-Za-z0-9._/-]+$/.test(token)) return "not a plain repo-relative file path";
  const rel = normaliseRelPath(token);
  if (rel === "") return "empty path";
  return pathProblem(rel);
}

/** What the gate does with one string value: probe it for existence, or disclose it. */
export function classifyToken(token: string): Classified {
  const why = tokenProblem(token);
  if (why !== undefined) return { kind: "unverifiable", why };
  return { kind: "probe", probe: token };
}

/** A display field: one line, no control characters, no markdown structure the record's own
 * bytes could open in the PR body, and clipped. The value is a string the develop child
 * authored, printed into a pull request. */
export function display(text: string): string {
  return neutraliseMarkdownField(oneLine(text, 160));
}

/** A display field inside inline code: backticks cannot open a span, and a token that
 * contained one would otherwise splice markup into the bullet. */
export function code(text: string): string {
  return `\`${display(text).replace(/`/g, "\u02cb")}\``;
}

/** The keys whose string values this gate treats as claims about committed files. One
 * constant, so extending the rule is one deliberate source edit and every reader of the gate
 * sees the same set — the walk and the git-judging gate both import it from here. */
export const PROVENANCE_KEYS: readonly string[] = [
  "source",
  "sourceFile",
  "sourcePath",
  "sources",
  "input",
  "inputFile",
  "resultsFile",
];

/** Unique tokens judged per workstream. Past it the rest is disclosed, never judged. */
export const PROVENANCE_MAX_TOKENS = 256;

/** The dedupe identity of one candidate token. Key and value are joined with a NUL, which no
 * JSON string can carry, so two distinct (key, value) pairs can never collapse into one
 * identity. Shared by the walker and its caller so the budget is counted the same way in both
 * — a second spelling of this is a second source of truth for what "the same token" means. */
export function provenanceTokenId(key: string, token: string): string {
  return `${key}\u0000${token}`;
}

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

import { neutraliseMarkdownField } from "./comment-evidence.ts";
import { normaliseRelPath, pathProblem } from "./lean/specify-path.ts";
import { oneLine } from "./lean/text-fence.ts";

/** One row of the classification: what to do with one token under one key. A probe
 * candidate is carried verbatim — a backslash token's only defect is the character the
 * command tier refuses for EXECUTION, and `\` is a legal byte in a git path, so normalising
 * it away would read `a\b` and `ab` as one file. */
export type Classified = { kind: "probe"; probe: string } | { kind: "unverifiable"; why: string };

/** The characters a token may not carry: every one of them would need quoting by the command
 * tier, and a few (`<`, `>`, `|`) are also the characters a markdown table or an HTML comment is
 * typed with. ONE rule, shared by the bare-token classifier and the prose arm's fragment
 * classifier, so a fragment extracted from a value can never be probed under a rule the whole
 * value would have been refused by — which is what stops a bar-separated value from being judged
 * as its middle word. */
const HOSTILE_CHARS = /["'`$;&|<>`]/;

/** Why a token is refused for the characters it carries, or undefined when it carries none. */
export function hostileCharactersProblem(token: string): string | undefined {
  return HOSTILE_CHARS.test(token) ? "a character the runner would have to quote" : undefined;
}

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
  const hostile = hostileCharactersProblem(token);
  if (hostile !== undefined) return hostile;
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

/**
 * Is this extracted fragment host context rather than a claim about the repository?
 *
 * The order is the whole point and it is binding: host-context classification runs BEFORE
 * {@link tokenProblem}. The bare-token arms route an absolute path, a drive letter and a
 * `scheme://` URL to their own reasons, and a `$VAR/…` fragment to "a character the runner would
 * have to quote" — reaching those arms from a prose fragment would disclose `$S/ops/c5-qual`
 * with the wrong sentence, and the reason string is what an operator reads. So a fragment that
 * is host context is answered here, with the same reason the shipped classifier gives, and never
 * reaches a probe.
 *
 * Only a fragment this returns `undefined` for is a candidate: a repo-relative path, or a bare
 * basename with an extension. `a|b|c` survives to {@link tokenProblem}, whose quote-character arm
 * refuses it — which is why a bar-separated value is disclosed rather than probed as its middle
 * word.
 */
export function hostContextProblem(fragment: string): string | undefined {
  const absolute = fragment.startsWith("/") || fragment.startsWith("\\");
  if (absolute) return "absolute path";
  if (/^[a-zA-Z]:[\\/]/.test(fragment)) return "drive-letter path";
  if (isUrlFragment(fragment)) return "URL";
  // `$VAR/…` and `${VAR}/…`: a run directory named by the environment, which this build has no
  // basis to resolve and no right to guess at. Answered with the classifier's own words so a
  // reader sees the same reason for a host path whether it arrived whole or inside a sentence.
  if (/^\$\{?[A-Za-z_]/.test(fragment)) {
    return "a character the runner would have to quote";
  }
  return undefined;
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
 * sees the same set — the walk and the git-judging gate both import it from here.
 *
 * `provenance` and `inputs` joined the set with #2295: the field case's record moved its claim
 * out of `source` and into a key the set did not carry, which is the same evasion the constant
 * exists to close and one that a per-call config would let a child choose for itself.
 * {@link PROVENANCE_KEYS_V0_14_85} is the seven names this shipped with before that, kept as its
 * own exported constant because the prose switch's off arm is defined as the v0.14.85 walk — the
 * two sets must both be nameable or the off arm could only be approximated. */
export const PROVENANCE_KEYS: readonly string[] = [
  "source",
  "sourceFile",
  "sourcePath",
  "sources",
  "input",
  "inputFile",
  "resultsFile",
  "provenance",
  "inputs",
];

/** The seven names {@link PROVENANCE_KEYS} shipped with at v0.14.85. It exists so
 * `PI_ENSEMBLE_VERIFY_PROVENANCE_PROSE=0` is the v0.14.85 walk rather than the current walk with
 * two keys blanked: the off arm passes THIS set to the walker, and
 * `test-verify-develop-provenance-prose-v85.ts` compares the off arm's whole output against the
 * shipped module's. */
export const PROVENANCE_KEYS_V0_14_85: readonly string[] = [
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

/** Candidates extracted from ONE whitespace-bearing value. A value is a sentence the child
 * wrote, and a sentence can carry a dozen path-shaped words; the ceiling bounds the git probes
 * one value can buy while leaving the everyday record ("X of y.ndjson via z.sh") well inside it.
 * Past the ceiling the remainder is disclosed as unjudged, never judged and never dropped. */
export const PROVENANCE_MAX_CANDIDATES_PER_VALUE = 8;

/** The separators a prose value is split on: whitespace and the brackets and punctuation an
 * inline citation is typed with. Every one of them is a character that cannot appear in a path
 * this gate would accept, so splitting on them cannot cut a real path in two — and the quote
 * characters are deliberately NOT separators, because a quoted path is exactly the fragment the
 * classifier below must refuse rather than silently repair by stripping its quotes. */
const FRAGMENT_SEPARATORS = /[\s(),;]+/;

/** Extensions this gate treats as a data file's own suffix, and therefore as a suffix a bare claim
 * may carry. Deliberately a list rather than "any dot and up to eight alphanumerics": the general
 * form turns ordinary English into probes — `v1.2.3` and `3.4.5` (versions), `v2` release tags —
 * and a probe of a token the record never claimed as data reddens a develop round over prose. A
 * measurement record cites a corpus or the script that produced it, and that is what this list
 * holds; prose that points a human at a `README` or a `.md` is a doc reference, not a corpus, so
 * markdown is deliberately NOT here. A slash still makes a fragment a candidate on its own, so an
 * unlisted suffix under a directory (`data/metrics.parquet`) is still judged. */
const DATA_SUFFIXES = [
  ".json",
  ".ndjson",
  ".jsonl",
  ".tsv",
  ".csv",
  ".log",
  ".txt",
  ".sh",
] as const;

/** Is `fragment`'s final component one of {@link DATA_SUFFIXES}, and not a whole name that merely
 * IS the suffix? A bare `.json` or `.log` is a hidden extension file or a stray dot, never the
 * basename a measurement record cites, and probing it buys a git read for a punctuation mark. */
function endsWithDataSuffix(fragment: string): boolean {
  const base = fragment.slice(fragment.lastIndexOf("/") + 1).toLowerCase();
  return DATA_SUFFIXES.some((suffix) => base.endsWith(suffix) && base !== suffix);
}

/** All of a fragment's `/`-separated components digits? `3/4`, `12/16` and `2/3` are how a ratio or
 * a fraction gets typed in a sentence, and they carry no claim on a file: a slash is path evidence
 * only when something on one side of it is NOT a bare number. A versioned path (`logs/2024/01/x.ndjson`,
 * `v2/1/run.log`) fails this test — one component carries letters or a dot — so the rule refuses
 * arithmetic and never a real path. */
function allNumericSegments(fragment: string): boolean {
  const parts = fragment.split("/");
  return parts.every((part) => /^[0-9]+$/.test(part));
}

/** Does this fragment name something a filesystem path could be? A `/` is the ordinary case and
 * is taken on its own — the gate has no basis to guess that `2024/01/summary.ndjson` is not a path,
 * and refusing a slashed fragment is how a real claim passes silently — except when every component
 * is a bare number, which is a ratio. A bare word, which carries no directory evidence at all, is
 * taken only when it ends in a {@link DATA_SUFFIXES} suffix: that catches the bare filename a
 * results record cites (`out.ndjson`), the shape the #256 record used and the one the tree-wide
 * basename probe exists for, while leaving `v1.2.3`, `3.4.5` and `README` as the prose they are.
 * Probing a word buys a failure for a word. */
function looksLikePathFragment(fragment: string): boolean {
  if (fragment.includes("/")) return !allNumericSegments(fragment);
  return endsWithDataSuffix(fragment);
}

/** A `scheme://` fragment is a URL, and a URL is context rather than a claim: the gate has no
 * probe for a remote object, so a candidate here could only ever be disclosed. Refusing it at
 * extraction is what keeps the disclosure count of a URL-bearing value at one row. */
function isUrlFragment(fragment: string): boolean {
  return (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(fragment) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(fragment)
  );
}

/**
 * The path-bearing fragments of one whitespace-bearing provenance value, in first-seen order,
 * deduped and capped at {@link PROVENANCE_MAX_CANDIDATES_PER_VALUE}.
 *
 * This is the arm #2295 exists for. A value like
 * `"elapsed_s of widened-results.ndjson ($S/ops/c5-qual) via scripts/run-c5.sh"` is one claim
 * about two files that v0.14.85 set aside whole as "text containing whitespace", so the record
 * passed. Splitting turns it into three candidates; the caller then classifies each one,
 * host-context first, and fails the ones git can answer absent.
 *
 * Deliberately NOT done here: any filesystem or git judgement. Deciding that `$S/ops/c5-qual` is
 * host context and that `a|b|c` must not be probed as `b` belongs to the classifier, which owns
 * the reason strings the disclosure carries — and this module is a leaf that imports neither
 * `node:fs` nor `node:path`, which is what makes a pure unit arm for the split reachable at all
 * (`test-verify-develop-provenance-prose.ts`).
 *
 * The cap counts DEDUPED fragments: a fragment that repeats spends no slot and produces no row,
 * so a value cannot fill the ceiling with one path repeated and hide the claims behind it.
 */
export function proseCandidatesOf(value: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(FRAGMENT_SEPARATORS)) {
    if (raw === "" || !looksLikePathFragment(raw) || isUrlFragment(raw)) continue;
    if (seen.has(raw)) continue;
    if (out.length >= PROVENANCE_MAX_CANDIDATES_PER_VALUE) break;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** A value that yielded NO candidate is not a claim this gate can judge — and it is not exempt
 * either: it is the whole value the gate declined, so the caller discloses it with the reason
 * the classifier gave for the value itself. */
export function yieldsNoCandidate(value: string): boolean {
  return proseCandidatesOf(value).length === 0;
}

/** The dedupe identity of one candidate token. Key and value are joined with a NUL, which no
 * JSON string can carry, so two distinct (key, value) pairs can never collapse into one
 * identity. Shared by the walker and its caller so the budget is counted the same way in both
 * — a second spelling of this is a second source of truth for what "the same token" means. */
export function provenanceTokenId(key: string, token: string): string {
  return `${key}\u0000${token}`;
}

/** The dedupe identity of one extracted FRAGMENT. It is the fragment alone — with no key —
 * because the claim a fragment makes is about the file it names, not about the key it sat under:
 * two rows of one corpus that cite the same absent file in different sentences are one claim.
 *
 * The `frag\0` prefix is load-bearing, not cosmetic. Without it the bare fragment string is the
 * identity, and that string is exactly what {@link provenanceTokenId} also produces for the
 * (key, value) pair whose key is `"frag"` — but worse, a fragment identical to a whole value under
 * any other key collides with that value's identity and is then never offered at all: the claim
 * vanishes with no probe, no failure, no note and no disclosure row. Prefixing the identity with a
 * marker a `key\0value` identity can never start with makes the two namespaces disjoint, so a
 * fragment and a whole value that carry the same bytes each get judged on their own. */
export function provenanceFragmentId(fragment: string): string {
  return `frag\u0000${fragment}`;
}

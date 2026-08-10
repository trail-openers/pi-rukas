/**
 * claim-scan — checkable factual particulars a diff asserts in prose, and
 * whether the repository backs them up.
 *
 * ## Why this is not a lens
 *
 * A `/work` run shipped a PR whose docs invented hardware specifications
 * ("Intel i7, 64 GB RAM") that appear nowhere in the repository. Six review
 * lenses returned one cosmetic LOW finding. The obvious remedy — a seventh
 * "documentation truth" lens — was researched and rejected:
 *
 *   - No shipping code reviewer has such a lane. Graphite alone has a
 *     "Documentation issue" category and its own docs demote it to a bullet
 *     under Logic bugs; Codacy's and DeepSource's "Documentation" categories
 *     mean *presence*, not truth. Where it exists at all (CodeRabbit) it is a
 *     separate pre-merge pass, not a lens.
 *   - Kang, Milliken & Yoo (arXiv:2406.14836) measured that existing
 *     code-comment consistency detectors have **no statistically significant
 *     relationship with comment accuracy**. Consistency detection is not truth
 *     detection, so a lens built on that premise would not have caught this.
 *
 * The decisive point is that an invented specification has **no oracle**. There
 * is nothing to compare it against — which is exactly what makes it mechanical:
 * the question is not "is this claim true?" (a judgment) but "does this token
 * occur anywhere in the repository outside the prose asserting it?" (a lookup).
 * That is `citationPresent` from #407 turned around: there, a judge's quote had
 * to exist in a document; here, a document's claim has to exist in the code.
 *
 * So there is no model in this path at all. A judge would have to run
 * *serially* before the lens prompts are built, and its "verification" of an
 * unsourced claim would check the quote against the very added lines being
 * flagged — proving only that it can copy-paste.
 *
 * ## The grounding rule
 *
 * A token is grounded when it occurs **outside the prose file(s) asserting
 * it** — in code, config, or tests — including lines this same diff added.
 *
 * Both halves of that rule are load-bearing, and getting either wrong makes the
 * check useless in opposite directions:
 *
 *   - **Same-diff code counts.** This project requires documentation to ship in
 *     the same PR as the behaviour it describes (AGENTS.md §7). A rule that
 *     ignored same-diff referents would fire on nearly every honest PR here: a
 *     README line citing `POLICY_JUDGE_TIMEOUT_MS` added alongside the constant
 *     itself would be flagged as unsourced.
 *   - **Prose does not ground prose.** If a doc asserting "Intel i7" could be
 *     grounded by that same doc, every invented specification would validate
 *     itself. Self-reference is not evidence.
 */

/** A prose file — where unsupported claims are asserted rather than executed. */
const PROSE_EXT = /\.(md|mdx|markdown|rst|txt|adoc|asciidoc)$/i;

export function isProseFile(path: string): boolean {
  return PROSE_EXT.test(path);
}

export type ClaimKind = "quantity" | "product" | "path" | "flag" | "env";

export interface ClaimCandidate {
  /** The checkable particular, verbatim as written. */
  token: string;
  kind: ClaimKind;
  /** The prose file that asserts it. */
  file: string;
  /** 1-indexed line in the post-change file. */
  line: number;
  /** The added line, trimmed — shown to the operator so the claim is legible. */
  context: string;
}

/**
 * Extractors, deliberately narrow.
 *
 * Each must pick out something a reader could look up and find, or not find.
 * "This module is well designed" is not extractable and is not this gate's
 * business; "64 GB" and `--merge` are.
 */
const EXTRACTORS: Array<{ kind: ClaimKind; re: RegExp }> = [
  // A number with a unit: 64 GB, 30s, 5 min, 99.9%.
  {
    kind: "quantity",
    re: /\b\d+(?:\.\d+)?\s?(?:GB|MB|KB|TB|GHz|MHz|ms|s|min|mins|minutes?|hours?|days?|%)\b/gi,
  },
  // A brand followed by an alphanumeric model: "Intel i7", "Apple M2".
  // The model token must mix letters and digits, so "Section 3" and "Figure 2"
  // — which are references, not specifications — do not match.
  { kind: "product", re: /\b[A-Z][a-zA-Z]{2,}\s+(?=[A-Za-z]*\d)[A-Za-z][A-Za-z0-9-]{1,}\b/g },
  { kind: "flag", re: /(?<![\w-])--[a-z][a-z0-9-]{2,}\b/g },
  // SCREAMING_SNAKE_CASE — env vars and exported constants.
  { kind: "env", re: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/g },
  // A path with a directory component and a file extension.
  { kind: "path", re: /(?<![\w/])[a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+\.[a-zA-Z]{1,5}\b/g },
];

/**
 * Tokens never worth grounding: they are language, not claims.
 *
 * Two whole extractor kinds were removed here for the same reason, after
 * running this scan against its own PR — the cheapest possible measurement,
 * and it found both immediately:
 *
 *   - **URLs.** An external link (`https://arxiv.org/abs/2406.14836`) has no
 *     repo referent by construction, so flagging it is always a false positive.
 *   - **Bare version strings.** `\bv?\d+\.\d+\b` matched the numeric part of
 *     that same arXiv ID, and matches any decimal in prose. A wrong version
 *     number is a contradiction, which is the lens's job now that it is given
 *     the file — not a grounding question.
 *
 * Rhetorical percentages are the same class, and cheap to name outright.
 */
const IGNORED = new Set(["100%", "0%", "50%"]);

/** Upper bound on candidates per scan, so a huge docs PR cannot fan out grep. */
export const MAX_CANDIDATES = 40;

/**
 * Extract checkable particulars from the lines a unified diff ADDS to prose
 * files. Pure — no I/O, so the extraction rules are directly testable.
 *
 * Only added lines are considered: this gate asks what the diff introduced, not
 * what the repository already lived with.
 */
export function extractClaimCandidates(diff: string, limit = MAX_CANDIDATES): ClaimCandidate[] {
  const out: ClaimCandidate[] = [];
  const seen = new Set<string>();
  let file = "";
  let newLine = 0;
  let inProse = false;
  // Fenced blocks are examples, not assertions — the same "quoting is not
  // asserting" rule #407 relies on for doctrine files. Tracked as state, since
  // it is the lines INSIDE the fence that must be skipped, not the ``` itself.
  let inFence = false;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).replace(/^b\//, "").trim();
      file = p === "/dev/null" ? "" : p;
      inProse = file.length > 0 && isProseFile(file);
      inFence = false;
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff --git ")) continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      newLine = Number.parseInt(hunk[1] ?? "1", 10);
      continue;
    }
    if (!inProse) continue;
    if (raw.startsWith("-")) continue;
    if (!raw.startsWith("+")) {
      newLine++;
      continue;
    }

    const text = raw.slice(1);
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      newLine++;
      continue;
    }
    // Inside a fence, or indented four spaces — both are code blocks in
    // Markdown, and an example is not a claim.
    if (inFence || /^\s{4,}\S/.test(text)) {
      newLine++;
      continue;
    }

    for (const { kind, re } of EXTRACTORS) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const token = m[0].trim();
        if (token.length < 2 || IGNORED.has(token.toLowerCase()) || IGNORED.has(token)) continue;
        const key = `${file}::${token.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ token, kind, file, line: newLine, context: text.trim().slice(0, 240) });
        if (out.length >= limit) return out;
      }
    }
    newLine++;
  }
  return out;
}

/**
 * Files containing `token`, repo-relative. Injected so this module stays pure
 * and offline-testable; the production implementation is a `git grep` at the
 * branch ref.
 */
export type GroundingLookup = (token: string) => Promise<string[]>;

export interface UngroundedClaim extends ClaimCandidate {
  /** Prose files that mention it — never grounding, recorded for the message. */
  proseHits: string[];
}

/**
 * Partition candidates into grounded and ungrounded, applying the rule in this
 * module's header: a hit only grounds a claim if it lands outside the prose.
 *
 * A lookup that throws is treated as "could not tell" and the claim is dropped,
 * never reported. An unreadable repository is not evidence that a claim is
 * fabricated, and this gate blocks merges — it must never manufacture a finding
 * out of its own failure.
 */
export async function groundClaims(
  candidates: readonly ClaimCandidate[],
  lookup: GroundingLookup,
): Promise<UngroundedClaim[]> {
  const out: UngroundedClaim[] = [];
  for (const c of candidates) {
    let hits: string[];
    try {
      hits = await lookup(c.token);
    } catch {
      continue;
    }
    const nonProse = hits.filter((h) => h.length > 0 && !isProseFile(h));
    if (nonProse.length > 0) continue;
    out.push({ ...c, proseHits: hits.filter((h) => h.length > 0) });
  }
  return out;
}

/** Operator-facing description of an unsourced claim. */
export function explainUngrounded(c: UngroundedClaim): string {
  const where =
    c.proseHits.length > 0
      ? ` It appears only in prose (${c.proseHits.slice(0, 3).join(", ")}), which does not ground it.`
      : " It appears nowhere else in the repository.";
  return `This line introduces \`${c.token}\`, a ${c.kind} that nothing in the code, config or tests backs up.${where} Either point it at something real, or remove it — an unsourced specification reads as fact to everyone downstream.`;
}

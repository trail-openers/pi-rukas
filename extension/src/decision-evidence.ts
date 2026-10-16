/**
 * decision-evidence — the evidence check behind a `replace` seam (#1308),
 * generalised from the policy judge's verbatim-citation rule (#407).
 *
 * A model answer that is allowed to *become* the outcome must quote the text
 * it relied on, and that text must be found — modulo formatting — in a
 * text the caller vouched for or in a file it names. Existence is a hallucination
 * guard, not a relevance guard; that limit is accepted (see
 * work-driver-policy.ts).
 *
 * Named files resolve only inside the repo root after `realpath`, and only
 * regular files up to `MAX_EVIDENCE_FILE_BYTES` are read (operator decision
 * 4). A path outside the root, a symlink that escapes it, a missing file, an
 * oversized one or no repo root at all — every one of those fails the check.
 *
 * ## The quote must be a whole sentence (#1381)
 *
 * Existence alone was not enough. `citationPresent` used to be a normalised
 * `includes()`, so any substring of a doctrine file of twelve characters or
 * more verified — which let a merge grant be honoured on *"LLMs / agents are
 * allowed to squash merge PRs"*, the permission clause of a sentence whose
 * own leading conditional ("If all project quality gates have been met …")
 * was the condition for it. The quote must now equal one whole
 * `citationUnits()` of the document, so a clause is never evidence for the
 * sentence that contains it. Headings, fenced code and table rows are not
 * units at all: they are structure and examples, not a document asserting a
 * rule in its own voice.
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Normalise text for citation comparison.
 *
 * Verbatim "modulo formatting": a judge that copies a sentence spanning a line
 * wrap, or drops the `**` around a bolded word, is quoting honestly and should
 * pass. A judge that invents a sentence should not. Markdown emphasis, list
 * bullets and whitespace runs are therefore flattened, and nothing else is.
 */
export function normaliseForCitation(s: string): string {
  return s
    .replace(/[*_`]/g, "")
    .replace(/^\s*[-+*>]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The closed set of final-period tokens that never end a sentence. A period
 * inside one of these is not a boundary, however it looks to a naive splitter.
 */
const SENTENCE_ABBREVIATIONS = new Set(["e.g.", "i.e.", "etc.", "vs.", "cf."]);

/**
 * The whole-sentence units of a document — the strings a quote may equal.
 *
 * Two kinds, and nothing else:
 *
 *   - a sentence of a paragraph, ended by `.`/`!`/`?` followed by whitespace
 *     or end of text (the closed abbreviation set above never ends one), and
 *   - the whole content of a markdown list item, which is **never** split on
 *     interior punctuation — a bullet is one assertion, and splitting it would
 *     hand back the fragments this rule exists to refuse.
 *
 * Markdown headings, fenced code blocks and table rows are excluded outright.
 * A heading is a title rather than a claim; a fenced block is an example, and
 * this repo's own `AGENTS.md` fences a `BREAKING CHANGE:` line a judge could
 * quote as if it were a rule; a table row is cells, not prose.
 *
 * Splitting runs on the RAW source and each unit is normalised afterwards —
 * `normaliseForCitation` flattens newlines and bullets, so a boundary derived
 * after it could not tell a list item from a wrapped continuation.
 */
export function citationUnits(text: string): string[] {
  const units: string[] = [];
  let inFence = false;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    for (const sentence of splitParagraph(paragraph.join(" "))) units.push(sentence);
    paragraph = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (/^\s*#/.test(line)) {
      flush();
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      continue;
    }
    if (/^\s*[-+*>]\s+/.test(line)) {
      flush();
      const item = line.replace(/^\s*[-+*>]\s+/, "").trim();
      if (item) units.push(item);
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return units
    .map(normaliseForCitation)
    .filter((u) => u.length > 0)
    .sort((a, b) => b.length - a.length);
}

/** Split a joined paragraph into sentences, honouring the abbreviation set. */
function splitParagraph(paragraph: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < paragraph.length; i++) {
    if (!".!?".includes(paragraph[i] ?? "")) continue;
    const after = paragraph[i + 1];
    if (after !== undefined && !/\s/.test(after)) continue;
    // `etc.)` ends no sentence: the closed set counts with or without a
    // closing bracket, which is how this repo's own §9 grant is written.
    const before = paragraph.slice(start, i + 1).replace(/[)\]]+$/, "");
    const lastToken = before.slice(before.lastIndexOf(" ") + 1);
    if (SENTENCE_ABBREVIATIONS.has(lastToken)) continue;
    const sentence = paragraph.slice(start, i + 1).trim();
    if (sentence) out.push(sentence);
    start = i + 1;
  }
  const tail = paragraph.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Does `quote` appear in `text` as one whole sentence?
 *
 * Equality against `citationUnits`, not substring containment: a real clause
 * of a conditioned sentence is a partial quote, and a partial quote of a grant
 * is not the grant. The ≥12-char floor stays as its own guard — a short quote
 * is not evidence whatever it matches.
 */
export function citationPresent(quote: string, text: string): boolean {
  const q = normaliseForCitation(quote);
  // A trivially short "quote" would match almost anything; it is not evidence.
  if (q.length < 12) return false;
  return citationUnits(text).includes(q);
}

/** 256 KiB — a cited file larger than this is not read, and the check fails. */
export const MAX_EVIDENCE_FILE_BYTES = 256 * 1024;

export interface EvidenceCheck {
  /**
   * The parts of the state the caller vouches for as evidence — e.g. the
   * documents it read itself. Never the whole state: state carries untrusted
   * text, and a quote of injected text must not be able to justify a replace.
   */
  texts?: readonly { name: string; text: string }[];
  /** Enables citing a file by path. Without it, a cited name must be one of `texts`. */
  repoRoot?: string;
}

export interface EvidenceResult {
  passed: boolean;
  reason: string;
  /** The supplied text the quote was found in, named as the caller supplied it. */
  matchedName?: string;
}

/** Read a repo-confined file, bounded. Undefined on anything unsafe or unreadable. */
async function readConfined(repoRoot: string, cited: string): Promise<string | undefined> {
  try {
    const root = await fs.realpath(repoRoot);
    const real = await fs.realpath(path.resolve(root, cited));
    const rel = path.relative(root, real);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    const st = await fs.stat(real);
    if (!st.isFile() || st.size > MAX_EVIDENCE_FILE_BYTES) return undefined;
    return await fs.readFile(real, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Verify a model's quote. `cited` is the source the model named, if any: a
 * named text when one matches (case-insensitive), else a repo-confined file.
 */
export async function verifyEvidence(
  check: EvidenceCheck | undefined,
  quote: string | undefined,
  cited: string | undefined,
): Promise<EvidenceResult> {
  if (!check) return { passed: false, reason: "the seam supplied no evidence check" };
  if (!quote?.trim()) return { passed: false, reason: "the answer quoted nothing" };
  const texts = check.texts ?? [];
  const named = cited?.trim();
  if (!named) {
    const hit = texts.find((t) => citationPresent(quote, t.text));
    return hit
      ? { passed: true, reason: "the quote was found in a supplied text", matchedName: hit.name }
      : { passed: false, reason: "the quote does not appear in any supplied text" };
  }
  const candidates = texts.filter((t) => t.name.toLowerCase() === named.toLowerCase());
  if (candidates.length > 0) {
    const hit = candidates.find((t) => citationPresent(quote, t.text));
    return hit
      ? { passed: true, reason: `the quote was found in ${hit.name}`, matchedName: hit.name }
      : { passed: false, reason: `the quote does not appear in ${named}` };
  }
  if (!check.repoRoot) {
    return { passed: false, reason: `'${named}' is not one of the supplied texts` };
  }
  const file = await readConfined(check.repoRoot, named);
  if (file === undefined) {
    return {
      passed: false,
      reason: `'${named}' is not a readable file inside the repo root (≤ ${MAX_EVIDENCE_FILE_BYTES} bytes)`,
    };
  }
  return citationPresent(quote, file)
    ? { passed: true, reason: `the quote was found in ${named}`, matchedName: named }
    : { passed: false, reason: `the quote does not appear in ${named}` };
}

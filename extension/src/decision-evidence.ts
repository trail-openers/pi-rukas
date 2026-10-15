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

/** Does `quote` actually appear in `text`? */
export function citationPresent(quote: string, text: string): boolean {
  const q = normaliseForCitation(quote);
  // A trivially short "quote" would match almost anything; it is not evidence.
  if (q.length < 12) return false;
  return normaliseForCitation(text).includes(q);
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

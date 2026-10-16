/**
 * decision-evidence — the evidence check behind a `replace` seam (#1308),
 * generalised from the policy judge's verbatim-citation rule (#407).
 *
 * A model answer that is allowed to *become* the outcome must quote the text
 * it relied on, and that text must be found — modulo formatting — in a text the
 * caller vouched for or in a file it names. Existence is a hallucination guard,
 * not a relevance guard; that limit is accepted (see work-driver-policy.ts).
 *
 * Named files resolve only inside the repo root after `realpath`, and only
 * regular files up to `MAX_EVIDENCE_FILE_BYTES` are read (operator decision 4).
 * A path outside the root, a symlink that escapes it, a missing file, an
 * oversized one or no repo root at all — every one of those fails the check,
 * and each says which of them it was (see {@link readConfined}).
 *
 * ## The quote must be a whole sentence (#1381)
 *
 * Existence alone was not enough. `citationPresent` used to be a normalised
 * `includes()`, so any substring of a doctrine file of twelve characters or more
 * verified — which let a merge grant be honoured on *"LLMs / agents are allowed
 * to squash merge PRs"*, the permission clause of a sentence whose own leading
 * conditional ("If all project quality gates have been met …") was the condition
 * for it. The quote must now equal one whole `citationUnits()` of the document,
 * so a clause is never evidence for the sentence that contains it.
 *
 * What a unit *is* — which markdown constructs count and which are only
 * structure — is the splitter's contract, and lives in citation-units.ts. This
 * module's job is the check: classify the quote, read the cited file, and say
 * honestly which failure occurred.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { citationUnits, normaliseUnit } from "./citation-units.ts";

// The splitter's two entry points re-exported so every caller — including the
// policy judge and the smoke tests — keeps one definition of what a unit is and
// how one is normalised, imported from where the check lives.
export { citationUnits } from "./citation-units.ts";

/**
 * Normalise text for citation comparison.
 *
 * Re-exported from the splitter so the flattening a unit is built with and the
 * flattening a quote is compared with cannot drift apart.
 */
export const normaliseForCitation = normaliseUnit;

/**
 * Does `quote` appear in `text` as one whole sentence?
 *
 * Equality against `citationUnits`, not substring containment: a real clause of
 * a conditioned sentence is a partial quote, and a partial quote of a grant is
 * not the grant. The ≥12-char floor stays as its own guard — a short quote is
 * not evidence whatever it matches.
 *
 * "Present" is the question {@link classifyCitation} answers first; a quote
 * that is real text of the document but only part of a unit gets its own
 * classification so the operator is told the difference between a judge that
 * paraphrased and a judge that invented.
 */
export function citationPresent(quote: string, text: string): boolean {
  return classifyCitation(quote, text) === "whole-unit";
}

/** Why a quote did or did not verify. Every caller stays fail-closed. */
export type CitationFinding =
  /** Too short to be evidence whatever it matches. */
  | "too-short"
  /** One whole unit of the document: this is the only passing outcome. */
  | "whole-unit"
  /** Real text of the document, but not a whole unit — a paraphrase or a clause. */
  | "partial-unit"
  /** Not in the document at all — a fabricated quote. */
  | "absent";

/**
 * Classify a quote against a document without deciding anything.
 *
 * The grant path needs only the boolean, but the *reason* an honest judge gets
 * denied matters: "you quoted half the sentence" and "you invented this" are
 * different faults with different fixes, and the seam used to report both as
 * "the citation failed". Fails closed in both non-passing cases.
 */
export function classifyCitation(quote: string, text: string): CitationFinding {
  const q = normaliseForCitation(quote);
  // A trivially short "quote" would match almost anything; it is not evidence.
  if (q.length < 12) return "too-short";
  if (citationUnits(text).includes(q)) return "whole-unit";
  return normaliseForCitation(text).includes(q) ? "partial-unit" : "absent";
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

export type ReadFailure = "not-found" | "outside-root" | "too-large" | "io-error";

/** A confined read either yields the text or names the reason it could not. */
export type ReadOutcome = { ok: true; text: string } | { ok: false; failure: ReadFailure };

/**
 * Read a repo-confined file, bounded — and say why when it cannot.
 *
 * A bare `undefined` made an unreadable file indistinguishable from a file that
 * simply does not contain the quote, so an EACCES or EIO fault was reported to
 * the operator as a fabricated citation. The verdict is the same (fail closed);
 * only the reason differs, and the reason is what an operator reads.
 */
async function readConfined(repoRoot: string, cited: string): Promise<ReadOutcome> {
  let root: string;
  try {
    root = await fs.realpath(repoRoot);
  } catch {
    return { ok: false, failure: "io-error" };
  }
  // Confinement is decided on the *lexical* path first, then re-checked after
  // `realpath`. Deciding it only after resolution would report a traversal to a
  // nonexistent file as "not found", which tells a caller what exists outside
  // the root — and says "missing" about what is really a refusal.
  const target = path.resolve(root, cited);
  const lexical = path.relative(root, target);
  if (lexical === "" || lexical.startsWith("..") || path.isAbsolute(lexical)) {
    return { ok: false, failure: "outside-root" };
  }
  let resolved: string;
  try {
    resolved = await fs.realpath(target);
  } catch (err) {
    return {
      ok: false,
      failure: (err as NodeJS.ErrnoException)?.code === "ENOENT" ? "not-found" : "io-error",
    };
  }
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, failure: "outside-root" };
  }
  let st: import("node:fs").Stats;
  try {
    st = await fs.stat(resolved);
  } catch {
    return { ok: false, failure: "io-error" };
  }
  if (!st.isFile()) return { ok: false, failure: "not-found" };
  if (st.size > MAX_EVIDENCE_FILE_BYTES) return { ok: false, failure: "too-large" };
  try {
    return { ok: true, text: await fs.readFile(resolved, "utf8") };
  } catch {
    return { ok: false, failure: "io-error" };
  }
}

/** The operator-facing reason for a confined-read failure. Never a pass. */
function readFailureReason(cited: string, failure: ReadFailure): string {
  switch (failure) {
    case "not-found":
      return `'${cited}' is not a readable file inside the repo root`;
    case "outside-root":
      return `'${cited}' resolves outside the repo root`;
    case "too-large":
      return `'${cited}' is larger than ${MAX_EVIDENCE_FILE_BYTES} bytes and was not read`;
    case "io-error":
      return `'${cited}' could not be read (an I/O fault, not a missing citation)`;
  }
}

/**
 * Verify a model's quote. `cited` is the source the model named, if any: a
 * named text when one matches (case-insensitive), else a repo-confined file.
 *
 * All three branches run the same classifier, so a partial quote is refused
 * identically whether it was found in a vouched text, a name-matched text, or a
 * file — the branches cannot disagree about what counts as evidence.
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
    const best = bestFinding(texts.map((t) => classifyCitation(quote, t.text)));
    return best === "whole-unit"
      ? {
          passed: true,
          reason: "the quote was found in a supplied text",
          matchedName: texts[0]?.name,
        }
      : { passed: false, reason: citationReason("any supplied text", best) };
  }
  const candidates = texts.filter((t) => t.name.toLowerCase() === named.toLowerCase());
  if (candidates.length > 0) {
    const best = bestFinding(candidates.map((t) => classifyCitation(quote, t.text)));
    return best === "whole-unit"
      ? {
          passed: true,
          reason: `the quote was found in ${candidates[0]?.name}`,
          matchedName: candidates[0]?.name,
        }
      : { passed: false, reason: citationReason(named, best) };
  }
  if (!check.repoRoot) {
    return { passed: false, reason: `'${named}' is not one of the supplied texts` };
  }
  const read = await readConfined(check.repoRoot, named);
  if (!read.ok) {
    return { passed: false, reason: readFailureReason(named, read.failure) };
  }
  const finding = classifyCitation(quote, read.text);
  return finding === "whole-unit"
    ? { passed: true, reason: `the quote was found in ${named}`, matchedName: named }
    : { passed: false, reason: citationReason(named, finding) };
}

/**
 * The denial reason, worded for the fault.
 *
 * A partial quote and a fabricated one both fail, and the caller's source value
 * is the same for both — but the *reason* is what an operator reads, and "you
 * quoted half the sentence" and "you invented this" call for different fixes.
 * The fabricated wording stays byte-identical, since callers match on it
 * (test-policy-judge.ts).
 */
function citationReason(named: string, finding: CitationFinding): string {
  return finding === "partial-unit"
    ? `the quote is real text of ${named} but not one whole sentence of it`
    : finding === "too-short"
      ? `the quote is too short to be evidence from ${named}`
      : `the quote does not appear in ${named}`;
}

/**
 * The finding to report across several candidate texts.
 *
 * Any whole unit passes, so a pass never needs the aggregate. When none passes,
 * the *most informative* candidate wins: a quote that is real text of one
 * supplied document should not be reported as invented just because another
 * document with the same name does not contain it at all.
 */
function bestFinding(findings: readonly CitationFinding[]): CitationFinding {
  const rank: Record<CitationFinding, number> = {
    "whole-unit": 0,
    "partial-unit": 1,
    absent: 2,
    "too-short": 3,
  };
  let best: CitationFinding = "absent";
  for (const f of findings) if (rank[f] < rank[best]) best = f;
  return best;
}

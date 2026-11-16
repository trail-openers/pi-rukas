/**
 * work-driver-verify-develop-provenance-disclosure — the shape of one row the data-provenance
 * gate declined to judge, and the PR-body section those rows render into.
 *
 * Split out of `work-driver-verify-develop-provenance.ts` along the seam between *judging a
 * claim* and *reporting what was not judged*. The gate module decides fail/discard/probe; this
 * module is the disclosure record and the one place its markdown is written, so the heading a
 * reviewer pastes when a row looks wrong lives here and cannot drift from the renderer.
 *
 * The renderer returns `""` when the run disclosed nothing, so the section is absent rather than
 * empty — the same contract as every sibling PR-body section — and it is built only from the sink
 * a run that EXECUTED the gate filled, never from a state field that could outlive the run.
 *
 * The two sentences this gate says about a claim it judged — the absent failure and the
 * basename-satisfied disclosure — are rendered here too, so the wording a reviewer reads, the
 * prefix a cap router greps, and the heading a reviewer pastes all live in one file.
 */

import { PROVENANCE_FAILURE_PREFIX } from "./work-driver-verify-develop-provenance-limits.ts";
import { code, display } from "./work-driver-verify-develop-provenance-token.ts";
/** One judgement the gate declined to make, for the PR body. */
export interface ProvenanceDisclosure {
  /** The added data file, repo-relative, as a display field. */
  file: string;
  /** The provenance key the value sat under, as a display field; absent for a whole-file
   * refusal (unparsable bytes, a corpus over the bounds). */
  key?: string;
  /** The token as a display field, absent for a whole-file refusal. */
  token?: string;
  /** Why the gate declined. Its own words, never an interpolated raw token. */
  reason: string;
}

/** The note an executed `absent` becomes, naming the file, the key and the pinned commit. Written
 * in one place so a failure the reviewer reads and the prefix a cap router greps for cannot drift
 * apart, and so the gate module holds the decision rather than the sentence. */
export function provenanceAbsentFailure(opts: {
  file: string;
  key: string;
  token: string;
  oid: string;
}): string {
  return `${PROVENANCE_FAILURE_PREFIX} ${code(opts.file)}: ${code(opts.key)} names ${code(opts.token)}, which does not exist in commit ${opts.oid} — a measurement record must cite a source that was committed, not synthesised after the fact`;
}

/** The row a bare-name claim satisfied at some other path in the tree becomes. D3 weakens a bare
 * claim on purpose — the record named `run.log` and the tree answered with SOME file of that name,
 * at any depth — which is a real git answer and so passes, but it is also the answer an adversary
 * can buy by committing an unrelated file that shares a basename. The green is correct; a green
 * nobody can see the basis of is not, so the satisfied path travels to the PR body and a reviewer
 * can decide whether that file is the one the record meant. Disclosure, not failure: the gate
 * judged it, git answered, and nothing about the claim is unverifiable. */
export function provenanceBasenameDisclosure(opts: {
  file: string;
  key: string;
  token: string;
  satisfiedAt: string;
}): ProvenanceDisclosure {
  return {
    file: opts.file,
    key: opts.key,
    token: opts.token,
    reason: `a bare name, judged present because the commit holds \`${display(opts.satisfiedAt)}\` — the claim was satisfied by BASENAME at that path, not at a path the record named, so check that file is the one this record read`,
  };
}

/** The worktree-side read this gate issues. Absent = this caller does not route on it. */
export type ProvenanceDisclosureSink = {
  /** Filled IN PLACE, as `verifyRecord` is, so the caller reads the same array it handed
   * in after the gate ran. Each entry is one judgement this gate could not make. */
  disclosures?: ProvenanceDisclosure[];
};

/**
 * The disclosure section for the PR body. Returns `""` when the run disclosed nothing, so
 * the section is absent rather than empty — the same contract as every sibling section.
 *
 * Only a run that EXECUTED the gate emits disclosures: the caller builds this from the
 * sink the gate filled, never from a state field that could outlive the run.
 */
export function provenanceDisclosureSectionOf(
  disclosures: readonly ProvenanceDisclosure[] | undefined,
): string {
  if (!disclosures || disclosures.length === 0) return "";
  return [
    "",
    "## Data provenance (warning — not blocking)",
    "",
    "The develop gate judged the data files this change adds and could not verify these tokens against the committed tree. The work may well be sound — the gate simply could not see what these values name, so a reviewer should:",
    "",
    ...disclosures.map((d) => {
      const where = d.key === undefined ? `\`${d.file}\`` : `\`${d.file}\` → \`${d.key}\``;
      const named = d.token === undefined ? "" : ` value \`${d.token}\``;
      return `- ${where}${named}: ${d.reason}`;
    }),
  ].join("\n");
}

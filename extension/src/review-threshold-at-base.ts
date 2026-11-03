/**
 * review-threshold-at-base — the ONE way a review resolves the project's
 * blocking severity.
 *
 * Which severity a finding must reach before it stops a merge is the project's
 * decision, stated in prose in its doctrine (`AGENTS.md`, `CLAUDE.md`), and
 * `resolveReviewThreshold` reads that sentence through a citation-verified
 * judge. What this module adds is the two choices every caller would otherwise
 * make for itself and could each get wrong in a different way:
 *
 *   - **where the doctrine is read from** — a commit, never the working tree.
 *     A review that read doctrine from disk would honour a sentence a subagent
 *     wrote during the very cycle it is grading (#406's shape);
 *   - **what happens when there is nothing to read** — the shipped MEDIUM
 *     default. Absent doctrine, an unreadable one, or one that never mentions
 *     review severity is the *normal* case, so the read never blocks a review.
 *
 * Every lens path resolves through here so one project states one bar and each
 * of them applies it: the `/work` driver's lens step, the `dispatch_lens_review`
 * tool, and lean's review step. A path that resolves on its own silently gets
 * `DEFAULT_REVIEW_THRESHOLD`, which is looser than what this repo's own §1 says.
 *
 * The doctrine read itself is exported separately (`readDoctrineDocsAtBase`)
 * because a caller that also feeds the same documents to another judge — the
 * driver's lens step does — must ask for one read, not two.
 */

import { type ReviewSeverity, resolveReviewThreshold } from "./review-threshold.ts";
import { trace } from "./trace.ts";
import { readDoctrineAtBase } from "./work-driver-doctrine.ts";
import { DOCTRINE_FILES, type DoctrineDoc, type PolicyJudgeFn } from "./work-driver-policy.ts";

/** The executor shape `readDoctrineAtBase` calls. */
type ExecFn = (
  cmd: string,
  opts?: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    shell?: string;
    /** The no-shell form: `cmd` is the executable and `argv` its arguments. */
    argv?: string[];
  },
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * The doctrine of one project, read as it stood at one commit.
 *
 * `readDoctrineAtBase` reads a *file*, so the file list and the
 * "file unreadable means no document" rule live there; this walks the
 * `DOCTRINE_FILES` pair that every doctrine-reading gate consults. Both lens
 * paths that resolve a blocking bar need the same two documents fed to the same
 * judge, and a per-caller loop is where one of them would quietly stop reading
 * `CLAUDE.md`.
 */
export async function readDoctrineDocsAtBase(
  execFn: ExecFn,
  repoRoot: string,
  baseRef: string | undefined,
): Promise<DoctrineDoc[]> {
  const docs: DoctrineDoc[] = [];
  for (const file of DOCTRINE_FILES) {
    const read = await readDoctrineAtBase(execFn, repoRoot, baseRef, file);
    if (read.text !== undefined) docs.push({ file, text: read.text });
  }
  return docs;
}

/**
 * The blocking bar for one review: doctrine read at `baseRef`, judged by `judge`,
 * defaulting to MEDIUM when the project says nothing.
 *
 * `baseRef` is any ref git can read (`readDoctrineAtBase` hands it to `git show`),
 * and an unreadable or absent one yields no documents — which is the default, not
 * an error. Traces the outcome and where it came from, so an operator reading a
 * trace can tell which bar a round was judged against.
 */
export async function resolveLensReviewThreshold(opts: {
  /** The judge that reads the doctrine. Supplied by the caller: this module does
   * not know which child (or test stub) is allowed to answer. */
  judge: PolicyJudgeFn;
  execFn: ExecFn;
  repoRoot: string;
  /** The ref the doctrine is read at (`git show <ref>:<file>`, which accepts a
   * commit, a tree-ish or a `<rev>:<path>`). Undefined → no doctrine → the
   * default. Callers pass a commit SHA wherever one is known, so the bar cannot
   * move under a running review; the tool path is the one caller that may hand
   * a `<remote>/<mainline>` ref. Anything git cannot read yields no documents. */
  baseRef: string | undefined;
  /** Where the decision was made, for the decision log. */
  where?: { repoRoot?: string; issues?: readonly number[] };
}): Promise<ReviewSeverity> {
  const docs = await readDoctrineDocsAtBase(opts.execFn, opts.repoRoot, opts.baseRef);
  const decision = await resolveReviewThreshold(opts.judge, docs, undefined, opts.where);
  trace(`lens review — blocking severity ${decision.severity} (${decision.source})`);
  return decision.severity;
}

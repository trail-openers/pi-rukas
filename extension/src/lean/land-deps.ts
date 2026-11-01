/**
 * lean/land-deps — the forge seam `lean/land` reaches through, in production form.
 *
 * `land` performs the one irreversible act in a run, so its seam is deliberately
 * the *existing* evidence gatherer rather than a new forge surface:
 * `gatherMergeEvidence` is the driver's executed-evidence read (it runs
 * `mergeEvidenceViewCmd`, which carries `mergeStateStatus`, `state` and
 * `headRefOid` from ONE command, and the check rows that name what is failing),
 * and `prMerge` is the adapter's pinned merge. Neither is re-implemented here —
 * see `land.ts` for why the arrival gate is not restated either.
 *
 * A test injects a recorder into `LandDeps` and the suite never touches a real
 * PR: every `merged` claim the tests observe came from an evidence read that
 * said `ok` plus a merge that was read back as `MERGED`.
 */

import { execp } from "../exec.ts";
import { clipTitle } from "../work-driver-pr-body-definition.ts";
import { deriveConsolidationSubject } from "../work-driver-handoff-subject.ts";
import type { MergeEvidence } from "../work-driver-merge-evidence.ts";
import { gatherMergeEvidence } from "../work-driver-merge-evidence.ts";
import { loadWorkConfig } from "./config.ts";
import { forgeFor } from "./io.ts";

/** The merge call as this step records it, so a test can assert on the pin. */
export interface MergeCall {
  number: number;
  headOid: string;
  method: "squash" | "merge" | "rebase";
  subject: string | undefined;
}

/** What `land` reaches outside itself: the evidence read, the merge, and config. */
export interface LandDeps {
  /** The executed merge evidence for a PR, or `undefined` when it could not be read. */
  evidence: (repoRoot: string, prNumber: number) => PromiseLike<MergeEvidence | undefined>;
  /** The open PR standing on a branch, or `undefined` when there is none. */
  openPr: (repoRoot: string, branch: string) => PromiseLike<number | undefined>;
  /** Perform the merge pinned to `headOid`. */
  merge: (repoRoot: string, call: MergeCall) => PromiseLike<void>;
  /** The state the forge reports after the merge — the only proof of `merged`. */
  stateAfter: (repoRoot: string, prNumber: number) => PromiseLike<string | undefined>;
  loadConfig: (repoRoot: string, baseSha: string) => Promise<{ autoMerge: boolean }>;
  /**
   * The squash subject the merge carries; absent, the forge's default is used.
   *
   * `landDeps()` ALWAYS supplies this in production. A squash subject becomes the
   * permanent commit record on main and release-please derives the version bump
   * and the changelog entry from it, so a lean merge that left it to the forge's
   * default was leaving the changelog to whatever the forge guessed.
   */
  mergeSubject?: (issue: number) => string | undefined;
}

/** Production wiring: the real evidence gatherer and the real adapter. */
export function landDeps(): LandDeps {
  const adapter = async (repoRoot: string) => forgeFor(repoRoot);
  return {
    evidence: (repoRoot, prNumber) => gatherMergeEvidence(execp, repoRoot, prNumber),
    openPr: async (repoRoot, branch) => {
      const f = await adapter(repoRoot);
      if (f === undefined) return undefined;
      const rows = await f.prList({ state: "open", sourceBranch: branch });
      return rows.find((row) => row?.headRefName === branch)?.number;
    },
    merge: async (repoRoot, call) => {
      const f = await adapter(repoRoot);
      if (f === undefined) throw new Error("no forge adapter for this clone");
      await f.prMerge(call.number, call.headOid, call.method, call.subject);
    },
    stateAfter: async (repoRoot, prNumber) => {
      const f = await adapter(repoRoot);
      if (f === undefined) return undefined;
      return (await f.prView(prNumber))?.state;
    },
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
    // The driver's ONE conventional-subject parser, not a lean-only format: the
    // commit-pr path derives its title through `deriveConsolidationSubject` from
    // the issue title (`work-driver-commit-title.ts`), and so does the handoff
    // consolidation commit. A lean merge that invented its own subject would be a
    // second parser disagreeing with the first about what a given change is.
    //
    // `undefined` (which `prMergeSubjectFlag` renders as NO `--subject` flag, so
    // the forge default survives) is used only when there is genuinely nothing to
    // say: no forge adapter for this clone, an unreadable issue, or an empty title.
    // An empty subject would be worse than none — `gh pr merge --subject ''` is a
    // blank commit record, not a default one.
    mergeSubject: (issue) => squashSubject(issue),
  };
}

/**
 * The squash subject for this run's merge, derived from the issue's title.
 *
 * Async work is not allowed on the `mergeSubject` seam's signature (the step
 * calls it synchronously from inside the pinned merge call), so the title is
 * fetched up front and cached per issue. One `issueView` per issue per process is
 * the whole cost, and it is a read the driver already performs elsewhere.
 */
const subjectCache = new Map<number, string | undefined>();

async function squashSubject(issue: number): Promise<string | undefined> {
  const hit = subjectCache.get(issue);
  if (hit !== undefined) return hit;
  const repoRoot = process.cwd();
  const f = await forgeFor(repoRoot);
  if (f === undefined) return undefined;
  const viewed = await f.issueView(issue).catch(() => undefined);
  const title = viewed?.title?.trim();
  if (!title) return undefined;
  const derived = deriveConsolidationSubject(title);
  // `clipTitle` is the driver's own clipper (same 64 as `deriveCommitPrTitle`),
  // and the newline is stripped because `--subject` is a one-line shell argument
  // (`prMergeSubjectFlag`'s contract).
  const subject = derived === undefined ? undefined : clipTitle(derived.split("\n")[0] ?? "", 64);
  const value = subject === undefined || subject.trim() === "" ? undefined : subject.trim();
  subjectCache.set(issue, value);
  return value;
}

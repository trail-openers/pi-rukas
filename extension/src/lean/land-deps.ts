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
import type { AuthorRead } from "../merge-author-allowlist.ts";
import { type MergeAuthorDecision, heldForMergeAuthor } from "../merge-guard-author.ts";
import { deriveConsolidationSubject } from "../work-driver-handoff-subject.ts";
import type { MergeEvidence } from "../work-driver-merge-evidence.ts";
import { gatherMergeEvidence } from "../work-driver-merge-evidence.ts";
import { clipTitle } from "../work-driver-pr-body-definition.ts";
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
   * The merge-author gate (#2181): is this PR's author listed in
   * `.pi/merge-authors` at the run's base commit? Production is the shared gate in
   * `merge-guard-author.ts` — the same function the `/work` driver's `merged` step
   * and the merge guard call — so no path can drift on what the allowlist means.
   * Injected so a case can name an author without a forge.
   */
  checkAuthor: (
    repoRoot: string,
    baseSha: string,
    author: AuthorRead,
  ) => PromiseLike<MergeAuthorDecision>;
  /**
   * The squash subject the merge carries; absent, the forge's default is used.
   *
   * `landDeps()` always supplies this in production (see `primeMergeSubject`).
   * A squash subject BECOMES the permanent commit record on main, and
   * release-please derives the version bump and the changelog entry from it, so a
   * lean merge that left it to the forge's default left the changelog to luck.
   */
  mergeSubject?: (issue: number) => string | undefined;
}

/**
 * The squash subject per issue, filled by `primeMergeSubject`.
 *
 * The `mergeSubject` seam is called SYNCHRONOUSLY from inside the pinned merge
 * call, so the forge read that produces the subject cannot happen at the call
 * site. It happens at wiring time instead: `command.ts` primes this cache when it
 * builds the deps for a run, and the seam answers from it. An issue that was
 * never primed (a resumed run whose deps were built before the priming landed, a
 * forge-less clone, an unreadable issue) gets `undefined`, which
 * `prMergeSubjectFlag` renders as NO `--subject` flag — the forge's default,
 * never a blank subject.
 */
const subjectCache = new Map<number, string | undefined>();

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
    // #2181 — the shared gate, on this process's executor. Reads the allowlist at
    // the run's base sha with `git show`, so a run cannot land its own PR by
    // widening the file it is judged by.
    checkAuthor: (repoRoot, baseSha, author) =>
      heldForMergeAuthor({ exec: execp, cwd: repoRoot, baseSha, author }),
    // Read from the cache `primeMergeSubject` fills at wiring time. The format is
    // the driver's ONE conventional-subject parser — the commit-pr path derives its
    // title through `deriveConsolidationSubject` from the issue title
    // (`work-driver-commit-title.ts`) and so does the handoff consolidation commit.
    // A lean merge that invented its own subject would be a second parser
    // disagreeing with the first about what the same change is.
    mergeSubject: (issue) => subjectCache.get(issue),
  };
}

/**
 * Read the issue's title and cache the conventional squash subject its merge carries.
 *
 * Called once per run, at wiring time, because the seam that returns it is sync
 * (see `subjectCache`). `clipTitle` is the driver's own clipper, at the same 64 as
 * `deriveCommitPrTitle`, and only the first line survives: `--subject` is a
 * one-line shell argument, which is `prMergeSubjectFlag`'s contract. An absent
 * forge, an unreadable issue, an empty title or a subject the parser refused all
 * cache `undefined` — no flag, not a blank subject.
 */
export async function primeMergeSubject(
  repoRoot: string,
  issue: number,
): Promise<string | undefined> {
  const f = await forgeFor(repoRoot);
  if (f === undefined) return undefined;
  const viewed = await f.issueView(issue).catch(() => undefined);
  const title = viewed?.title?.trim();
  if (!title) return undefined;
  const derived = deriveConsolidationSubject(title);
  const first = derived === undefined ? "" : (derived.split("\n")[0] ?? "").trim();
  const value = first === "" ? undefined : clipTitle(first, 64);
  subjectCache.set(issue, value);
  return value;
}

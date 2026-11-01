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
import { type MergeEvidence, gatherMergeEvidence } from "../work-driver-merge-evidence.ts";
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
  /** The squash subject the merge carries; absent, the forge's default is used. */
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
  };
}

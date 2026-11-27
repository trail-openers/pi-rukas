/**
 * lean/land-deps — the forge seam `lean/land` reaches through, in production form.
 *
 * `land` performs the one irreversible act in a run, so its seam is deliberately the *existing* evidence
 * gatherer rather than a new forge surface: `gatherMergeEvidence` is the driver's executed-evidence read (one
 * command carrying `mergeStateStatus`, `state` and `headRefOid`, plus the rows naming what is failing), and
 * `prMerge` is the adapter's pinned merge. Neither is re-implemented here.
 *
 * A test injects a recorder into `LandDeps` and the suite never touches a real PR: every `merged` claim came
 * from an evidence read saying `ok` plus a merge read back as `MERGED`.
 */
import { execp } from "../exec.ts";
import type { Forge } from "../forge-types.ts";
import type { AuthorRead } from "../merge-author-allowlist.ts";
import { type MergeAuthorDecision, heldForMergeAuthor } from "../merge-guard-author.ts";
import {
  deriveConsolidationSubject,
  parseConventionalTitle,
} from "../work-driver-handoff-subject.ts";
import type { MergeEvidence } from "../work-driver-merge-evidence.ts";
import { gatherMergeEvidence } from "../work-driver-merge-evidence.ts";
import { usesConventionalCommits } from "../work-title.ts";
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
   * The merge-author gate: is the PR's author in `.pi/merge-authors` at the run's base commit? Production is
   * the shared gate the driver's `merged` step and the merge guard also call, so no path drifts on what the
   * allowlist means.
   */
  checkAuthor: (
    repoRoot: string,
    baseSha: string,
    author: AuthorRead,
  ) => PromiseLike<MergeAuthorDecision>;
  /**
   * The squash subject the merge carries; absent, the forge's default.
   *
   * A squash subject BECOMES the permanent commit record on main, and release-please derives the version bump
   * and changelog entry from it — leaving it to the forge's default left the changelog to luck.
   */
  mergeSubject?: (issue: number) => string | undefined;
}

/**
 * The squash subject per issue, filled by `primeMergeSubject`.
 *
 * The seam is called SYNCHRONOUSLY from inside the pinned merge call, so the forge read producing the subject
 * happens at wiring time: `command.ts` primes this cache when it builds the deps. An unprimed issue gets
 * `undefined`, which renders as NO `--subject` flag — the forge's default, never a blank subject.
 */
const subjectCache = new Map<number, string | undefined>();

/** Production wiring: the real evidence gatherer and the real adapter. */
export function landDeps(): LandDeps {
  const adapter = async (repoRoot: string) => forgeFor(repoRoot);
  return {
    // The forge this seam already resolves for every other operation, named on the evidence read rather than
    // left to the gatherer's last-resort detection: a clone whose remote it cannot read should refuse on its
    // CI verdict, not a forge fault nothing else here would hit. `undefined` falls through to its refusal.
    evidence: async (repoRoot, prNumber) =>
      gatherMergeEvidence(execp, repoRoot, prNumber, (await adapter(repoRoot))?.forge),
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
    // The shared gate on this process's executor: reads the allowlist at the run's base sha, so a run cannot
    // land its own PR by widening the file it is judged by.
    checkAuthor: (repoRoot, baseSha, author) =>
      heldForMergeAuthor({ exec: execp, cwd: repoRoot, baseSha, author }),
    // From the cache `primeMergeSubject` fills at wiring time. The format is the driver's ONE
    // conventional-subject parser and convention check — the commit-pr path derives its title the same
    // way; a lean merge inventing one would be a second parser disagreeing.
    mergeSubject: (issue) => subjectCache.get(issue),
  };
}

/**
 * Read the issue's title and cache the squash subject its merge carries.
 *
 * Called once per run at wiring time, because the seam returning it is sync. The subject is the WHOLE issue
 * title, never cut: a cut subject is a sentence that stops, and it is the permanent record on main. The
 * `type(scope):` prefix is added only when the repository writes conventional subjects, through the same
 * `usesConventionalCommits` and `deriveConsolidationSubject` the classic commit-pr title uses; otherwise the
 * subject is the title's own text. An absent forge, unreadable issue or empty title caches `undefined`: no
 * flag, not a blank subject.
 *
 * GitLab caches `undefined` on purpose: `glab mr merge` has no `--subject` (it takes `-m/--message` or
 * `--squash-message`), so a subject reaching that builder is refused by name rather than silently dropped.
 * Asking here, where the forge is already in hand, is what keeps the lean merge from dying at the merge call
 * itself.
 */
export async function primeMergeSubject(
  repoRoot: string,
  issue: number,
  resolve: (repoRoot: string) => Promise<Pick<Forge, "forge" | "issueView"> | undefined> = forgeFor,
): Promise<string | undefined> {
  const f = await resolve(repoRoot);
  if (f === undefined) return undefined;
  if (f.forge !== "github") {
    subjectCache.set(issue, undefined);
    return undefined;
  }
  const viewed = await f.issueView(issue).catch(() => undefined);
  const title = viewed?.title?.trim();
  if (!title) return undefined;
  const text = parseConventionalTitle(title).description || title;
  const value = (await usesConventionalCommits(repoRoot, undefined, execp))
    ? deriveConsolidationSubject(title, text)
    : text;
  subjectCache.set(issue, value);
  return value;
}

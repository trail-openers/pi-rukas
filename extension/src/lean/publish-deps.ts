/**
 * lean/publish-deps — the outside world `lean/publish` reaches, in production
 * form, plus the error its throws are instances of.
 *
 * Split from `publish.ts` along the seam the file already had: the step body is
 * the algorithm and its preconditions; this file is the wiring to git, the forge
 * and the issue. A phase that swaps the forge adapter for an API client, or adds
 * a retry to the push, changes this file and leaves the step's decisions alone —
 * which is the same reason `io.ts` is separate from `command.ts`.
 *
 * `PublishInfraError` lives here because both halves raise it: the step raises
 * it for a claim it could not verify, and a dependency raises it for a machine
 * that would not answer. The engine turns either into a handed-back run, which
 * is the honest answer to "nobody looked".
 */

import { execp } from "../exec.ts";
import type { Forge } from "../forge-types.ts";
import { resolveMainline } from "../mainline.ts";
import { netGitEnv } from "../work-driver-net-git.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import { fetchIssueBody, forgeFor } from "./io.ts";
import type { VerifyExec } from "./verify-types.ts";

/** Infrastructure: the step could not observe what it needed, so it did not act. */
export class PublishInfraError extends Error {
  override readonly name = "PublishInfraError";
}

/**
 * The executor this step needs: the argv form plus `execp`'s `killGroup`, which
 * the push carries so a hung `git push` cannot leave an ssh grandchild holding
 * the pipe open. Same intersection `verify-types.ts` documents.
 */
export type PublishExec = VerifyExec;

/**
 * The forge in the shape the step uses: list, read, (re)draft, then create.
 * Nothing else.
 *
 * `prDraft` is here because a REUSED PR carries the draft state the previous run
 * left on it: `prCreate`'s `draft` option only ever applies to a PR this step
 * opens. Without it a run whose verify went red would attach a fresh unverified
 * head to a PR that reads READY — the one thing this step's whole design
 * refuses. `prView` exists because `gh pr list --json` does not carry `isDraft`
 * (only `gh pr view --json …,isDraft,…` does), so the list reply alone cannot
 * tell a reused PR's state.
 */
export type PublishForge = Pick<Forge, "prList" | "prView" | "prDraft" | "prCreate">;

/** What the step reaches outside itself. */
export interface PublishDeps {
  exec: PublishExec;
  fetchBody: (repoRoot: string, issue: number) => Promise<string>;
  forge: (repoRoot: string) => PromiseLike<PublishForge | undefined>;
}

/**
 * The push target must be a lean branch, and never the mainline.
 *
 * `branch` arrives from the run's persisted state file, so it is data a stale or
 * edited file supplies rather than a name this cycle chose. Pushing it raw is
 * how a run whose state named `main` writes unreviewed work onto the mainline:
 * `assertSafeRef` says the string is a legal ref, which `main` is.
 *
 * Rule 1 is the load-bearing one — a lean run's branch is `lean/…` by
 * construction (`specifyBranch`), so requiring that prefix also rejects a
 * `refs/heads/` or `origin/` prefix that would otherwise reach
 * `refs/heads/refs/heads/…`. Rule 2 catches a mainline that does not spell
 * `main` (`trunk`, a fork's default); when it cannot be read we fall back to
 * rule 1 alone rather than refusing every push, because a clone with no
 * `origin/HEAD` and no `gh` is ordinary and its lean pushes are legitimate.
 *
 * Throws `PublishInfraError`, which the engine turns into a handed-back run.
 */
export async function assertPublishableBranch(repoRoot: string, branch: string): Promise<void> {
  // The ref's own charset first — every other lean git call site validates its
  // ref before it reaches a command line, and this one is no exception; the
  // error is re-wrapped so the engine sees a PublishInfraError rather than a
  // bare Error.
  try {
    assertSafeRef(branch);
  } catch (err) {
    throw new PublishInfraError((err as Error).message);
  }
  if (!branch.startsWith("lean/"))
    throw new PublishInfraError(
      `refusing to publish to ${branch}: work-lean pushes only lean/ branches`,
    );
  const mainline = await resolveMainline(repoRoot, execp).catch(() => undefined);
  if (mainline?.ok === true && mainline.branch === branch)
    throw new PublishInfraError(`refusing to push to the mainline ${mainline.branch}`);
}

/**
 * The non-interactive env a publish push runs with, in the production seam only.
 *
 * This IS the driver's env — `netGitEnv` from `work-driver-net-git.ts`, imported
 * directly at the executor below rather than wrapped. Every other network git
 * call in the harness already goes through that seam, so a publish push cannot
 * drift from a driver push on what makes ssh fail instead of reading a passphrase
 * from /dev/tty (`GIT_TERMINAL_PROMPT=0` + `-o BatchMode=yes`, #1095). The
 * earlier argument for composing our own here was that `work-driver-net-git.ts`
 * would drag the driver graph into a lean step; the review showed this file
 * already pulls in ~390 driver modules through `command.ts`, so the reason was
 * gone and the duplication was all that was left.
 */

/** Production dependencies: the real executor, the real issue read, the real forge. */
export function publishDeps(): PublishDeps {
  return {
    // One executor for both shapes: `execp`'s own opts type declares every field
    // this step passes (`argv`, `cwd`, `timeout`, `maxBuffer`, `stdoutEncoding`,
    // `killGroup`), so the production seam is that executor rather than the
    // narrower executor type the worktree helpers declare (which has no
    // `killGroup`).
    //
    // The push is the one call that leaves the clone, so it is the one call this
    // seam gives the driver's non-interactive env to (see the note above).
    // Every other git call the step makes is local and keeps the caller's env
    // verbatim.
    exec: (cmd, o) =>
      execp(cmd, {
        ...(o ?? {}),
        ...(cmd === "git" && o?.env === undefined ? { env: netGitEnv() } : {}),
      }),
    fetchBody: fetchIssueBody,
    // `forgeFor` is io.ts's one lookup. `Forge` is structurally assignable to
    // `PublishForge` (a `Pick` of it), so no cast: the narrower shape is a
    // type-level statement about what the step may ask, not a second adapter to
    // keep in sync. `undefined` is an ANSWER ("this clone has no forge the
    // harness can drive"), and a detection that THREW also comes back undefined
    // here — the same conflation `io.ts` accepts for the same reason: a forge
    // that cannot be resolved is not a step the run can finish either way, and
    // the step's refusal says which side of the line it stopped on.
    forge: forgeFor,
  };
}

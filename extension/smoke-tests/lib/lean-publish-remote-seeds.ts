/*
 * lib/lean-publish-remote-seeds — how `lib/lean-publish-fixture.ts` plants ORIGIN.
 *
 * Split out under the §12 file-size cap along the seam the fields draw: these are the
 * knobs that decide what origin's branch (and the clone's config) hold BEFORE the step
 * runs — as against `lean-publish-seams.ts`, which decides what one CALL answers while
 * it runs, and `lean-publish-origin.ts`, which builds the refs these names select.
 */

import type { OriginStale } from "./lean-publish-origin.ts";

/** The knobs that seed the remote and the clone's git config before the step runs. */
export interface PublishRemoteSeeds {
  /**
   * Origin already holds a commit of ANOTHER repo on the branch — work this run
   * never made and has no history with. The step must never report `ok` over it
   * (see the case in `test-lean-publish-remote.ts`).
   */
  originForeign?: boolean;
  /**
   * Origin already holds ANOTHER commit of this repo on the run's branch — the
   * stale-branch shapes a rerun of a lean issue meets. See `OriginStale` in
   * `lean-publish-origin.ts` for what each name builds.
   */
  originStale?: OriginStale;
  /**
   * The head the run's PRIOR publish step recorded as `publishedHead` (and whose
   * `prUrl` the `openPrs` row must carry). Only meaningful with
   * `originStale: "own-publish"`, which leaves origin's branch exactly there; the
   * fixture then writes the matching DECIDED `publish` step into the log, so the
   * record and the remote are two readings of one sha rather than two inventions.
   */
  priorPublish?: { prUrl: string };
  /**
   * With `priorPublish`, replace the ci-fix commit with one that shares NO history with
   * what the run published, so HEAD does not descend from the sha the prior publish
   * recorded — the shape the fast-forward half of the own-PR check must refuse.
   */
  graftForeignHead?: boolean;
  /**
   * Rewrite the fixture's own prior `publish` outcome after the log is built — the seam
   * for a record that names no `publishedHead` or names a truncated one.
   */
  overwritePublishOutcome?: Record<string, unknown>;
  /**
   * Seed origin's branch at the run's HEAD before the step runs, so the push
   * path is genuinely skipped. Each `runPublish` builds its own temp repo, so
   * the honest "origin already holds this head" case cannot be two runs of the
   * same issue — it needs the ref seeded.
   */
  originAtHead?: boolean;
  /**
   * Move origin's branch ref BETWEEN the step's `ls-remote` read and its push —
   * the race a lease exists to catch. The push must fail rather than overwrite.
   * The case also passes `noPush`: the race is the moment just before the push,
   * and a setup push would have moved the ref once already.
   */
  moveRemoteDuringPush?: boolean;
  /**
   * Do not push this run's head at the end of setup, so origin's run branch is
   * absent when the step looks and the step's own push is the only write. For the
   * cases that must observe it: a refusal that has to happen BEFORE any push, a
   * stubbed push report, a lease that has to fail.
   */
  noPush?: boolean;
  /**
   * Set `core.sshCommand` in the fixture repo before the step runs — the seam
   * for a push env that must honour the repo's own ssh selection (a deploy key
   * chosen with `git config core.sshCommand`, which an env-only `netGitEnv()`
   * lookup silently skips).
   */
  sshCommand?: string;
  /** A branch name to force onto the run (an unsafe ref, for the handback case). */
  branch?: string;
}

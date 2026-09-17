/**
 * /work workflow state — deferred worktree-creation failure detail (#753).
 *
 * The `branch-completed` event is the event that reports a workstream's
 * failure, and for a workstream that declared `dependsOn` the failure is the
 * DEFERRED worktree creation in `runDependentWorkstreams` (its worktree is
 * not created at the branch step). Historically that event carried a
 * hand-written literal ("deferred worktree creation failed for <id>") as its
 * sole record — the git command attempted, its exit status and its stderr
 * were discarded at the catch site, and two live cycles lost ~37 minutes each
 * with no cause on disk.
 *
 * This fragment is the discriminated record for a deferred-creation failure.
 * It hangs off `branch-completed` as an OPTIONAL field (additive, tail-safe:
 * no new event kind, `nextStep` still routes on the tail).
 *
 * `class` distinguishes the two shapes the recording must tell apart:
 *  - "dirty-leftover": a pre-add guard (DirtyWorktreeError) refused BEFORE
 *    `git worktree add` ran, so there is no git command to record — the
 *    error text IS the finding (the leftover path it names). The cycle
 *    PARKS on this class; it must never be force-removed.
 *  - "create-error": the creation itself failed (the add, or a guard that
 *    surfaced as a plain error). `gitCommand` / `stderr` carry the
 *    underlying failure, extracted via worktree.ts's `gitErrorDetail` —
 *    never a new extraction scheme.
 */

/**
 * The underlying failure of a deferred worktree creation, recorded on the
 * `branch-completed` event (see the module doc for the class semantics).
 */
export type DeferredCreationFailure =
  | {
      class: "dirty-leftover";
      /** The leftover's absolute path, named so the operator can inspect it. */
      leftoverPath: string;
      /** DirtyWorktreeError's own message — for this class it is the finding. */
      error: string;
    }
  | {
      class: "create-error";
      /** The git command the creation attempted, when one was reached. */
      gitCommand?: string;
      /** The command's stderr, via `gitErrorDetail` (never the wrapper). */
      stderr?: string;
      /** The error's text (wraps stderr; always present). */
      error: string;
    };

/**
 * Optional field on the `branch-completed` event, present only when the
 * workstream is a `dependsOn` workstream and its DEFERRED worktree creation
 * failed. Absent on every other branch-completed (independent workstreams,
 * legitimate skips, successes) — readers treat absence as "not a deferred
 * creation failure".
 */
export type DeferredCreationEventFragment = {
  /** Which dependency this workstream was waiting on when it failed. */
  waitedFor: string;
  /** The base ref the deferred creation resolved to (the dependency's
   * post-commit SHA). Present when resolution succeeded and creation then
   * failed; absent when resolution itself produced a skip. */
  resolvedBaseRef?: string;
  /** The dependency's completion timestamp lives on the parent
   * `branch-completed` event's `depCompletedAt` field — one source of
   * truth, not duplicated here. */
  failure: DeferredCreationFailure;
};

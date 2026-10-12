/**
 * work-driver-safety-net — #622 mechanical auto-commit safety net.
 *
 * The developer prompt (post-#621) explicitly instructs subagents to
 * `git add` + `git commit` in their worktree, and the verify gate
 * (`work-driver-verify-develop.ts`) requires commits ahead of baseSha.
 * But smaller models can still skip the commit step due to constraint
 * drift over long contexts.
 *
 * This module runs driver-side AFTER all developer dispatches complete
 * but BEFORE the verify gate. It checks each worktree for the specific
 * failure mode the verify gate would reject: uncommitted changes exist
 * but there are zero commits ahead of the workstream's EFFECTIVE base. When
 * that condition holds, it stages the porcelain paths (excluding driver
 * artefacts under `.pi/` and `tmp/`) and creates a driver-attributed commit.
 *
 * #679 (task-evidence) — the safety net is no longer gated on the AGGREGATE
 * verdict (`verdicts.every(v => v.ok)`). Its trigger is now a PER-WORKTREE
 * evidence check, independent of any sibling's verdict, so a legitimate
 * workstream's uncommitted work is still safety-netted even when a SIBLING
 * is falsely-ok (the case-2c false-green shape). Each workstream's base is
 * resolved from `pipelineState.workstreamBaseShas` (case 2b: a dependent
 * workstream's effective base is its dependency's post-commit SHA) falling
 * back to the global `baseSha`.
 *
 * The safety net NEVER fires when:
 *   - the worktree is clean (AC3), or
 *   - the dispatch failed (the dispatch-failed HALT machinery handles it), or
 *   - `PI_ENSEMBLE_SAFETY_NET_COMMIT=0` is set (AC5), or
 *   - the commit count or status cannot be read (#1016): an unknown state is
 *     never committed; the skip is recorded as a note.
 *
 * It NEVER throws: any git failure degrades to the pre-safety-net behaviour
 * (the verify gate will produce the same "uncommitted changes but no commit"
 * failure as before). The cycle already has a full failure path for that case.
 *
 * Follows the same pattern as `work-driver-cap-checkpoint.ts` (auto-commit
 * for cap-killed dispatches): porcelain path parsing, scoped staging
 * (skip `.pi/`, `tmp/`), driver-attributed commit message, and `commitSha`
 * recorded on the event so handoff renderers can show what was committed.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { trace } from "./trace.ts";
import {
  type ExecFn,
  type GitExec,
  assertInsideWorktrees,
  commitEntriesOf,
  commitsAheadOfBase,
  errText,
  isDriverArtefact,
  isValidBaseSha,
  runGit,
  stageDeletions,
  stagePaths,
  unstagePaths,
  worktreeStatus,
} from "./work-develop-git.ts";
import { withPersistNotes } from "./work-develop-retry.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { execp } from "./work-driver-verify.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

/** #622 — escape hatch: PI_ENSEMBLE_SAFETY_NET_COMMIT=0 disables the safety net. */
function safetyNetEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_SAFETY_NET_COMMIT;
  return v !== "0" && v !== "false";
}

/**
 * #679 (task-evidence) — resolve a workstream's EFFECTIVE base for the
 * safety-net / verify re-gates. A dependent workstream's base is its
 * dependency's post-commit SHA (persisted in `workstreamBaseShas` at
 * deferred-worktree-creation time); every other workstream — and any
 * workstream with no per-workstream entry — falls back to the global
 * `baseSha`. Returns `undefined` when neither source is a valid SHA, in
 * which case the caller skips the workstream (no evidence to act on).
 */
function effectiveBaseForWorkstream(
  wsId: string,
  workstreamBaseShas: Record<string, string> | undefined,
  globalBaseSha: string | undefined,
): string | undefined {
  const per = workstreamBaseShas?.[wsId];
  if (isValidBaseSha(per)) return per;
  if (isValidBaseSha(globalBaseSha)) return globalBaseSha;
  return undefined;
}

/**
 * #679 (task-evidence) — is there ANY develop evidence to gate on?
 *
 * Replaces the old aggregate `verdicts.every(v => v.ok)` trigger that skipped
 * the safety net AND the develop verify gate for the whole fanout when any
 * single workstream failed. A fanout has evidence when at least one worktree
 * has commits ahead of its effective base OR has uncommitted changes. Returns
 * `true` conservatively (run the gates) when a worktree cannot be assessed —
 * a gate is never suppressed on uncertainty. Never throws.
 */
export async function hasAnyWorktreeEvidence(
  ctx: DriverContext,
  state: WorkState,
): Promise<boolean> {
  const worktrees = state.pipelineState.worktrees ?? {};
  const baseSha = state.pipelineState.baseSha;
  const workstreamBaseShas = state.pipelineState.workstreamBaseShas;
  const execFn: ExecFn = ctx.verifyExecFn ?? execp;
  const ids = Object.keys(worktrees);
  if (ids.length === 0) return true; // nothing to gate on, but be conservative
  for (const [wsId, cwd] of Object.entries(worktrees)) {
    // Uncommitted changes anywhere → evidence, regardless of base validity.
    const status = await worktreeStatus(runGit(execFn), cwd);
    // git status failed in this worktree — cannot assess; stay conservative.
    if (!Array.isArray(status) || status.length > 0) return true;
    const effectiveBase = effectiveBaseForWorkstream(wsId, workstreamBaseShas, baseSha);
    if (!effectiveBase) continue; // no base → no commit evidence possible for this tree
    // An unreadable count is conservative evidence (handled below); a missing
    // base has no commit evidence at all (handled above).
    const ahead = await commitsAheadOfBase(runGit(execFn), cwd, effectiveBase);
    // An unreadable count is treated as evidence (conservative), mirroring the
    // status branch above: a gate is never suppressed on an unknown state.
    if (!("commits" in ahead)) {
      trace(`work-driver: develop evidence check conservative for ${wsId} — ${ahead.unreadable}`);
      return true;
    }
    if (ahead.commits > 0) return true;
  }
  // No worktree had uncommitted changes or commits ahead of its base. The
  // fanout produced nothing — there is no diff evidence to gate on, so both
  // gates are skipped (return false). The pre-#679 behaviour skipped on a
  // single failed sibling; this skips ONLY when the whole fanout is empty.
  return false;
}

/**
 * #1016 — the safety-net commit for ONE workstream worktree, shared by the
 * per-workstream green check (runAt) and the post-fan-out sweep. Returns the
 * `safety-net-commit` event when it committed, undefined otherwise. Never throws.
 * An unreadable status or commit count skips the commit and appends a note to
 * `notes` (a tri-state unknown is never treated as zero commits).
 */
export async function safetyNetWorktree(
  wsId: string,
  repoRoot: string,
  cwd: string,
  effectiveBase: string,
  execFn: ExecFn = execp,
  notes: string[] = [],
): Promise<WorkEvent | undefined> {
  if (!safetyNetEnabled()) return undefined;
  // Containment first: a state path outside `<repoRoot>/.worktrees/` is a
  // refusal and no git write may run against it (a repo root is never a worktree).
  try {
    assertInsideWorktrees(repoRoot, cwd);
  } catch (err) {
    const note = `${wsId}: safety net refused — ${errText(err)}`;
    trace(`work-driver: ${note}`);
    notes.push(note);
    return undefined;
  }
  const now = Date.now();
  const git = runGit(execFn);

  // (1) Check if worktree has uncommitted changes. Skip driver artefacts: .pi/ and tmp/
  // (same exclusion as cap-checkpoint). commitEntriesOf drops every .pi/ and tmp/ path, tracked or not.
  const status = await worktreeStatus(git, cwd);
  if (!Array.isArray(status)) {
    const note = `${wsId}: safety net skipped — git status unreadable — ${status.unreadable}`;
    trace(`work-driver: ${note}`);
    notes.push(note);
    return undefined;
  }
  // #1016 — a staged rename across the driver boundary (`.pi/x` <-> `src/x`) cannot
  // be committed by path: the commit would record only one side (a deletion of
  // the source). Refuse; the retry's reset saves both sides to the patch.
  const crossing = status.find(
    (e) =>
      e.pairedWith !== undefined && isDriverArtefact(e.path) !== isDriverArtefact(e.pairedWith),
  );
  if (crossing) {
    const note = `${wsId}: safety net refused — staged rename crosses the driver boundary (${crossing.pairedWith} <-> ${crossing.path}); not committed`;
    trace(`work-driver: ${note}`);
    notes.push(note);
    return undefined;
  }
  // Only non-driver paths are committed: a .pi/ or tmp/ edit is never staged here.
  const candidates = commitEntriesOf(status);

  // (AC3) Clean tree → nothing to commit → skip.
  if (candidates.length === 0) {
    trace(`work-driver: safety net skipped ${wsId} — tree clean`);
    return undefined;
  }

  // (2) Check if worktree already has commits ahead of its EFFECTIVE base — the
  // per-workstream effective base, not the global baseSha (#679). A dependent
  // workstream's worktree was created from its dependency's post-commit SHA, so
  // comparing against the global baseSha would miscount its commits ahead. An
  // unreadable count never licenses a commit.
  const ahead = await commitsAheadOfBase(git, cwd, effectiveBase);
  if (!("commits" in ahead)) {
    const note = `${wsId}: safety net skipped — commit check unreadable — ${ahead.unreadable}`;
    trace(`work-driver: ${note}`);
    notes.push(note);
    return undefined;
  }

  // (AC2) Already has commits ahead of its effective base → developer committed
  // correctly → skip. Leftovers are not committed here: they were not part of the
  // reviewed commit, so they are listed in a note for the handoff instead.
  if (ahead.commits > 0) {
    const shown = candidates
      .slice(0, 10)
      .map((e) => e.path)
      .join(", ");
    const more = candidates.length > 10 ? ` (+${candidates.length - 10} more)` : "";
    notes.push(
      `${wsId}: safety net skipped after ${ahead.commits} developer commit(s); ${candidates.length} uncommitted path(s) left out of the PR — ${shown}${more}`,
    );
    trace(
      `work-driver: safety net skipped ${wsId} — already has ${ahead.commits} commit(s) ahead of its base`,
    );
    return undefined;
  }

  const workPaths = candidates.map((e) => e.path);

  // Fire the safety net: stage the work paths and commit.
  trace(`work-driver: safety net firing for ${wsId} — ${workPaths.length} uncommitted path(s)`);
  let commitSha: string | undefined;
  // One `git add` for the present paths (chunked), and `rm --cached` for the
  // absent ones (a staged rename's origin is already out of the index, so `git
  // add` has nothing to match). A failed stage records its git error and commits
  // nothing: a partial stage must never turn green.
  try {
    await stagePaths(
      git,
      cwd,
      workPaths.filter((p) => existsSync(join(cwd, p))),
    );
    await stageDeletions(
      git,
      cwd,
      workPaths.filter((p) => !existsSync(join(cwd, p))),
    );
  } catch (err) {
    // A chunk may have staged before a later one failed: unstage every work path.
    const unstage = await unstagePaths(git, cwd, workPaths).then(
      () => "",
      (e: unknown) => ` (unstage failed too — ${errText(e)})`,
    );
    const note = `${wsId}: safety net skipped — git add failed — ${errText(err)}${unstage}`;
    trace(`work-driver: ${note}`);
    notes.push(note);
    return undefined;
  }
  // The commit names its paths explicitly, so a `.pi/` or `tmp/` file that was
  // already in the index (staged by someone else) is never swept into it.
  try {
    // Commit with driver-attributed message so the operator can tell
    // this from a developer's seam commit.
    const commitMsg = `wip: driver safety-net commit for ${wsId}`;
    await git(
      ["--literal-pathspecs", "commit", "-q", "--no-verify", "-m", commitMsg, "--", ...workPaths],
      { cwd, maxBuffer: 256 * 1024 },
    );
  } catch (err) {
    const note = `${wsId}: safety net commit failed — ${errText(err)}`;
    trace(`work-driver: ${note}`);
    notes.push(note);
    // The tree is still dirty and nothing was committed; the verify gate will
    // produce the same failure as before the safety net.
    return undefined;
  }
  // #1016 — a staged rename into or out of `.pi/` leaves the driver-owned side
  // in the index after the path-limited commit. Unstage it (the working tree is
  // untouched) so the index holds no driver artefact the commit did not name.
  await unstageDriverArtefacts(git, cwd, wsId, notes);
  // A developer's own commit was already ahead of base: the leftover edits just
  // committed were NOT in that commit. Say so, so the handoff shows what the
  // driver added to the PR beyond the reviewed work.
  if (ahead.commits > 0) {
    const shown = workPaths.slice(0, 10).join(", ");
    const more = workPaths.length > 10 ? ` (+${workPaths.length - 10} more)` : "";
    notes.push(
      `${wsId}: safety net committed ${workPaths.length} leftover uncommitted path(s) after ${ahead.commits} developer commit(s), not in the developer's commit — ${shown}${more}`,
    );
  }
  // The commit has landed. A failed read of its sha must not hide it: the
  // event then names HEAD, and the note says the sha was not read.
  try {
    const { stdout: shaOut } = await git(["rev-parse", "HEAD"], {
      cwd,
      maxBuffer: 64 * 1024,
    });
    commitSha = shaOut.trim();
  } catch (err) {
    commitSha = "HEAD";
    const note = `${wsId}: safety net committed, but the commit sha could not be read — ${errText(err)}`;
    trace(`work-driver: ${note}`);
    notes.push(note);
  }

  if (commitSha) {
    trace(
      `work-driver: safety net committed ${wsId} (${commitSha.slice(0, 8)}) — ${workPaths.length} file(s)`,
    );
    return {
      kind: "safety-net-commit",
      at: now,
      workstreamId: wsId,
      worktreePath: cwd,
      commitSha,
      filesCommitted: workPaths.length,
    };
  }
  return undefined;
}

/**
 * #622 — Apply the mechanical auto-commit safety net after all developer
 * dispatches complete.
 *
 * For each worktree (every step is an argv call through the develop git transport):
 *   1. `git status --porcelain -z` — no commit-eligible path → skip (AC3).
 *   2. `git rev-list --count <effectiveBase>..HEAD` — read only to refuse an
 *      unreadable state (commits already ahead do not skip: leftover edits are
 *      still committed).
 *   3. `git --literal-pathspecs add -- <paths>` (chunked), excluding `.pi/` and `tmp/`.
 *   4. `git --literal-pathspecs commit -m <driver message> -- <paths>`, naming the
 *      same paths so nothing else in the index rides along.
 *   5. `git rev-parse HEAD` for the event's sha; a failed read is noted, not hidden.
 *
 * Returns the (possibly updated) WorkState with a `safety-net-commit` event
 * appended for each worktree the safety net fired on, and any skip notes
 * recorded in plumbReports. Never throws: a git failure degrades to the
 * pre-safety-net behaviour.
 */
export async function applySafetyNet(
  ctx: DriverContext,
  state: WorkState,
  only?: ReadonlySet<string>,
): Promise<WorkState> {
  if (!safetyNetEnabled()) {
    trace("work-driver: safety net disabled (PI_ENSEMBLE_SAFETY_NET_COMMIT=0)");
    return state;
  }

  const worktrees = state.pipelineState.worktrees ?? {};
  const baseSha = state.pipelineState.baseSha;
  const workstreamBaseShas = state.pipelineState.workstreamBaseShas;
  const execFn: ExecFn = ctx.verifyExecFn ?? execp;
  // #679 — no global baseSha is no longer a hard skip: a dependent workstream
  // may still carry a valid per-workstream base (its dependency's post-commit
  // SHA) in `workstreamBaseShas`. We resolve each workstream's effective base
  // individually and skip ONLY the worktrees whose base is unresolvable.
  const hasAnyBase =
    isValidBaseSha(baseSha) ||
    Object.values(workstreamBaseShas ?? {}).some((s) => isValidBaseSha(s));
  if (!hasAnyBase) {
    // No base anywhere (older state files / ops-dispatch fallback):
    // the verify gate uses the uncommitted-counts behaviour and the
    // safety net has nothing to commit against — skip.
    trace("work-driver: safety net skipped — no valid baseSha (global or per-workstream)");
    return state;
  }

  const events: WorkEvent[] = [];
  const notes: string[] = [];

  for (const [wsId, cwd] of Object.entries(worktrees)) {
    // A workstream whose verdict is not ok keeps its leftover edits uncommitted:
    // committing a failed attempt's partial work would put it on the branch under a FAIL verdict.
    if (only !== undefined && !only.has(wsId)) continue;
    const effectiveBase = effectiveBaseForWorkstream(wsId, workstreamBaseShas, baseSha);
    if (!effectiveBase) {
      trace(
        `work-driver: safety net skipped ${wsId} — no valid base (global or per-workstream) to compare against`,
      );
      continue;
    }
    const ev = await safetyNetWorktree(wsId, ctx.repoRoot, cwd, effectiveBase, execFn, notes);
    if (ev) events.push(ev);
  }

  const withEvents = events.length === 0 ? state : appendEvent(state, ...events);
  return withPersistNotes(withEvents, notes);
}

/** #1016 — after the path-limited commit, unstage every driver-artefact path the
 *  index still holds (a staged rename into or out of `.pi/` leaves one there).
 *  Literal pathspecs; index only. A failure or a surviving entry is a note, never
 *  a throw: the commit has already landed. */
async function unstageDriverArtefacts(
  git: GitExec,
  cwd: string,
  wsId: string,
  notes: string[],
): Promise<void> {
  let staged: string[];
  try {
    const { stdout } = await git(["diff", "--cached", "--name-only", "--no-renames", "-z"], {
      cwd,
      maxBuffer: 256 * 1024,
    });
    staged = stdout.split("\0").filter((p) => p !== "" && isDriverArtefact(p));
  } catch (err) {
    notes.push(`${wsId}: could not read the index after the safety-net commit — ${errText(err)}`);
    return;
  }
  if (staged.length === 0) return;
  try {
    await unstagePaths(git, cwd, staged);
  } catch (err) {
    notes.push(
      `${wsId}: index still holds ${staged.length} driver-artefact path(s), e.g. ${JSON.stringify(staged[0])} — ${errText(err)}`,
    );
  }
}

/**
 * work-driver-branch-cause — #1642 (interactive #1557): the branch step refused
 * the cycle, and the handoff told the operator to go look for a sleep/suspend.
 *
 * The refusal had a name. `mechanizedBranchSetup` throws `DirtyWorktreeError`
 * (or `WorktreeScanError`), the branch step records the refusal verbatim in a
 * `plumbReports` row for step `branch`, and caps the cycle `step-failed:branch`.
 * The cause table's generic entry for that template is `kindDriven`, and the
 * branch refusal is not a dispatch — no failure kind exists to read — so
 * `failureOf` synthesises `process` and the operator was told the host
 * suspended, with a `caffeinate` command and no reference to the worktree that
 * actually blocked the cycle. The real reason was sitting two fields away.
 *
 * So this module reads the evidence the branch step already recorded. A branch
 * refusal is local state the operator CAN clear — inspect the salvage, remove
 * the worktree, re-run — so it sits in `environment` with a concrete action,
 * the same class the table gives the caps that name a leftover
 * (`deferred-creation:develop`, `repo-root-residue`). Not `pi-rukas`: the
 * driver's guard worked as designed when the tree genuinely held work, and the
 * case that made it refuse a build tree (`!! dist/`) is fixed in
 * worktree-loss.ts. Not the kind-driven `process` verdict either: the refusal
 * is not a dispatch, so there is no host to blame.
 *
 * The shape of a refusal, in order, all tolerant: the refusal's own wording
 * (`DIRTY_WORKTREE_REFUSAL_MARK`, the shared constant the producer writes, so
 * the two sites cannot drift) in a `plumbReports` row for step `branch`, or in
 * the cap-hit's `evidence` (a future producer may record it there instead).
 * A `step-failed:<step>` with no such evidence falls through to the generic
 * table entry untouched — this module never guesses, and the sibling refusal
 * (`WorktreeScanError`, whose wording names no worktree) falls through with it:
 * there is no path to tell the operator to remove, so guessing one would be
 * the failure this module exists to close.
 */

import type { CauseVerdict } from "./work-driver-cause-class.ts";
import { lastCapHit } from "./workflow-state-cap.ts";
import type { WorkState } from "./workflow-state.ts";
import { DIRTY_WORKTREE_REFUSAL_MARK } from "./worktree-loss.ts";

/** The step whose cap this reads. `step-failed:branch` only. */
const BRANCH_STEP = "branch";

/**
 * Whether the cycle's recorded evidence says the branch step refused a
 * worktree, rather than failing for a reason nobody recorded.
 *
 * The branch step writes two shapes of plumb report: the refusal (this mark)
 * and the ordinary "mechanized branch setup failed, falling back to ops"
 * report, which is NOT a refusal and must not classify here — that one already
 * reaches the ops fallback and only caps if the fallback fails too.
 */
export function branchRefusalEvidence(state: WorkState): string | undefined {
  const refusal = (body: string | undefined): string | undefined =>
    body?.includes(DIRTY_WORKTREE_REFUSAL_MARK) ? body : undefined;
  for (const report of [...(state.pipelineState.plumbReports ?? [])].reverse()) {
    if (report.step !== BRANCH_STEP) continue;
    const hit = refusal(report.body);
    if (hit !== undefined) return hit;
  }
  return refusal(lastCapHit(state, `step-failed:${BRANCH_STEP}`)?.evidence);
}

/** The path the refusal names, from its first line; undefined when it names none. */
function refusalPath(body: string): string | undefined {
  const match = /existing worktree (\S+)/.exec(body);
  const raw = match?.[1];
  return raw === undefined || raw.length === 0 ? undefined : raw;
}

/**
 * A worktree path safe to put into the removal command the handoff prints.
 *
 * `refusalPath` reads untrusted text — the plumb body is built from the
 * worktree path, which ultimately derives from the repo root, and a future
 * producer may write the whole message through a model. The extracted token is
 * interpolated into `git worktree remove --force -- <path>` in the operator's
 * own shell, so it is admitted only in the exact shape a driver worktree path
 * takes: absolute, and made solely of characters inert inside a shell word
 * (`;`, backtick, `$`, quote, space, `&`, `|`, `<`, `>` all fail). Anything
 * else is dropped in favour of the `<path>` placeholder the no-path branch
 * already emits — the operator then reads the path off the quoted evidence
 * rather than pasting one the driver could not vouch for.
 */
const SAFE_WORKTREE_PATH = /^\/[A-Za-z0-9._/@+-]+$/;

function removalTarget(path: string | undefined): string {
  if (path === undefined) return "<path>";
  if (!SAFE_WORKTREE_PATH.test(path) || !path.includes("/.worktrees/")) return "<path>";
  return path;
}

/** The salvage line's own wording, exported so the classifier reads it as a shared constant. */
export const SALVAGE_NOTE_MARK = "Salvaged dirty worktree";

/**
 * The salvage directory from a salvage line. The line reads
 * `Salvaged dirty worktree <wt> (workstream '<id>') to <dir> (salvage.patch, …)`,
 * so the directory is what sits between ` to ` and the manifest parenthetical —
 * NOT the first path on the line, which is the worktree itself.
 */
function salvageDirOf(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  const afterTo = line.split(") to ")[1] ?? line.split(" to ")[1];
  if (afterTo === undefined) return undefined;
  const dir = afterTo.split(" (")[0]?.trim();
  return dir === undefined || dir.length === 0 ? undefined : dir;
}

/** A salvage line naming the same worktree the refusal blocked on, if the report carries one. */
function salvageLine(body: string, wtPath: string | undefined): string | undefined {
  if (wtPath === undefined) return undefined;
  return body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(SALVAGE_NOTE_MARK) && l.includes(wtPath));
}

/**
 * The verdict for a `step-failed:branch` whose evidence is a worktree refusal.
 * `undefined` when there is no such evidence — the caller then keeps the
 * generic template entry, which is today's behaviour for a branch step that
 * genuinely failed without recording why.
 *
 * `lines` is the caller's evidence builder (bounded, de-duplicated, redacted):
 * the classifier owns the evidence budget, this module only names the text.
 */
export function branchRefusalVerdictFor(
  state: WorkState,
  cap: string,
  issue: number,
  lines: (texts: readonly (string | undefined)[]) => string[],
): CauseVerdict | undefined {
  if (cap !== `step-failed:${BRANCH_STEP}`) return undefined;
  const body = branchRefusalEvidence(state);
  if (body === undefined) return undefined;
  const where = refusalPath(body);
  // The branch step salvages the refused tree before capping, and writes the
  // salvage directory into the SAME plumb report. Quote that line rather than
  // inventing a `<scratch>` placeholder — the operator has to open a real path.
  const salvageDir = salvageDirOf(salvageLine(body, where));
  const inspect =
    salvageDir === undefined
      ? "inspect the worktree itself"
      : `inspect the salvage at ${salvageDir}`;
  const target = removalTarget(where);
  const inspectExtra = target === "<path>" ? " — inspect the worktree named in the evidence" : "";
  const userAction = `${inspect}${inspectExtra}, remove the worktree with \`git worktree remove --force -- ${target}\`, then re-run \`/work ${issue}\``;
  return {
    causeClass: "environment",
    causeReason: "a stale worktree left by an earlier cycle for this issue blocked the branch step",
    causeEvidence: lines([body]),
    userAction,
  };
}

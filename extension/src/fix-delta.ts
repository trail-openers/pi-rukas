/**
 * fix-delta — what moved since the previous review round, for the round that
 * follows a fix pass.
 *
 * Every re-review after a fix pass was handed the whole diff again and nothing
 * else: the driver's lens rounds read `origin/<base>..origin/<branch>`, and the
 * adversarial re-review reads `<baseSha>..HEAD` of the worktree. A regression
 * the fix itself introduced is then one changed token somewhere in material the
 * reviewer has already read once, and nothing says where to look. Measured on
 * one cycle: a lens fix turned `drawMeter(view.meter)` into `drawMeter(meter)`,
 * and the adversarial re-review plus the next lens round both passed it; the
 * next fix developer, reading the code, found it at once.
 *
 * The full diff stays — it is the thing being approved, and a delta alone
 * hides how the fix interacts with the rest. This adds one labelled section
 * with `git diff <head the last round read>..<head now>`, to be read first.
 *
 * Omitted, never guessed: no recorded previous head, a head that did not move,
 * a previous head that is not an ancestor of this one (a rebase or a
 * re-integration rewrote it), or any git failure all yield "".
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isFullCommitSha } from "./review-head-sha.ts";
import { trace } from "./trace.ts";
import type { WorkState } from "./workflow-state.ts";

const execFileP = promisify(execFile);

/** Bound on the delta text, so a large fix cannot crowd out the full diff. */
export const FIX_DELTA_MAX_CHARS = 40_000;

/** The label the section opens with (asserted by the smoke test). */
export const FIX_DELTA_HEADING = "CHANGED BY THE LAST FIX PASS";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** The full commit SHA a ref points at in `cwd`, or undefined when unreadable. */
async function commitOf(cwd: string, ref: string): Promise<string | undefined> {
  if (ref.startsWith("-")) return undefined;
  try {
    const sha = (await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
    return isFullCommitSha(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The prompt section for the delta `prev..head`, with its leading blank line,
 * or "" when there is no delta that can be stated honestly.
 */
export async function fixDeltaSection(
  cwd: string,
  prev: string | undefined,
  head: string | undefined,
): Promise<string> {
  if (!prev || !head || !isFullCommitSha(prev) || !isFullCommitSha(head) || prev === head) {
    return "";
  }
  let delta: string;
  try {
    await git(cwd, ["merge-base", "--is-ancestor", prev, head]);
    delta = await git(cwd, ["diff", `${prev}..${head}`]);
  } catch (err) {
    trace(
      `fix-delta: omitted — ${prev.slice(0, 8)}..${head.slice(0, 8)} is not a readable ancestor range (${(err as Error).message?.slice(0, 120)})`,
    );
    return "";
  }
  if (!delta.trim()) return "";
  const range = `${prev.slice(0, 12)}..${head.slice(0, 12)}`;
  const cut = delta.length > FIX_DELTA_MAX_CHARS;
  const body = cut
    ? `${delta.slice(0, FIX_DELTA_MAX_CHARS)}\n[fix delta truncated: ${delta.length - FIX_DELTA_MAX_CHARS} more chars — read the rest with \`git diff ${range}\`]`
    : delta;
  return `\n\n${FIX_DELTA_HEADING} (\`git diff ${range}\` — everything that moved since the previous review round read this work). Review this delta FIRST, and specifically for regressions the fix introduced: a fix that resolves one finding can break the line beside it, and the rest of the diff was already reviewed last round. The full diff is still what you are approving.\n\`\`\`diff\n${body}\n\`\`\``;
}

/**
 * The lens round's section and the head it read. The head is the pushed
 * branch — what `readIntegratedDiff` diffs — not any worktree's HEAD.
 */
export async function lensFixDelta(
  repoRoot: string,
  branchName: string | undefined,
  prev: string | undefined,
): Promise<{ head?: string; section: string }> {
  const head = branchName ? await commitOf(repoRoot, `origin/${branchName}`) : undefined;
  return { head, section: await fixDeltaSection(repoRoot, prev, head) };
}

/**
 * The adversarial re-review's section for one workstream's worktree. The
 * previous head is the worktree HEAD the develop fix pass started from (the
 * tree the last review read), or — on the re-review that follows a lens fix —
 * the branch head the lens round read, which the lens-fix worktree was
 * repositioned to before the fixer ran. Any other worktree fails the ancestor
 * test and gets no section.
 */
export async function adversarialFixDelta(
  state: WorkState,
  workstreamId: string,
  cwd: string,
): Promise<string> {
  let prev: string | undefined;
  if (state.pipelineState.lastCompletedStep === "lens-fix") {
    prev = state.pipelineState.lensReviewedHead;
  } else {
    for (const e of state.eventLog) {
      if (e.kind === "adversarial-fix-applied" && e.workstreamId === workstreamId) {
        prev = e.headBefore;
      } else if (
        e.kind === "adversarial-round" &&
        e.verdictParsed &&
        (e.workstreamId ?? "default") === workstreamId
      ) {
        // A parsed review after the fix pass has already seen its delta.
        prev = undefined;
      }
    }
  }
  if (!prev) return "";
  return fixDeltaSection(cwd, prev, await commitOf(cwd, "HEAD"));
}

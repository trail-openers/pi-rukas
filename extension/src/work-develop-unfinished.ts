/**
 * work-develop-unfinished — #1768: a develop pass the child reported as
 * finished is done only when the child COMMITTED its own work.
 *
 * #1403 closed the case where the child's engine died. This is the sibling
 * case: the child exits 0, says so itself — and has not finished the step. The
 * two orchard cycles that filed it (cycle-id, cycle-id) show
 * the console order that proves the driver believed the child rather than the
 * worktree:
 *
 *   05:00:16  safety net firing for default — 6 uncommitted path(s)
 *   05:00:16  safety net committed default (d81ce007) — 6 file(s)
 *   05:00:16  agent done: developer in 142s
 *   05:00:15  developer  Status: done — … docs section + test/review_test.sh
 *             remain, then the gate. Continuing.
 *
 * Three defects composed into that shape, and this module owns the middle one:
 *
 *  1. `developPassIsOk` is purely child-reported (`res.ok && !res.errorStop`).
 *     Its contract is UNCHANGED — it stays the one rule for what the CHILD
 *     claimed. What changed is that the green path no longer stops there.
 *  2. `classifyDevelopPass` early-returned on the green path WITHOUT reading
 *     the worktree (`uncommitted: []`), so the only later reader of the tree
 *     was the #622 safety net — which COMMITS the leftover dirt when the pass
 *     has 0 commits ahead, and that driver-made commit then satisfied
 *     `greenCountsAsWork`'s commits>0 rule. A quit mid-step became a completed
 *     step riding into commit-pr on a `wip: driver safety-net commit`.
 *  3. The net ran BEFORE the green check in both develop phases, so it could
 *     never be told about an unfinished verdict — by the time the verdict was
 *     knowable, the net had already committed the evidence away.
 *
 * The rule, applied at classify time before any net runs: a pass the child
 * reported as finished counts as done only when the worktree holds >=1 commit
 * ahead of its effective base that the DRIVER did not create. The net's own
 * commits are the safety-net commit subject; a pass whose only commits ahead
 * are those is not done either, so a resumed cycle cannot read the net's
 * earlier recovery as the child's work.
 *
 * Fail closed, like `greenCountsAsWork`: an unreadable tree or commit count is
 * never read as clean. And the net keeps its charter — recovery for a pass that
 * earned its green, never a paper-over for one that did not.
 *
 * The pure rule and the record vocabulary are in
 * `work-develop-unfinished-facts.ts` (re-exported below); the one corrective
 * round is in `work-develop-unfinished-round.ts`; the step-level decision is in
 * `work-develop-unfinished-pass.ts`. All three are the §12 size split, not
 * three places one rule is decided.
 */

import * as lifecycle from "./lifecycle-events.ts";
import { trace } from "./trace.ts";
import { boundJoinFailures } from "./work-develop-cap-evidence.ts";
import {
  type ExecFn,
  type GitExec,
  INVALID_BASE_MSG,
  type StatusEntry,
  commitEntriesOf,
  commitsAheadOfBase,
  errText,
  parseStatus,
  runGit,
} from "./work-develop-git.ts";
import {
  type DevelopUnfinishedFragment,
  type DevelopUnfinishedRecord,
  type GreenReading,
  type OwnCommitCheck,
  decideGreenFromTree,
  unfinishedTreeSentence,
  unfinishedUnrecoverable,
} from "./work-develop-unfinished-facts.ts";
import { appendEvent } from "./workflow-state.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

export * from "./work-develop-unfinished-facts.ts";

/** The commit subject the #622 safety net gives its recovery commit
 *  (`work-driver-safety-net.ts`). The ONE place both sides name it: the net's
 *  message and this module's "not the child's work" test read the same
 *  constant, so rewording the message cannot silently make the net's commits
 *  look like a developer's. */
export const SAFETY_NET_COMMIT_SUBJECT_PREFIX = "wip: driver safety-net recovery commit";

/** How long one git read waits before the tree is called unreadable. Same
 *  bound as the #1403 classifier: generous for a healthy tree, short enough
 *  that a hung git cannot stall the develop fan-out. */
const TREE_READ_TIMEOUT_MS = 30_000;

/** The event's `paths` list, the corrective prompt's path list and the cap
 *  sentence are all bounded: each is rendered verbatim somewhere. */
const EVENT_PATHS_MAX = 20;

/** Bounded `git status --porcelain -z`: the same argv and parse the crash
 *  classifier uses, so "what is in the tree" has one definition across the
 *  develop step. A hung git degrades to `unreadable`, never to `[]`. */
export async function readTreeBounded(
  execFn: ExecFn,
  cwd: string,
): Promise<{ entries: StatusEntry[] } | { unreadable: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const p = execFn("git", {
      cwd,
      argv: ["status", "--porcelain", "-z", "--untracked-files=all"],
      maxBuffer: 16 * 1024 * 1024,
      timeout: TREE_READ_TIMEOUT_MS,
    });
    const settled = await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`git status timed out after ${TREE_READ_TIMEOUT_MS}ms`)),
          TREE_READ_TIMEOUT_MS,
        );
      }),
    ]);
    const parsed = parseStatus(settled.stdout);
    return Array.isArray(parsed) ? { entries: commitEntriesOf(parsed) } : { unreadable: parsed.unreadable };
  } catch (err) {
    return { unreadable: errText(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The commits between `base` and HEAD, oldest first, as one entry per commit:
 * the hash and the subject, NUL-terminated.
 *
 * `%s` alone is not safe here: git expands it to the subject line only, but a
 * commit whose subject itself contains a NUL-free newline still splits across
 * two `%x00`-separated tokens when the format is newline-terminated, and the
 * two arrays this feeds (subjects, hashes) MUST stay index-aligned or a
 * driver-created commit gets discounted against the wrong neighbour — which
 * reads as either a green the child never earned or a `driverOnly` that buries
 * the child's real work. `%H%x09%s%x00` makes one token per commit by
 * construction, so alignment cannot drift and a subject with a newline, a quote
 * or a tab cannot forge an entry.
 */
async function commitLog(
  git: GitExec,
  cwd: string,
  base: string,
): Promise<{ commits: { hash: string; subject: string }[] } | { unreadable: string }> {
  try {
    const { stdout } = await git(["log", "--format=%H%x09%s%x00", "--reverse", `${base}..HEAD`], {
      cwd,
      maxBuffer: 1 * 1024 * 1024,
    });
    const commits = stdout
      // git terminates each entry with the NUL and then ends the line, so the
      // tail is "\n": trim whitespace BEFORE splitting, or the tail becomes a
      // token with no hash separator and the whole reading is refused.
      .replace(/^[\s\0]+|[\s\0]+$/g, "")
      .split("\0")
      .map((tok) => {
        const tab = tok.indexOf("\t");
        // A token without a separator is malformed output, not an empty subject:
        // refuse the whole reading rather than guess which side is which.
        return tab < 0 ? null : { hash: tok.slice(0, tab), subject: tok.slice(tab + 1) };
      });
    if (commits.some((c) => c === null)) {
      return { unreadable: "commit log line without its hash separator" };
    }
    return { commits: commits as { hash: string; subject: string }[] };
  } catch (err) {
    return { unreadable: errText(err) };
  }
}

/** The SHAs the driver committed for one workstream, read from its
 *  `safety-net-commit` records. Older state files carry `commitSha` without
 *  `commitShas`, so both are collected — and a `"HEAD"` placeholder (the net's
 *  documented fallback when the sha could not be read) is dropped rather than
 *  passed to git as a hash. */
export function driverCommitShasFor(events: readonly WorkEvent[], workstreamId: string): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.kind !== "safety-net-commit" || e.workstreamId !== workstreamId) continue;
    for (const sha of [...(e.commitShas ?? []), e.commitSha]) {
      if (/^[0-9a-f]{40}$/.test(sha)) out.push(sha);
    }
  }
  return out;
}

/**
 * The pass's OWN commits ahead of base: the commits the driver did not create.
 *
 * Three states, because two booleans cannot say "the tree has commits and none
 * of them are the child's": a count, `driverOnly`, or `unreadable`. An
 * unreadable base or count is never folded into a count of 0 — that is how a
 * pass with no verifiable work would have read as done.
 */
export async function ownCommitsAheadOfBase(
  execFn: ExecFn,
  cwd: string,
  base: string | undefined,
  /** #1768 — the SHAs the driver itself committed for this workstream (from its
   *  `safety-net-commit` records). Discounted by SHA, because the net commits
   *  its paths explicitly and a later `git add` by the child can carry that
   *  content under the child's own subject, where the prefix cannot see it. */
  driverShas?: readonly string[],
): Promise<OwnCommitCheck> {
  const git = runGit(execFn);
  const ahead = await commitsAheadOfBase(git, cwd, base);
  if ("unreadable" in ahead) return { unreadable: ahead.unreadable };
  if (ahead.commits === 0) return { commits: 0 };
  // Only now is the attribution worth the extra reads: a pass with a developer
  // commit is green whatever the subjects say. `commitsAheadOfBase` already
  // refused an invalid base, so a missing one here is a broken call, not a
  // tree state — named rather than guessed at.
  if (!base) return { unreadable: INVALID_BASE_MSG };
  const excluded = new Set(driverShas ?? []);
  const log = await commitLog(git, cwd, base);
  if ("unreadable" in log) {
    return { unreadable: `commit log unreadable — ${log.unreadable}` };
  }
  // A commit is the child's only if NEITHER rule claims it: the subject (the
  // net's own commit message, the rule for state files predating `commitShas`)
  // and the SHA (exact, and the one that survives the net's content landing in
  // a later commit under the child's own subject).
  const own = log.commits.filter(
    (c) => !c.subject.startsWith(SAFETY_NET_COMMIT_SUBJECT_PREFIX) && !excluded.has(c.hash),
  );
  return own.length > 0 ? { commits: own.length } : { driverOnly: true };
}

/** What the classify seam needs: the reading, plus the raw commit answer (so
 *  the caller's green check reports the count it was given rather than asking
 *  git a second time) and the dirt the pass left. */
export interface GreenPassFields {
  reading: GreenReading;
  own: OwnCommitCheck;
  uncommitted: string[];
}

/** The event fragment for a blocked green. Absent on every other pass — a
 *  pass that committed its own work carries no more `unfinished` than a pass
 *  that did not crash carries `crash`. */
export function unfinishedFragment(reading: GreenReading): DevelopUnfinishedFragment {
  const paths = reading.uncommitted.slice(0, EVENT_PATHS_MAX);
  return {
    tree: reading.unreadable ? "unreadable" : "dirty",
    ...(paths.length > 0 ? { paths } : {}),
    reason: reading.reason ?? "the child reported ok without committing its own work",
  };
}

/** A `branch-completed` for a workstream whose child reported ok and did not
 *  finish: `ok: false` with the unfinished fragment as the finding.
 *
 *  A reading with nothing to show — no dirt, no unreadable tree — is NOT an
 *  unfinished pass (it is the existing GREEN_DOWNGRADE shape, owned by
 *  work-develop-greens.ts), so it deliberately carries no fragment: emitting
 *  `tree: "clean", paths: []` would hand the park a record for a pass this cap
 *  must not name. The caller's `ok: false` still stands. */
export function unfinishedBranchCompleted(args: {
  id: string;
  ms: number;
  reading: GreenReading;
}): WorkEvent {
  const fragment =
    args.reading.unreadable || args.reading.uncommitted.length > 0
      ? unfinishedFragment(args.reading)
      : undefined;
  return {
    kind: "branch-completed",
    step: "develop",
    workstreamId: args.id,
    ok: false,
    ms: args.ms,
    at: Date.now(),
    error: args.reading.reason,
    ...(fragment ? { unfinished: fragment } : {}),
  };
}

/** Read the unfinished records back off the event log — the park and the
 * renderers both go through here, so one event is one finding.
 *
 * The LATEST record per workstream is the only one that counts, and a later
 * clean pass CLEARS the workstream. A corrective round that committed its own
 * work appends a fragment-free `branch-completed`, and a reader that kept the
 * older record would park a cycle whose work is finished — and the corrective
 * round would re-dispatch a workstream that already finished, spending a second
 * child on completed work. Same last-write-wins rule the develop verdict source
 * applies for the same reason. */
export function developUnfinished(events: readonly WorkEvent[]): DevelopUnfinishedRecord[] {
  const latest = new Map<string, DevelopUnfinishedRecord>();
  for (const e of events) {
    if (e.kind !== "branch-completed" || e.step !== "develop") continue;
    if (e.unfinished === undefined) {
      // A develop completion with no fragment is a pass the driver certified:
      // whatever an earlier attempt left uncommitted is no longer unfinished.
      latest.delete(e.workstreamId);
      continue;
    }
    latest.set(e.workstreamId, {
      id: e.workstreamId,
      tree: e.unfinished.tree,
      paths: e.unfinished.paths ?? [],
      reason: e.unfinished.reason,
    });
  }
  return [...latest.values()];
}

/** One workstream the driver could not certify, as the corrective round
 *  consumes it. `cwd` is the tree to finish the work IN — never reset. */
export interface UnfinishedWorkstream {
  id: string;
  cwd: string;
  /** The workstream's effective base (per-workstream SHA, else global). */
  base: string | undefined;
  /** The paths the quitting child left uncommitted. */
  paths: string[];
  /** The classify seam's sentence for the pass. */
  reason: string;
}

/**
 * The corrective round's prompt. It names the paths the child left uncommitted
 * (so the developer sees what is already there), states that the tree was NOT
 * reset, and ends with the commit the quitting child never made — the defect
 * the round must not repeat. `uncommitted` is the driver's own record from
 * classify time, so what the developer is told and what the cap names come
 * from one reading.
 */
export function unfinishedCorrectivePrompt(args: {
  issue: number;
  workstreamId: string;
  parallel: boolean;
  scope?: string;
  paths: string[];
  uncommitted: string[];
}): string {
  const where = args.parallel ? `workstream \`${args.workstreamId}\`` : "single workstream";
  const scope = args.scope ? [`Scope: ${args.scope}`] : [];
  const files = args.paths.length > 0 ? [`In-scope files: ${args.paths.join(", ")}`] : [];
  const left =
    args.uncommitted.length > 0
      ? args.uncommitted
          .slice(0, EVENT_PATHS_MAX)
          .map((p) => `- ${p}`)
          .join("\n") +
        (args.uncommitted.length > EVENT_PATHS_MAX
          ? `\n- (+${args.uncommitted.length - EVENT_PATHS_MAX} more — see \`git status\`)`
          : "")
      : "- (the driver could not read the tree; inspect it with `git status` before deciding anything)";
  return [
    `/work issue #${args.issue} — corrective develop round (${where}).`,
    "",
    "The previous develop pass exited 0 and reported itself done, but it made NO commit of its own ahead of its base and left its work uncommitted in your worktree. The driver therefore did not count that pass as finished, and this is the cycle's ONE corrective round: finish the step and commit it.",
    "",
    ...scope,
    ...files,
    "",
    "## Uncommitted paths the previous pass left in your worktree",
    "",
    left,
    "",
    "Your worktree has NOT been reset: those files are the work in progress and they are on disk now. Do not discard them, do not `git reset --hard`, do not `git clean`.",
    "",
    "  1. Inspect what is there (`git status`, `git diff`) and work out what the previous pass left unfinished — including any test file, doc section or gate it said remained.",
    "  2. Finish that work. Stay inside your scope.",
    '  3. Commit in the worktree: `git add -A` followed by `git commit -m "<concise subject — follow the project\'s commit convention from AGENTS.md>"`. A pass that commits nothing of its own is not done, whatever it reports. Do NOT push: the driver owns the branch.',
    "  4. End your reply with a one-line `## Summary`.",
  ].join("\n");
}

/**
 * #1768 — the develop step's unfinished park: filter the blocked passes, say
 * so on the console, and land the named cap as the event-log TAIL. Returns the
 * parked state, or `undefined` when nothing needs parking (the caller then
 * proceeds to the branches-converged emit and the gates as before).
 *
 * Same shape as `parkOnDevelopCrash` (#1403) and deliberately a sibling rather
 * than a shared helper: the two parks name different failures, different
 * surfaces and different recovery advice, and folding them together would make
 * one cap's prose describe the other's defect.
 *
 * The cap must stay the tail: the caller runs no gate after it, so the step
 * router routes the cycle to handoff on it rather than appending a second,
 * generic cap on the branches-converged verdict.
 */
export function parkOnDevelopUnfinished(state: WorkState, issue: number): WorkState | undefined {
  const blocked = unfinishedUnrecoverable(developUnfinished(state.eventLog));
  if (blocked.length === 0) return undefined;
  // The console says so too, while the handler still knows which workstream
  // quit. Pre-fix the operator's last word was `agent done: developer` printed
  // beside `safety net firing`.
  lifecycle.emitStepNotice(
    "develop",
    `a developer child reported ok without committing its own work (${blocked
      .map((r) => `${r.id}: ${r.tree}`)
      .join(", ")}); the pass is not counted as done and the safety net will not commit it`,
    issue,
  );
  trace(
    `work-driver: develop-incomplete-uncommitted — ${blocked.map((r) => `${r.id} (${r.tree})`).join(", ")}`,
  );
  const named = blocked.map((r) => `${r.id}: ${unfinishedTreeSentence(r)}`).join(" | ");
  return appendEvent(state, {
    kind: "cap-hit",
    at: Date.now(),
    cap: "develop-incomplete-uncommitted",
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence: boundJoinFailures([named]),
  });
}

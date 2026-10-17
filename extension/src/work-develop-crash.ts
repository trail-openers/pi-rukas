/**
 * work-develop-crash — #1403: a develop child whose engine DIED is a named
 * step outcome, not a success.
 *
 * The incident (tehas #238, cycle 238-261015-223744): in develop round 3 the
 * developer child logged `the engine stopped unexpectedly (exit code 1)` and
 * its async job finished 197676 ms later with nothing in `err.txt` saying so.
 * The step then reported `--- step 4/9 develop done in 1490s` and the state
 * event is `kind=step-completed … develop, round 3, recovered: false`. The
 * pass's fix sat UNCOMMITTED in the worktree (`M libexec/stop`, 56 insertions)
 * and was never on the consolidated branch: adversarial round 3 reviewed the
 * tree, the cycle parked, and the code was silently dropped.
 *
 * Three defects compose into that shape, and this module owns the fix for the
 * one that made it invisible:
 *
 *  1. `runOneWorkstream` derived ok from `res.ok && !res.errorStop`. A child
 *     whose engine died exits non-zero with NO errorStop, so a crash landed on
 *     the ordinary failure path — and the ordinary failure path's reason came
 *     from the completion event's `errorTail`, which for this shape was the
 *     child's last narration line, not the crash.
 *  2. Nothing recorded WHERE the crash lives. The only place the crash
 *     survived was the factory's cycle record, as free text in `capReason`
 *     beside an unrelated cap.
 *  3. The safety net never ran for that workstream — the `safety net skipped
 *     default — tree clean` lines exist for rounds 1 and 2 and NOT for round
 *     3, because the net runs only for workstreams whose verdict is `ok`, and
 *     a crashed pass is not ok. Its work therefore stayed uncommitted, in a
 *     tree the driver described as done.
 *
 * The fix is to make the crash a first-class, structured fact: a verdict that
 * says so, an event that says so, and a cap that says so — with the worktree's
 * dirty paths named at the cap, so the handoff tells the operator exactly
 * which file the dead pass left behind rather than reporting `recovered: false`
 * beside a step it called done.
 *
 * Deliberately NOT a retry: whether a crashed child is retried belongs to the
 * step router (`failureEventOf` / the transient-retry budget) and the
 * #1016 one-shot fan-out retry, both out of this issue's scope. This module
 * only refuses to let "no signal" read as "success".
 */

import * as lifecycle from "./lifecycle-events.ts";
import { trace } from "./trace.ts";
import { boundJoinFailures } from "./work-develop-cap-evidence.ts";
import {
  type ExecFn,
  commitEntriesOf,
  commitsAheadOfBase,
  isValidBaseSha,
  runGit,
  worktreeStatus,
} from "./work-develop-git.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

/** The substring of the child's stderr that names a dead engine.
 *
 * Pi's harness prints `the engine stopped unexpectedly (exit code N); the
 * next request restarts it` when the child's model harness dies mid-session.
 * It arrives in `DispatchResult.text` (the collapsed transcript), not as an
 * `errorStop` — pi-ai never saw a request fail, so it never synthesised one.
 */
export const ENGINE_STOPPED_MARKER = "the engine stopped unexpectedly";

/** What the driver believes it saw when it calls a workstream done.
 *
 * `"none"` is the reading "this tree holds no work of the pass at all": no
 * uncommitted paths AND no commits ahead of base. It is distinct from
 * `"clean"` (a clean tree that DOES carry commits ahead of base — the pass
 * committed before it died) and from `"no-commits"` (commits could not be
 * counted, because no base resolved). Collapsing these is what let a dead
 * pass's tree read as an ordinary one. */
export type WorkstreamEvidence = "commits" | "leftover" | "clean" | "none" | "no-commits";

/** The verdict this workstream's dispatch earns. */
export interface CrashVerdict {
  ok: boolean;
  /** Set when the pass is not ok; the reason the handoff renders. */
  reason?: string;
  /** True when the child's engine died mid-pass. */
  crashed: boolean;
  /**
   * The claim the driver can honestly make about the worktree after this pass:
   * commits ahead of base, uncommitted leftovers, or nothing at all. Absent
   * when the tree could not be read.
   */
  evidence?: WorkstreamEvidence;
  /** Uncommitted work paths (non-driver-artefact), bounded. */
  uncommitted: string[];
  /** True when the worktree is dirty and the pass crashed — the shape the
   *  issue's AC2 names: work that exists nowhere but the working tree. */
  lostWork: boolean;
  /** The child's exit code, when it exited — carried onto the event record so
   *  the handoff names `exit 1` the way the console line did. */
  exitCode?: number | null;
  /** True when the crash classification could not resolve a base to compare
   *  against (no per-workstream SHA, no global). Absent (undefined) means a
   *  base WAS used, so an unreadable tree is never confused with the
   *  no-base case by a later reader. */
  noBase?: boolean;
}

/**
 * #1403 — did this child's engine die? Read from the collapsed transcript
 * text only. A `killCause` (pi-rukas ended the child) or an `errorStop`
 * (pi-ai synthesised an error message) is a DIFFERENT shape and arrives
 * through `buildCompletionEvent`'s own branches; this marker is the third
 * shape — neither of those fired, and the child printed its death notice.
 */
export function engineCrashed(result: { text?: string; exitCode?: number | null }): boolean {
  return (result.text ?? "").toLowerCase().includes(ENGINE_STOPPED_MARKER);
}

/** How many uncommitted paths get named before the list says "+N more". */
const SHOWN_PATHS = 10;
/** Cap on the reason string handed to the verdict / event (the tail is bounded
 *  again downstream by `boundJoinFailures`; this keeps a single verdict line
 *  readable). */
const REASON_MAX = 400;

function namePaths(paths: string[]): string {
  if (paths.length === 0) return "none";
  const shown = paths.slice(0, SHOWN_PATHS).join(", ");
  return paths.length > SHOWN_PATHS ? `${shown} (+${paths.length - SHOWN_PATHS} more)` : shown;
}

/**
 * #1403 — the outcome of one develop dispatch, computed from the facts the
 * driver can verify rather than from the child's own claim.
 *
 * `ok` keeps the pre-#1403 rule (`res.ok && !res.errorStop`) and adds the
 * crash: a child whose engine died is never ok. The `evidence` field is the
 * new half — the tree is read with the SAME primitives the #622 safety net
 * uses (`worktreeStatus` + `commitsAheadOfBase`'s porcelain), so "done" and
 * "what is actually in the worktree" come from one place.
 *
 * An unreadable tree is reported as `evidence: undefined`, never as `clean`:
 * absence of evidence is not evidence of absence, and a clean claim a person
 * cannot check is the confident-wrong record this issue exists to remove.
 */
export async function classifyDevelopPass(args: {
  id: string;
  cwd: string;
  /** The workstream's effective base (per-workstream SHA, else global). */
  base: string | undefined;
  execFn: ExecFn;
  result: { ok: boolean; errorStop?: unknown; text?: string; exitCode?: number | null };
}): Promise<CrashVerdict> {
  const { id, cwd, base, execFn, result } = args;
  const crashed = engineCrashed(result);
  const ok = result.ok && result.errorStop === undefined && !crashed;

  const git = runGit(execFn);
  // The base decides what "the pass produced work" means. An invalid/absent
  // base makes the commit half unresolvable, and `commitsAheadOfBase` already
  // says so (it refuses to run git at all) — so it is always asked and its
  // tri-state answer is what `evidence` reads. `noBase` records WHY the count
  // was unavailable, so a later reader never mistakes "could not count" for
  // "counted zero".
  const noBase = !isValidBaseSha(base);
  const ahead = await commitsAheadOfBase(git, cwd, base);
  const status = await worktreeStatus(git, cwd);
  const uncommitted = Array.isArray(status) ? commitEntriesOf(status).map((e) => e.path) : [];
  const readable = Array.isArray(status);

  // The evidence is the PAIR of readings, not the dirt alone: uncommitted
  // paths and commits ahead of base. A dead pass with neither left nothing
  // behind; one with commits made it part-way; one with paths left the work
  // the incident lost.
  let evidence: WorkstreamEvidence | undefined;
  if (readable) {
    if (uncommitted.length > 0) evidence = "leftover";
    else if (!("commits" in ahead)) evidence = "no-commits";
    else evidence = ahead.commits > 0 ? "clean" : "none";
  }

  if (ok)
    return {
      ok: true,
      crashed: false,
      evidence,
      uncommitted,
      lostWork: false,
      exitCode: result.exitCode,
      ...(noBase ? { noBase: true } : {}),
    };

  const tail = typeof result.text === "string" ? result.text.trim().slice(-200) : "";
  const parts: string[] = [];
  if (crashed) {
    parts.push(
      `child engine crashed${result.exitCode === null || result.exitCode === undefined ? "" : ` (exit ${result.exitCode})`}`,
    );
  } else {
    parts.push(tail || "developer did not complete ok");
  }
  if (!readable) {
    parts.push(`worktree state unreadable — ${Array.isArray(status) ? "" : status.unreadable}`);
  } else if (uncommitted.length > 0) {
    parts.push(
      `${uncommitted.length} uncommitted path(s) left in the worktree: ${namePaths(uncommitted)}`,
    );
  } else if (evidence === "no-commits") {
    parts.push(
      noBase
        ? "no base resolved, so whether the pass committed anything could not be established"
        : `commit count unreadable — ${"unreadable" in ahead ? ahead.unreadable : "unknown"}`,
    );
  }
  const reason = parts.join("; ").slice(0, REASON_MAX);
  const lostWork = crashed && uncommitted.length > 0;
  if (crashed) {
    trace(
      `work-driver: develop ${id} — child engine crashed; worktree evidence: ${evidence ?? "unreadable"}${
        uncommitted.length > 0 ? ` (${uncommitted.length} uncommitted path(s))` : ""
      }`,
    );
  }
  return {
    ok: false,
    reason,
    crashed,
    evidence,
    uncommitted,
    lostWork,
    exitCode: result.exitCode,
    ...(noBase ? { noBase: true } : {}),
  };
}

/**
 * #1403 — the structured crash record carried by a `branch-completed` event.
 *
 * Same seam pattern as `workflow-state-events-deferred.ts`: an OPTIONAL field
 * on an existing event kind, so the `WorkEvent` union does not gain a kind
 * (no new validator entry, no new NDJSON row type), and readers that predate
 * it ignore it. Absent means "this branch did not crash" — the absence is a
 * real state, never synthesised.
 *
 * This is the field the issue's third bullet asks for: a crash gets its OWN
 * structured home instead of free text in `capReason` beside an unrelated cap.
 */
export type DevelopCrashFragment = {
  /** The child's exit code, when it exited. Absent when it never did. */
  exitCode?: number | null;
  /** How much of the worktree the driver could read after the death.
   *
   * `"no-base"` is the fourth reading: the tree is readable but no base
   * resolved, so the driver cannot tell whether the pass committed anything.
   * It is NOT `"clean"` — claiming a clean tree on an unresolvable comparison
   * is the confident-wrong record this issue exists to remove. */
  tree: "dirty" | "committed" | "empty" | "unreadable" | "no-commits";
  /** The dirty paths the dead pass left behind (bounded, driver artefacts excluded). */
  paths?: string[];
  /** Why the pass is not ok — the same sentence the verdict carries. */
  reason: string;
};

/** The event's `paths` list is bounded: the handoff renders it verbatim. */
const EVENT_PATHS_MAX = 20;

/** Build the crash fragment for a crashed pass. */
export function crashFragment(v: CrashVerdict): DevelopCrashFragment {
  return {
    ...(v.exitCode === undefined ? {} : { exitCode: v.exitCode }),
    ...(v.evidence === undefined
      ? { tree: "unreadable" as const }
      : v.evidence === "leftover"
        ? { tree: "dirty" as const }
        : v.evidence === "clean"
          ? { tree: "committed" as const }
          : v.evidence === "none"
            ? { tree: "empty" as const }
            : { tree: "no-commits" as const }),
    ...(v.uncommitted.length > 0 ? { paths: v.uncommitted.slice(0, EVENT_PATHS_MAX) } : {}),
    reason: v.reason ?? "child engine crashed",
  };
}

/** A `branch-completed` for a workstream whose dispatch crashed. */
export function crashedBranchCompleted(args: {
  id: string;
  ms: number;
  verdict: CrashVerdict;
}): WorkEvent {
  const v = args.verdict;
  return {
    kind: "branch-completed",
    step: "develop",
    workstreamId: args.id,
    ok: false,
    ms: args.ms,
    at: Date.now(),
    error: v.reason ?? "child engine crashed",
    crash: crashFragment(v),
  };
}

/**
 * #1403 — is any workstream's develop verdict a crash? Reads the
 * `branch-completed` events of the current develop attempt (the same window
 * the #1016 attempt counter uses). A kept/re-recorded green never carries
 * `crash`, so a resumed crash does not re-assert itself.
 */
export function developCrashes(
  events: readonly WorkEvent[],
): Array<{ id: string; tree: string; paths: string[]; reason: string }> {
  const out: Array<{ id: string; tree: string; paths: string[]; reason: string }> = [];
  for (const e of events) {
    if (e.kind !== "branch-completed" || e.crash === undefined) continue;
    out.push({
      id: e.workstreamId,
      tree: e.crash.tree,
      // A `dirty` record always names its paths; the other readings have none
      // to name, and an empty list is the honest answer, not a missing one.
      paths: e.crash.paths ?? [],
      reason: e.crash.reason,
    });
  }
  return out;
}

/**
 * #1403 — the crashed passes whose work the driver cannot account for: the
 * tree is dirty (the safety net will not commit a failed attempt's partial
 * work) or unreadable (the driver cannot claim it is clean). A crash over a
 * clean tree is a genuine loss of nothing — the pass either committed before
 * it died or produced nothing — and does not park the cycle on its own.
 */
export function unrecoverableCrashes(
  events: readonly WorkEvent[],
  okIds: ReadonlySet<string>,
): Array<{ id: string; tree: string; paths: string[]; reason: string }> {
  return developCrashes(events).filter(
    (c) =>
      (c.tree === "dirty" || c.tree === "unreadable" || c.tree === "no-commits") &&
      !okIds.has(c.id),
  );
}

/** Re-export so callers that only need the base-validity check share one home. */
export { isValidBaseSha };

/**
 * #1403 — the develop step's crash park: filter the crashed passes, say so on
 * the console, and append the named cap. Returns the parked state, or
 * `undefined` when no pass needs parking (the caller then proceeds to the
 * branches-converged emit and the gates as before).
 *
 * Lives beside the record it reads rather than in `work-develop-topological.ts`
 * (which sits at the §12 gate) so the rule that decides "this crash parks the
 * cycle" and the shape of the record that proves it cannot drift apart.
 *
 * The park is unconditional on the surviving verdicts: a sibling's green does
 * not make a dead pass's half-written file reviewable, and the #622 safety net
 * above deliberately excluded it (its `only` set is the ok verdicts), so that
 * work exists nowhere but the working tree.
 */
export function parkOnDevelopCrash(
  state: WorkState,
  verdicts: readonly { id: string; ok: boolean }[],
  issue?: number,
): WorkState | undefined {
  const crashed = unrecoverableCrashes(
    state.eventLog,
    new Set(verdicts.filter((v) => v.ok).map((v) => v.id)),
  );
  if (crashed.length === 0) return undefined;
  // #1403 — the console says so too. Pre-fix the operator's last word was
  // `✓ step 4/9 develop finished`; the cap-hit below makes the step router
  // emit `✗ step 4/9 develop failed · cap-hit: develop-child-crash`, and this
  // line names the crash while the handler still knows which workstream died.
  lifecycle.emitStepNotice(
    "develop",
    `a developer child's engine stopped unexpectedly (${crashed
      .map((c) => `${c.id}: ${c.tree}`)
      .join(", ")}); the pass is not counted as done`,
    issue,
  );
  trace(
    `work-driver: develop-child-crash — ${crashed.map((c) => `${c.id} (${c.tree})`).join(", ")}`,
  );
  const named = crashed
    .map(
      (c) =>
        `${c.id}: ${
          c.tree === "dirty"
            ? `${c.paths.length} uncommitted path(s) — ${c.paths.join(", ")}`
            : c.tree === "no-commits"
              ? "commits ahead of base could not be counted — no base resolved or the check was unreadable"
              : "worktree unreadable"
        }`,
    )
    .join(" | ");
  return appendEvent(state, {
    kind: "cap-hit",
    at: Date.now(),
    cap: "develop-child-crash",
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence: boundJoinFailures([named]),
  });
}

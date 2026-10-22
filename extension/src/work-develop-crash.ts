/**
 * work-develop-crash — #1403: a develop child whose engine DIED is a named
 * step outcome, not a success.
 *
 * The incident (orchard #238, cycle cycle-id): in develop round 3 the
 * developer child logged `the engine stopped unexpectedly (exit code 1)` and
 * its async job finished 197676 ms later with nothing in `err.txt` saying so.
 * The step then reported `--- step 4/9 develop done in 1490s` and the state
 * event is `kind=step-completed … develop, round 3, recovered: false`. The
 * pass's fix sat UNCOMMITTED in the worktree (`M scripts/stop.sh`, 56 insertions)
 * and was never on the consolidated branch: adversarial round 3 reviewed the
 * tree, the cycle parked, and the code was silently dropped.
 *
 * Three defects compose into that shape, and this module owns the fix for the
 * one that made it invisible:
 *
 *  1. `runOneWorkstream` derived ok from `developPassIsOk(res)` (`res.ok &&
 *     !res.errorStop` — the predicate now lives here, see below). A child
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
import { namePaths } from "./work-develop-paths.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { boundJoinFailures } from "./work-develop-cap-evidence.ts";
import {
  type ExecFn,
  INVALID_BASE_MSG,
  commitEntriesOf,
  commitsAheadOfBase,
  errText,
  parseStatus,
  runGit,
} from "./work-develop-git.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

/** The substring of the child's collapsed transcript that names a dead engine.
 *
 * Pi's harness prints `the engine stopped unexpectedly (exit code N); the
 * next request restarts it` when the child's model harness dies mid-session.
 * The harness writes the line to the child's **stderr** (which is where it is
 * written during a live run) and `collapseEvents` folds it into
 * `DispatchResult.text` only when the child produced no assistant text at all
 * (`text || stderr || "(no output)"`) — a child that narrated before it died
 * keeps its narration in `text` and its death notice stays in `stderr`, which
 * is why `engineCrashed` reads BOTH streams. The marker never arrives as an
 * `errorStop`: pi-ai never saw a request fail, so it never synthesised one.
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
}

/** What the classify seam is given: the part of a dispatch a verdict is
 *  derived from, plus the child's stderr tail. `errorStop` keeps
 *  `DispatchResult`'s shape rather than being widened to `unknown`, so the
 *  seam tracks the published contract. */
export type DevelopPassResult = Pick<DispatchResult, "ok" | "errorStop" | "text" | "exitCode"> & {
  stderr?: string;
};

/**
 * The ONE rule for "did this develop pass succeed": the child exited clean AND
 * pi-ai did not synthesise an error-stop. `!res.errorStop` (not `=== undefined`)
 * is the pre-#1403 rule and every caller keeps it — a present-but-falsy
 * error-stop is still a provider fault, not a success.
 *
 * Both develop paths call this — `classifyDevelopPass` and the #1005
 * merge-and-retry re-dispatch — so the rule has one home and the module
 * header above describes it by reference rather than restating it.
 */
export function developPassIsOk(result: Pick<DispatchResult, "ok" | "errorStop">): boolean {
  return result.ok && !result.errorStop;
}

/**
 * #1403 — did this child's engine die? Read from the collapsed transcript AND
 * the child's stderr (see `ENGINE_STOPPED_MARKER`: `collapseEvents` folds
 * stderr into `text` only when there was no assistant text). A `killCause`
 * (pi-rukas ended the child) or an `errorStop` (pi-ai synthesised an error
 * message) is a DIFFERENT shape and arrives through `buildCompletionEvent`'s
 * own branches; this marker is the third shape — neither of those fired, and
 * the child printed its death notice.
 */
export function engineCrashed(result: {
  text?: string;
  stderr?: string;
  exitCode?: number | null;
}): boolean {
  const haystack = `${result.text ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
  return haystack.includes(ENGINE_STOPPED_MARKER);
}

/** How many uncommitted paths get named before the list says "+N more". */
const SHOWN_PATHS = 10;
/** Cap on the reason string handed to the verdict / event (the tail is bounded
 *  again downstream by `boundJoinFailures`; this keeps a single verdict line
 *  readable). */
const REASON_MAX = 400;

/** How long the crash classification waits for one git read before calling the
 *  tree unreadable. Generous for a healthy tree (a big monorepo `git status`
 *  is seconds) and short enough that a hung git cannot stall the develop step. */
const TREE_READ_TIMEOUT_MS = 30_000;

/** The classifier's own status reader: same argv, same `-z` parse as
 *  `worktreeStatus`, plus an explicit bound — a hung `git status` (a stale
 *  worktree, a lock left by the child that just died) must degrade to
 *  `unreadable`, not block the develop fan-out. Shared with #1768's own-commit
 *  check (`work-develop-own-commit`), so the two reads can never disagree. */
export function treeReader(execFn: ExecFn): (cwd: string) => Promise<ReturnType<typeof parseStatus>> {
  return async (cwd) => {
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
      return parseStatus(settled.stdout);
    } catch (err) {
      return { unreadable: errText(err) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/**
 * #1403 — the outcome of one develop dispatch, computed from the facts the
 * driver can verify rather than from the child's own claim.
 *
 * `ok` is `developPassIsOk(result)` plus the crash: a child whose engine died
 * is never ok. The `evidence` field is the new half — the tree is read with
 * the SAME primitives the #622 safety net
 * uses (`worktreeStatus` + `commitsAheadOfBase`'s porcelain), so "done" and
 * "what is actually in the worktree" come from one place.
 *
 * An unreadable tree is reported as `evidence: undefined`, never as `clean`:
 * absence of evidence is not evidence of absence, and a clean claim a person
 * cannot check is the confident-wrong record this issue exists to remove.
 *
 * The two git reads run concurrently under an explicit timeout: a hung
 * `git status` (a stale worktree, a lock left by the child that just died)
 * degrades to `evidence: undefined` rather than stalling the develop step,
 * whose write-ahead dispatch marker is already recorded by then.
 */
export async function classifyDevelopPass(args: {
  id: string;
  cwd: string;
  /** The workstream's effective base (per-workstream SHA, else global). */
  base: string | undefined;
  execFn: ExecFn;
  result: DevelopPassResult;
}): Promise<CrashVerdict> {
  const { id, cwd, base, execFn, result } = args;
  const crashed = engineCrashed(result);
  const ok = developPassIsOk(result) && !crashed;

  // The healthy path is answered from the child's own result: the tree
  // readings below exist for the FAILURE record, and on the green path the
  // caller reads only `verdict.ok` (work-develop-run.ts). Reading the tree on
  // every pass would fork git twice per pass to compute fields nobody reads.
  if (ok)
    return {
      ok: true,
      crashed: false,
      uncommitted: [],
      lostWork: false,
      exitCode: result.exitCode,
    };

  const git = runGit(execFn);
  const readTree = treeReader(execFn);
  // The base decides what "the pass produced work" means. An invalid/absent
  // base makes the commit half unresolvable, and `commitsAheadOfBase` already
  // says so (it refuses to run git at all) — so it is always asked and its
  // tri-state answer is what `evidence` reads. The cause is read from `ahead`
  // alone — one predicate decides both the evidence and the explanation, so
  // "could not count because no base" can never be synthesised here.
  //
  // Both reads are independent and bounded: `Promise.all` so a slow tree costs
  // one window not two, and `timeout` so a hung git is an unreadable tree
  // rather than a stalled step.
  const [ahead, status] = await Promise.all([commitsAheadOfBase(git, cwd, base), readTree(cwd)]);
  const noBase = "unreadable" in ahead && ahead.unreadable === INVALID_BASE_MSG;
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
   * `"no-commits"` is the fourth reading: the tree is readable but the commit
   * count was unavailable (no base resolved, or the count itself unreadable —
   * `classifyDevelopPass` distinguishes the two through `INVALID_BASE_MSG`),
   * so the driver cannot tell whether the pass committed anything. It is NOT
   * `"clean"` — claiming a clean tree on an unresolvable comparison is the
   * confident-wrong record this issue exists to remove. */
  tree: "dirty" | "committed" | "empty" | "unreadable" | "no-commits";
  /** The dirty paths the dead pass left behind (bounded, driver artefacts excluded). */
  paths?: string[];
  /** Why the pass is not ok — the same sentence the verdict carries. */
  reason: string;
};

/** The event's `paths` list is bounded: the handoff renders it verbatim. */
const EVENT_PATHS_MAX = 20;

/** The evidence → tree-state ladder: the ONE place the worktree reading is
 *  named, so the event record, the cap evidence, the status line and the
 *  handoff sentence cannot give the same crash four different names. */
const TREE_BY_EVIDENCE: Record<WorkstreamEvidence, DevelopCrashFragment["tree"]> = {
  leftover: "dirty",
  commits: "committed",
  clean: "committed",
  none: "empty",
  "no-commits": "no-commits",
};

/** Build the crash fragment for a crashed pass. */
export function crashFragment(v: CrashVerdict): DevelopCrashFragment {
  return {
    ...(v.exitCode === undefined ? {} : { exitCode: v.exitCode }),
    ...(v.evidence === undefined
      ? { tree: "unreadable" as const }
      : { tree: TREE_BY_EVIDENCE[v.evidence] }),
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
 * One crashed pass, as read back from its event. `tree` reuses the fragment's
 * literal union rather than restating it as `string`, so every downstream
 * comparison is checked against the vocabulary the writer produces.
 */
export type DevelopCrashRecord = {
  id: string;
  tree: DevelopCrashFragment["tree"];
  paths: string[];
  reason: string;
};

/**
 * #1403 — is any workstream's develop verdict a crash? Scans the whole event
 * log's `branch-completed` events. For the develop step's caller that IS the
 * current attempt: the park runs at the step boundary immediately after the
 * fan-out, and a re-dispatched pass re-records its own `branch-completed`;
 * a kept/re-recorded green never carries `crash`, so a resumed crash does not
 * re-assert itself.
 */
export function developCrashes(events: readonly WorkEvent[]): DevelopCrashRecord[] {
  const out: DevelopCrashRecord[] = [];
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
 *
 * No verdict filter: a pass that carries a `crash` fragment is never `ok`
 * (`classifyDevelopPass` forces it), so an ok-id set could exclude nothing.
 */
export function unrecoverableCrashes(events: readonly WorkEvent[]): DevelopCrashRecord[] {
  return developCrashes(events).filter(
    (c) => c.tree === "dirty" || c.tree === "unreadable" || c.tree === "no-commits",
  );
}

/** The operator-facing sentence for one crash's tree state. ONE mapping, used
 *  by the cap evidence, `explainDevelopCrash` and the `/work-status` line, so
 *  the same crash reads the same on every surface. */
export function crashTreeSentence(c: DevelopCrashRecord): string {
  switch (c.tree) {
    case "dirty":
      return `left ${c.paths.length} uncommitted path(s): ${c.paths.join(", ")}`;
    case "committed":
      return "had committed its work before it died, so nothing is left in the worktree";
    case "empty":
      return "left an empty worktree — it had written nothing when it died";
    case "no-commits":
      return "left a tree whose commits could not be counted (no base resolved, or the commit check was unreadable)";
    case "unreadable":
      return "left a worktree the driver could not read";
  }
}

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
export function parkOnDevelopCrash(state: WorkState, issue: number): WorkState | undefined {
  const crashed = unrecoverableCrashes(state.eventLog);
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
  const named = crashed.map((c) => `${c.id}: ${crashTreeSentence(c)}`).join(" | ");
  return appendEvent(state, {
    kind: "cap-hit",
    at: Date.now(),
    cap: "develop-child-crash",
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence: boundJoinFailures([named]),
  });
}

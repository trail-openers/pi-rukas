/**
 * work-develop-unfinished-facts — #1768: the types and the tree reading that
 * decide whether a develop pass the CHILD reported as finished is actually
 * done. Split from `work-develop-unfinished.ts` for the AGENTS.md §12 size
 * gate; the parent module re-exports everything here, so callers and tests
 * read the vocabulary from one place.
 *
 * Why the reading cannot come from the child: `developPassIsOk` is
 * `res.ok && !res.errorStop`, purely child-reported, and the console pair
 * orchard cycle-id / cycle-id recorded shows what believing it
 * cost — `safety net committed default (d81ce007) — 6 file(s)` printed beside
 * the child's own `… docs section + test/review_test.sh remain, then the gate.
 * Continuing.`, and `agent done: developer` after both.
 */

/** What the classify seam is given: the part of a dispatch a verdict is
 *  derived from. Same shape as `work-develop-crash.ts`'s `DevelopPassResult`,
 *  re-declared here rather than imported so neither module depends on the
 *  other's vocabulary for its own input type. */
export type DevelopPassResult = {
  ok: boolean;
  errorStop?: unknown;
  text?: string;
  exitCode?: number | null;
  stderr?: string;
};

/** The tri-state answer of the "did this pass commit its OWN work" read.
 *  `driverOnly` is the third state the pair of booleans cannot express: the
 *  tree has commits ahead of base, and every one of them was created by the
 *  driver's #622 safety net. Those are not the child's work, and a pass whose
 *  only commits are the net's is not done. */
export type OwnCommitCheck = { commits: number } | { driverOnly: true } | { unreadable: string };

/** The reading of the child's uncommitted work. `unreadable` is never folded
 *  into `clean`: absence of evidence is not evidence of absence, and a clean
 *  claim nobody can check is the confident-wrong record this issue removes. */
export type UnfinishedEvidence = "own-commits" | "leftover" | "none" | "unreadable";

/** The record a blocked green leaves on its `branch-completed` event. */
export interface DevelopUnfinishedRecord {
  id: string;
  /** The fragment's own vocabulary — the record is read back from the event,
   *  so it uses `dirty` / `unreadable`, not `UnfinishedEvidence`. */
  tree: "dirty" | "unreadable";
  paths: string[];
  reason: string;
}

/** Re-exported so the record, the fragment and the reading vocabulary all come
 *  from this module. The fragment is the event's field type, declared in
 *  `workflow-state-events-develop-unfinished.ts`. */
export type { DevelopUnfinishedFragment } from "./workflow-state-events-develop-unfinished.ts";

/** What the green-path tree reading concluded. */
export interface GreenReading {
  /** The pass counts as done: the child has >=1 commit of its own ahead of base. */
  done: boolean;
  /** The pass quit mid-step: no own commit, and work sitting in the tree. */
  unfinished: boolean;
  /** The read itself failed — never read as clean. */
  unreadable: boolean;
  evidence: UnfinishedEvidence;
  /** The pass's own uncommitted paths (driver artefacts excluded), bounded. */
  uncommitted: string[];
  /** Set when `unfinished` or `unreadable`; the sentence every surface renders. */
  reason?: string;
}

/** How many uncommitted paths one sentence names before it says "+N more".
 *  Same bound as #1403's crash record, so both read alike. */
export const SHOWN_UNFINISHED_PATHS = 10;

/** Name a path list the way the crash record names one. */
export function nameUnfinishedPaths(paths: string[]): string {
  if (paths.length === 0) return "none";
  const shown = paths.slice(0, SHOWN_UNFINISHED_PATHS).join(", ");
  return paths.length > SHOWN_UNFINISHED_PATHS
    ? `${shown} (+${paths.length - SHOWN_UNFINISHED_PATHS} more)`
    : shown;
}

/**
 * Decide a child-reported green from the two facts the child cannot supply.
 * Pure: the caller supplies the reads, so the rule is testable without git.
 *
 * `own` is the count of commits ahead of the workstream's effective base that
 * the DRIVER did not create; `uncommitted` is the worktree's own dirt with the
 * driver artefacts (`.pi/`, `tmp/`) already excluded.
 */
export function decideGreenFromTree(own: OwnCommitCheck, uncommitted: string[]): GreenReading {
  const dirty = uncommitted.length > 0;
  if ("commits" in own) {
    if (own.commits > 0) {
      // The child committed its own work: green exactly as today, including
      // the net's existing "left out of the PR" note for any leftovers.
      return {
        done: true,
        unfinished: false,
        unreadable: false,
        evidence: "own-commits",
        uncommitted,
      };
    }
    if (dirty) {
      return {
        done: false,
        unfinished: true,
        unreadable: false,
        evidence: "leftover",
        uncommitted,
        reason: `the child reported ok but made no commit of its own and left ${uncommitted.length} uncommitted path(s) in the worktree: ${nameUnfinishedPaths(uncommitted)} — the step is not done`,
      };
    }
    // No own commits and nothing in the tree: the existing GREEN_DOWNGRADE
    // shape, owned by work-develop-greens.ts. Not this module's finding.
    return {
      done: false,
      unfinished: false,
      unreadable: false,
      evidence: "none",
      uncommitted,
    };
  }
  if ("driverOnly" in own) {
    return {
      done: false,
      unfinished: dirty,
      unreadable: false,
      evidence: dirty ? "leftover" : "none",
      uncommitted,
      reason: dirty
        ? `the child reported ok but the only commits ahead of its base are the driver's own safety-net recovery commits, and it left ${uncommitted.length} uncommitted path(s) in the worktree: ${nameUnfinishedPaths(uncommitted)} — the step is not done`
        : `the child reported ok but the only commits ahead of its base are the driver's own safety-net recovery commits — a pass that committed nothing of its own is not done`,
    };
  }
  return {
    done: false,
    unfinished: false,
    unreadable: true,
    evidence: "unreadable",
    uncommitted: [],
    reason: `the child reported ok but the worktree could not be read (${own.unreadable}), so the driver cannot certify the pass as done`,
  };
}

/**
 * The unfinished passes whose work the driver cannot account for: the tree was
 * dirty (the child quit with work in it) or unreadable (the driver cannot
 * claim it is clean). A pass with no dirt and no own commits is the existing
 * GREEN_DOWNGRADE shape and never parks on this cap.
 *
 * Reads the `branch-completed.unfinished` records the classify seam wrote, so
 * the park and the record cannot drift apart — the same rule #1403 applies to
 * `crash`.
 */
export function unfinishedUnrecoverable(
  records: readonly DevelopUnfinishedRecord[],
): DevelopUnfinishedRecord[] {
  return records.filter((r) => r.tree === "dirty" || r.tree === "unreadable");
}

/** The operator-facing sentence for one unfinished pass's tree state. ONE
 *  mapping, used by the cap evidence, the explain renderer and the `/work-status`
 *  line, so one reading never gets three names. */
export function unfinishedTreeSentence(r: DevelopUnfinishedRecord): string {
  return r.tree === "dirty"
    ? `reported ok with no commit of its own and left ${r.paths.length} uncommitted path(s): ${r.paths.join(", ")}`
    : `reported ok over a worktree the driver could not read — ${r.reason}`;
}

/**
 * merge-heads — every merge invocation in one command, at every nesting
 * depth (#962 round 4, #1317 review).
 *
 * The verb door and the REST door read ONE merge: the first one they find
 * (`mergeVerbArgs` / `restDoorTokens`). A second merge is only visible to a
 * walk that visits every segment AND every construct body, so this module
 * is that walk. It counts a merge HEAD (a segment whose command word is the
 * forge verb or a REST `api …/merge` call) wherever it sits:
 *
 *   - top-level segments (`gh pr merge 17 && gh pr merge 5`);
 *   - shell-eval bodies (`bash -c "gh pr merge 17 && gh pr merge 5"`);
 *   - subshell, substitution, backtick and process-substitution bodies
 *     (`gh pr merge 17 "$(gh pr merge 5)"`, `cat <(gh pr merge 5)`).
 *
 * `nested` is set when a head sits inside a substitution-like body of a
 * command that is not itself a bare subshell (`echo $(gh pr merge 3)`,
 * `gh pr view "$(gh pr merge 5)"`): a merge whose outcome depends on
 * substitution output cannot be checked against one PR, so the caller
 * refuses it. A bare subshell `(gh pr merge 17)` is the merge itself, not a
 * wrapper around one, and is not nested.
 *
 * `repoSelectors` counts the repo flags (`-R`, `--repo`, `--project`, and
 * their glued / `=` spellings) on every head segment. gh and glab take the
 * LAST selector while the guard reads the first; more than one is refused.
 *
 * The walk is bounded by MAX_CONSTRUCT_DEPTH. Past the bound it stops and
 * sets `deep` — the caller refuses, never reads the unvisited bodies as
 * clean. Cost is O(depth × n): each level tokenises only its own text.
 */

import { restDoorTokens } from "./bash-merges-pr.ts";
import { MAX_CONSTRUCT_DEPTH, gluedRepoValue, rawTokens, shellSegments } from "./merge-tokens.ts";
import { innerBodies, matchMergeVerb, mergeVerbUnwrapOne } from "./merge-verb-head.ts";

export interface MergeHeadScan {
  /** Merge heads anywhere in the command, each counted once. */
  heads: number;
  /** A head sits inside a substitution-like body (not a bare subshell). */
  nested: boolean;
  /** Repo selector flags summed over every head segment. */
  repoSelectors: number;
  /** The walk ran out of nesting budget with bodies left unvisited. */
  deep: boolean;
}

/** Scan every merge head in `command`, at every depth (see module doc). */
export function scanMergeHeads(command: string): MergeHeadScan {
  const acc: MergeHeadScan = { heads: 0, nested: false, repoSelectors: 0, deep: false };
  scanText(command, MAX_CONSTRUCT_DEPTH, false, acc);
  return acc;
}

function scanText(text: string, depth: number, inSubst: boolean, acc: MergeHeadScan): void {
  for (const seg of shellSegments(text)) {
    if (acc.deep) return;
    const head = matchMergeVerb(seg) !== undefined || restDoorTokens(seg) !== undefined;
    const shellEval = mergeVerbUnwrapOne(seg);
    const bodies = innerBodies(seg);
    if (shellEval === undefined && bodies.length === 0) {
      if (head) countHead(seg, inSubst, acc);
      continue;
    }
    if (depth <= 0) {
      acc.deep = true;
      return;
    }
    // A segment that opens with `(` is a bare subshell: its body IS the
    // merge, so the segment itself is not counted separately and the body
    // is not "nested" in a substitution. Every other body is substitution-
    // like (`$( … )`, backticks, `<( … )`).
    const subshell = seg.trimStart().startsWith("(");
    if (head && !subshell) countHead(seg, inSubst, acc);
    if (shellEval !== undefined) scanText(shellEval, depth - 1, inSubst, acc);
    for (const body of bodies) {
      scanText(body, depth - 1, inSubst || !subshell, acc);
      if (acc.deep) return;
    }
  }
}

function countHead(seg: string, inSubst: boolean, acc: MergeHeadScan): void {
  acc.heads++;
  if (inSubst) acc.nested = true;
  acc.repoSelectors += repoSelectorsIn(seg);
}

/** The repo selector flags on one segment's own tokens. */
function repoSelectorsIn(seg: string): number {
  const toks = rawTokens(seg);
  if (toks.terminated === false) return 0;
  let n = 0;
  for (const t of toks.list) {
    if (t === "-R" || t === "--repo" || t === "--project" || gluedRepoValue(t) !== undefined) n++;
  }
  return n;
}

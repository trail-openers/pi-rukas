#!/usr/bin/env bun
/**
 * #1391 task-e part 2 — the account a severed lens-fix attempt leaves behind
 * must be TRUE.
 *
 * Part 1 (`test-work-driver-retry-dirty-tree.ts`) pins the git mechanics
 * against real repos: the incident reproduced, the preserve-then-clean seam,
 * the refused save, the reposition. This file pins the sentence the operator
 * reads afterwards.
 *
 * Why it matters: `lostAttemptLine` is the only thing the operator sees about
 * a lost attempt, and before #1391 it said one thing about every step —
 * "the step restarts from the beginning". For a lens-fix whose tree the
 * driver has just cleaned, that sentence is false in the direction that
 * matters: the work did NOT restart from the beginning, it was preserved, and
 * if nobody says where, the operator loses it while believing it was either
 * destroyed or still in place.
 *
 * So the line must: keep carrying what the attempt spent; name the files the
 * lost attempt left; name the ref they are preserved at; stay bounded so it
 * remains a scrollback line; and above all never claim a save that did not
 * happen. That last one is the reason the ref is read from the event log
 * rather than passed in alongside the filenames — a claim of preservation has
 * to be backed by the record of the preservation.
 *
 * Deliberately NOT named `*-live.ts` — offline, no spawn, no network.
 */

import {
  type WorkState,
  appendEvent,
  initialState,
} from "../src/workflow-state.ts";
import { lostAttemptLine } from "../src/work-driver-retry-context.ts";
import { severed } from "./lib/retry-dirty-tree-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const PRESERVED_REF = "refs/pi-rukas/retry-preserved/repo/default/lens-fix-2-abcdef123456";
const FOUR = ["DESIGN.md", "feature.txt", "host/game-view.js", "scratch-notes.txt"];

/** A state whose log carries the record of the save, as the router appends it. */
function withPreservation(): WorkState {
  return appendEvent(
    {
      ...initialState(1391, 1_000_000),
      pipelineState: {
        ...initialState(1391, 1_000_000).pipelineState,
        worktrees: { default: "/does/not/matter" },
        branchName: "feature/issue-1391-lost-line",
      },
    },
    {
      kind: "lens-fix-attempt-preserved",
      at: 1,
      step: "lens-fix",
      workstreamId: "default",
      attempt: 2,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      preservedRef: PRESERVED_REF,
      worktreePath: "/does/not/matter",
      files: FOUR,
    },
  );
}

try {
  const state = withPreservation();

  const line = lostAttemptLine("lens-fix", 2, severed, state, FOUR);
  assert(
    line.startsWith("lens-fix attempt 2 lost: 22m49s, 40 turns"),
    `the line still carries what the attempt spent (got: ${line})`,
  );
  assert(
    line.includes("4 file(s) it left uncommitted") && line.includes("DESIGN.md"),
    `the line says WHERE the surviving work is instead of only that the step restarts (got: ${line})`,
  );
  assert(
    line.includes(PRESERVED_REF),
    "the line names the ref the work is preserved at — a preserved thing the operator cannot locate is a preserved thing they will not find",
  );
  assert(
    line.includes("+1 more)"),
    `an over-long file list is bounded and says how many it omitted (got: ${line})`,
  );
  assert(!line.includes("terminated"), "the provider's own message never reaches the line");

  const short = lostAttemptLine("lens-fix", 2, severed, state, ["DESIGN.md"]);
  assert(
    short.includes("1 file(s) it left uncommitted is preserved") && !short.includes("more)"),
    `a single preserved file reads as one and needs no omission marker (got: ${short})`,
  );

  // Nothing was preserved (no event in the log), so the line says where the
  // files are and claims nothing more than that.
  const noEvent = lostAttemptLine("lens-fix", 2, severed, initialState(1391, 1), ["DESIGN.md"]);
  assert(
    noEvent.includes("1 file(s) it left uncommitted is still in the worktree (DESIGN.md)") &&
      !noEvent.includes("preserved") &&
      !noEvent.includes("refs/pi-rukas"),
    `files named with NO preservation recorded say where they are, and claim no save (got: ${noEvent})`,
  );

  // A step whose retry genuinely does restart from nothing keeps the old
  // sentence byte-for-byte: the extension must not overstate.
  const plain = lostAttemptLine("lens-fix", 2, severed, state, []);
  assert(
    plain ===
      "lens-fix attempt 2 lost: 22m49s, 40 turns, 412k tokens — the step restarts from the beginning",
    `nothing left behind → the line is byte-identical to before (got: ${plain})`,
  );

  // The pre-#1391 call shape — no state, no file list — still compiles and
  // still renders exactly what it rendered before this change.
  const noState = lostAttemptLine("explore", 1, { ...severed, step: "explore", role: "explore" });
  assert(
    noState ===
      "explore attempt 1 lost: 22m49s, 40 turns, 412k tokens — the step restarts from the beginning",
    "an omitted state/files argument is the pre-#1391 call, unchanged",
  );

  // develop's distinct sentence (its worktree outlives the child) is untouched
  // by the addition, even when a file list is supplied for it.
  const dev = lostAttemptLine("develop", 1, { ...severed, step: "develop", role: "developer" }, state, FOUR);
  assert(
    dev.includes("its conversation is gone, files it left in the worktree are kept"),
    `develop's own sentence survives (got: ${dev})`,
  );
} catch (err) {
  console.error(`✗ unexpected error: ${(err as Error).stack?.slice(0, 800) ?? err}`);
  exit = 1;
}

console.log(`\nexit ${exit}`);
process.exit(exit);

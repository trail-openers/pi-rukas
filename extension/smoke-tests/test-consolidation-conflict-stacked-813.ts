#!/usr/bin/env bun
/**
 * #813 fix round — two properties of the consolidated-verify conflict text,
 * both about presenting an inference as an observation. Split out of
 * test-consolidation-conflict-cap-813.ts (AGENTS.md §12 file-size cap); same
 * renderer, one concern per file.
 *
 * (a) a STACKED cycle with NO evidence on the cap must not print a bare
 *     `undefined`. The flat branch has always rendered a fallback sentence for
 *     an absent cap evidence (`observed: ev ?? "no conflict detail was
 *     recorded…"`); the stacked branch interpolated `ev` straight into its
 *     template. It is reachable through work-driver-converge-gate.ts, which
 *     appends `consolidated-verify-conflict` with `...(conflictText ? {
 *     evidence: conflictText } : {})` — no evidence whenever the gate's
 *     failures carry the conflict phrase but no single string matched it.
 *     The fallback is RENDERING only: the coupling scan still reads `ev`
 *     (undefined), so a placeholder sentence can never make "likely coupled"
 *     fire on nothing. Case 5 pins that as a negative — the scan text is
 *     `hit?.evidence` alone, so pointing the scan at the rendered fallback
 *     flips the assertion (verified by mutation).
 *
 * (b) the coupling clause attributes the conflicted file to a SIBLING. The
 *     workstream whose OWN pick failed declaring the file proves nothing — its
 *     own commit colliding with its own file is what a conflict always is — so
 *     skipping `id === conflictedWorkstream` is what makes the sentence an
 *     observation rather than a tautology dressed as a finding.
 */

import { describeObservedConsolidationConflict } from "../src/work-driver-explain-consolidation.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A two-worktree state whose workstreams declare disjoint paths. */
function state(disjoint: { stacked: boolean }): WorkState {
  const s = initialState(813, 1_000_000);
  s.pipelineState = {
    ...s.pipelineState,
    worktrees: { a: "/w/a", b: "/w/b" },
    workstreams: {
      a: { id: "a", scope: "x", paths: ["src/a.ts"], outOfScope: ["src/b.ts"] },
      b: {
        id: "b",
        scope: "y",
        paths: ["src/b.ts"],
        outOfScope: ["src/a.ts"],
        ...(disjoint.stacked ? { dependsOn: ["a"] } : {}),
      },
    },
  };
  return s;
}

/** Append the cap exactly as work-driver-converge-gate.ts does — evidence optional. */
function withCap(state: WorkState, evidence?: string): WorkState {
  const e: Extract<WorkEvent, { kind: "cap-hit" }> = {
    kind: "cap-hit",
    at: 1,
    cap: "consolidated-verify-conflict",
    reviewRound: 0,
    nextStep: "handoff",
    ...(evidence !== undefined ? { evidence } : {}),
  };
  return appendEvent(state, e);
}

// ──────────────────────────────────────────────────────────────────────────
// Case 5 — STACKED cycle, cap with NO evidence. The regression: `${ev}`
// interpolated an absent field and the handoff printed "undefined".
// ──────────────────────────────────────────────────────────────────────────
{
  const text = explainCap("consolidated-verify-conflict", withCap(state({ stacked: true })));
  assert(
    !/undefined/.test(text),
    `case 5: a stacked cycle with no cap evidence prints no literal "undefined" (got: ${text.slice(0, 300)})`,
  );
  assert(
    /no conflict detail was recorded/.test(text),
    `case 5: the absent evidence reads as an absence, like the flat branch (got: ${text.slice(0, 300)})`,
  );
  assert(
    /stacked|dependency/.test(text),
    `case 5: still the stacked-cycle branch, not the flat fallback (got: ${text.slice(0, 200)})`,
  );
  assert(
    /Worktrees:/.test(text),
    `case 5: the worktree list is preserved (got: ${text.slice(0, 200)})`,
  );
  assert(
    !/likely coupled/i.test(text),
    `case 5: an absent evidence renders a fallback but never licenses "likely coupled" (got: ${text.slice(0, 300)})`,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Case 6 — a stacked cycle WITH evidence still prints it verbatim: the guard
// above replaces an absence, it does not swallow the observation.
// ──────────────────────────────────────────────────────────────────────────
{
  const text = explainCap(
    "consolidated-verify-conflict",
    withCap(state({ stacked: true }), "CONFLICT (content): Merge conflict in src/b.ts"),
  );
  assert(
    text.includes("CONFLICT (content): Merge conflict in src/b.ts"),
    `case 6: a stacked cycle with evidence still prints it (got: ${text.slice(0, 300)})`,
  );
  assert(
    !/no conflict detail was recorded/.test(text),
    `case 6: the fallback sentence does not appear when evidence exists (got: ${text.slice(0, 300)})`,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Case 6b — the flat branch keeps ITS fallback (the one the stacked branch was
// brought in line with) and still makes no coupling claim from it. Cross-branch
// guard: fixing the stacked interpolation must not cost the flat branch its
// observation, and must not turn its fallback into scan input.
// ──────────────────────────────────────────────────────────────────────────
{
  const text = explainCap("consolidated-verify-conflict", withCap(state({ stacked: false })));
  assert(
    !/undefined/.test(text),
    `case 6b: the flat branch prints no literal "undefined" either (got: ${text.slice(0, 300)})`,
  );
  assert(
    /no conflict detail was recorded/.test(text),
    `case 6b: the flat branch keeps its fallback sentence (got: ${text.slice(0, 300)})`,
  );
  assert(
    !/likely coupled/i.test(text),
    `case 6b: the flat branch makes no coupling claim from its own fallback (got: ${text.slice(0, 300)})`,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Case 7 — the coupling clause reads a SIBLING's declaration, never the
// conflicted workstream's own. Direct on the renderer so the attribution — not
// git's output — is what is pinned.
// ──────────────────────────────────────────────────────────────────────────
{
  const shared = { a: ["src/a.ts"], b: ["src/shared/types.ts"] };
  const selfClaim = describeObservedConsolidationConflict({
    lead: "consolidated verify could not combine the workstreams' commits",
    conflictedWorkstream: "b",
    appliedBeforeConflict: ["a"],
    conflictedFile: "src/shared/types.ts",
    declaredPathsByWorkstream: shared,
  });
  assert(
    !/likely coupled/i.test(selfClaim),
    `case 7: the conflicted workstream's OWN declared file does not license coupling (got: ${selfClaim.slice(0, 300)})`,
  );
  assert(
    !/which workstream b declared/.test(selfClaim),
    `case 7: no self-attribution clause (got: ${selfClaim.slice(0, 300)})`,
  );
  assert(
    /do NOT re-split on this alone/.test(selfClaim),
    `case 7: the neutral diagnosis runs instead (got: ${selfClaim.slice(0, 300)})`,
  );

  const siblingClaim = describeObservedConsolidationConflict({
    lead: "consolidated verify could not combine the workstreams' commits",
    conflictedWorkstream: "b",
    appliedBeforeConflict: ["a"],
    conflictedFile: "src/a.ts",
    declaredPathsByWorkstream: shared,
  });
  assert(
    /likely coupled/i.test(siblingClaim) &&
      /the conflict names `src\/a\.ts`, which workstream a declared/.test(siblingClaim),
    `case 7: a SIBLING's declared file still licenses the clause (got: ${siblingClaim.slice(0, 300)})`,
  );

  // Both workstreams declared the file: the pick line names the conflicted id
  // ("b"), so an id match must not be what makes a file "declared" — the
  // SIBLING is the one named.
  const both = describeObservedConsolidationConflict({
    lead: "consolidated verify could not combine the workstreams' commits",
    conflictedWorkstream: "b",
    appliedBeforeConflict: ["a"],
    conflictedFile: "src/zzz.ts",
    declaredPathsByWorkstream: { a: ["src/zzz.ts"], b: ["src/zzz.ts"] },
  });
  assert(
    /which workstream a declared/.test(both) && !/workstream b declared/.test(both),
    `case 7: with both workstreams declaring the file, the SIBLING is named (got: ${both.slice(0, 300)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

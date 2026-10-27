#!/usr/bin/env bun
/**
 * #1862 (a) — a merged workstream is never fenced off its own files.
 *
 * The field shape (an external benchmark harness's headless cycle, reported on
 * the issue): the planner merged a documentation workstream into an implementer,
 * and the merged workstream kept the docs half's fence. Its own declared paths
 * sat under the subtree that fence named, so the developer was told not to touch
 * exactly what it had to change, and the develop gate's fence arm judged those
 * files fenced. The deliverable ended partial.
 *
 * `foldTwo` unions both halves' `outOfScope` and used to remove only the entries
 * that were BYTE-IDENTICAL to a merged path. That catches the #572
 * cross-declaration entries (a sibling's `src/b.ts` in a's fence, where b is the
 * half being absorbed) and nothing else — a fence entry is prose, not a path:
 *
 *   - `tests/` is not the string `tests/test_x.py`, so the directory spelling of
 *     the same fence survived;
 *   - `Every file under agents/ and tests/ — this workstream documents, it does
 *     not implement` names no path of its own, so set membership could not see
 *     it at all.
 *
 * The drop lives in `foldTwo` itself, so all four fold sites inherit it (the
 * ceiling fold, the coupling merge, the develop fence merge-and-retry, and the
 * port/contract fold), and every drop is an `UnfenceRecord` the plan step
 * persists — a removal a person can only see in `trace()` is a removal nobody
 * can audit.
 *
 * Controls the fix must NOT break, each pinned below: a SIBLING's fence keeps
 * fencing (the #572 cross-declaration contract), a PROTECTED path keeps its
 * fence, prose that names no path is kept, and a fence that matches nothing this
 * workstream declared is kept.
 *
 * Offline: pure functions over literal workstream objects. No dispatch, no git,
 * no fs.
 */

import { workstreamFromArgs } from "../src/work-driver-plan-workstreams.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import {
  foldMerged,
  foldSelfFenceNotes,
  foldTwoForTests,
} from "./lib/fold-two-helpers.ts";
import { VALID } from "./lib/plan-outofscope-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The issue's worked example: a docs half folded into an implementer. */
function fieldHalves(): [Workstream, Workstream] {
  return [
    workstreamFromArgs({
      ...VALID,
      id: "a",
      scope: "implement the change",
      paths: ["agents/x.md", "tests/test_x.py"],
      outOfScope: [],
    }),
    workstreamFromArgs({
      ...VALID,
      id: "b",
      scope: "document the change",
      paths: ["docs/y.md"],
      outOfScope: [
        "Every file under agents/ and tests/ — this workstream documents, it does not implement",
        "tests/",
        "src/other.ts",
      ],
    }),
  ];
}

// ────────────────────────────── 1. the field case: a prose fence over the
// merged workstream's own subtree is dropped, and the drop is recorded.
{
  const [a, b] = fieldHalves();
  const merged = foldMerged(a, b);
  assert(
    !merged.outOfScope.some((e) => e.startsWith("Every file under agents/")),
    `a merged workstream does not keep a prose fence over its own subtree (got ${JSON.stringify(merged.outOfScope)})`,
  );
  assert(
    merged.outOfScope.includes("src/other.ts"),
    "the fence naming nothing this workstream declared survives — the drop is not a wipe",
  );
  const notes = foldSelfFenceNotes(a, b);
  assert(
    notes.some(
      (n) =>
        n.startsWith("self-fence dropped: ") &&
        n.includes("Every file under agents/") &&
        n.includes("(merged workstream)"),
    ),
    `the removal is recorded as a note naming the entry and the merged workstream (got ${JSON.stringify(notes)})`,
  );
  assert(
    notes.every((n) => !n.startsWith("unfenced ") && !n.startsWith("kept fence ") && !n.startsWith("unresolved identifier ")),
    "no note begins with a prefix unfenceSummary counts, so the fold's drops cannot be billed to the issue-named pass",
  );
}

// ────────────────────────────── 2. the path-shaped spellings of the same fence:
// `tests/`, `tests/**`, `tests/*` and an annotated path all fence a declared
// `tests/test_x.py`, and each is dropped.
for (const fence of ["tests/", "tests/**", "tests/*", "tests", "tests/test_x.py (new)"]) {
  const [a] = fieldHalves();
  const merged = foldMerged(
    a,
    workstreamFromArgs({ ...VALID, id: "b", scope: "docs", paths: ["docs/y.md"], outOfScope: [fence] }),
  );
  assert(
    !merged.outOfScope.includes(fence),
    `the fence ${JSON.stringify(fence)} no longer fences the merged workstream's own tests/test_x.py (got ${JSON.stringify(merged.outOfScope)})`,
  );
  const notes = foldSelfFenceNotes(
    a,
    workstreamFromArgs({ ...VALID, id: "b", scope: "docs", paths: ["docs/y.md"], outOfScope: [fence] }),
  );
  assert(
    notes.length === 1 && notes[0] !== undefined && notes[0].includes(JSON.stringify(fence)),
    `and the drop of ${JSON.stringify(fence)} is recorded exactly once (got ${JSON.stringify(notes)})`,
  );
}

// ────────────────────────────── 3. the #572 control: a SIBLING's file named by
// a fence that survives the fold keeps fencing. Nothing in the merged workstream
// declares it, so the entry is a true-positive collision warning, not a
// self-fence — and a fold that stripped every plan's fences would look exactly
// like this fix behaving.
{
  const merged = foldMerged(
    workstreamFromArgs({ ...VALID, id: "a", paths: ["src/a.ts"], outOfScope: ["src/c.ts"] }),
    workstreamFromArgs({ ...VALID, id: "b", paths: ["src/b.ts"], outOfScope: ["src/c.ts"] }),
  );
  assert(
    merged.outOfScope.includes("src/c.ts"),
    `a fence naming a third workstream's file survives the fold (got ${JSON.stringify(merged.outOfScope)})`,
  );
  assert(
    foldSelfFenceNotes(
      workstreamFromArgs({ ...VALID, id: "a", paths: ["src/a.ts"], outOfScope: ["src/c.ts"] }),
      workstreamFromArgs({ ...VALID, id: "b", paths: ["src/b.ts"], outOfScope: ["src/c.ts"] }),
    ).length === 0,
    "and nothing is recorded as dropped for it",
  );
}

// ────────────────────────────── 4. prose that names no path is kept — there is
// nothing to compare it against, and inventing a match from free text deletes a
// fence the planner meant.
{
  const merged = foldMerged(
    workstreamFromArgs({ ...VALID, id: "a", paths: ["src/a.ts"], outOfScope: [] }),
    workstreamFromArgs({
      ...VALID,
      id: "b",
      paths: ["src/b.ts"],
      outOfScope: ["the public API surface", "sibling owns all tests", "generated fixtures"],
    }),
  );
  assert(
    merged.outOfScope.length === 3,
    `a prose fence that names no path is stored whole (got ${JSON.stringify(merged.outOfScope)})`,
  );
}

// ────────────────────────────── 5. a PROTECTED path is never a reason to drop
// a fence. The judgement is the fold's own — it asks `isProtectedPath` of the
// merged workstream's DECLARED paths, so a declaration the protected-path gate
// will halt on can never be the reason a fence goes — and it uses the project's
// one predicate rather than a path list this module could drift from (which is
// why `.github/workflows/x.yml` is protected at any depth). The behaviour is
// pinned where the fold makes the decision, and the driver-visible counterpart
// — the fence entry the protected-path machinery appends — is pinned by
// test-plan-protected-fence-1676.ts.
{
  const protectedPaths = [
    ".github/workflows/ci.yml",
    ".pi/verify-cmd",
    "CODEOWNERS",
    "agents.json",
    "packages/app/.github/workflows/ci.yml",
  ];
  for (const p of protectedPaths) {
    const merged = foldMerged(
      workstreamFromArgs({ ...VALID, id: "a", paths: [p], outOfScope: [] }),
      workstreamFromArgs({ ...VALID, id: "b", paths: ["src/b.ts"], outOfScope: [p] }),
    );
    assert(
      merged.outOfScope.includes(p),
      `a fence naming the protected declaration ${JSON.stringify(p)} survives the fold (got ${JSON.stringify(merged.outOfScope)})`,
    );
    assert(
      foldSelfFenceNotes(
        workstreamFromArgs({ ...VALID, id: "a", paths: [p], outOfScope: [] }),
        workstreamFromArgs({ ...VALID, id: "b", paths: ["src/b.ts"], outOfScope: [p] }),
      ).length === 0,
      `and nothing is recorded as dropped for ${JSON.stringify(p)}`,
    );
  }
}

// ────────────────────────────── 6. the record's shape: one UnfenceRecord per
// dropped entry, carrying the workstream that lost it, the path that caused it,
// and the entry as written. A drop that bypasses the record leaves a clip
// record describing a vanished entry, so both are checked together.
{
  const [a, b] = fieldHalves();
  const result = foldTwoForTests(a, b);
  const dropped = new Set(result.selfFenceDrops.map((r) => r.entry));
  assert(
    result.workstream.outOfScope.every((e) => !dropped.has(e)),
    "every recorded drop is really gone from the merged fence",
  );
  assert(
    result.selfFenceDrops.every(
      (r) => r.workstream === "a" && r.path.length > 0 && r.note.startsWith("self-fence dropped: "),
    ),
    `each record names the surviving workstream, the path that caused the removal, and its own note (got ${JSON.stringify(result.selfFenceDrops)})`,
  );
  assert(
    !(result.workstream.outOfScopeClipped ?? []).some(
      (r) => r.kind === "clipped" && !result.workstream.outOfScope.includes(r.entry),
    ),
    "a clip record never outlives the entry it describes across a self-fence drop",
  );
}

// ────────────────────────────── 7. the fold stays a fold: the union of paths,
// the scope annotation and the dependsOn re-point are untouched by the new
// filter, and a fold that drops nothing returns the union exactly as before.
{
  const merged = foldMerged(
    workstreamFromArgs({ ...VALID, id: "a", paths: ["src/a.ts"], outOfScope: ["src/x.ts"] }),
    workstreamFromArgs({ ...VALID, id: "b", paths: ["src/b.ts"], outOfScope: ["src/y.ts"] }),
  );
  assert(
    merged.scope === "the fix (+merged: b)" &&
      merged.paths.join(",") === "src/a.ts,src/b.ts" &&
      merged.outOfScope.join(",") === "src/x.ts,src/y.ts",
    `a fold with no self-fence is the plain union (got ${JSON.stringify(merged)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

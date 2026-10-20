#!/usr/bin/env bun
/**
 * #1707 round 4 — one fence grammar: `dir/**` and `dir/*` ARE the directory,
 * everywhere a fence is matched.
 *
 * The previous round moved the "a trailing `/**` means this directory" strip
 * OUT of `normaliseDeclaredPath` (correct: the plan-to-spec gate must see a
 * written wildcard, or it demands a path no plan may declare) and put it into
 * ONE caller's private regex — `fenceCoveringBroader`. That left the two other
 * places that match a fence reading the entry with the wildcard still on it,
 * where it matches nothing:
 *
 *   - `work-driver-plan-repair.ts` `fenced()` — a spec path sitting under the
 *     workstream's own `extension/src/**` fence read as UNFENCED, and the repair
 *     appended it to `ws.paths`. The fail-open direction: the fence is the
 *     plan's own word that the driver must not write into the plan, and it was
 *     written anyway.
 *   - `work-driver-plan-paths.ts` `findFenceContradictions` — a workstream
 *     declaring `extension/src/foo.ts` behind its own `extension/src/**` fence
 *     (the #1167 self-contradiction) read as no contradiction, so the plan-
 *     quality pass never asked the planner to fix it.
 *   - `work-driver-scope-fanout.ts` — the develop gate's fence side had the same
 *     blind reading, so the backstop that catches what the plan-time checks
 *     missed caught nothing for a glob-spelled fence.
 *
 * All three now go through `fenceDirPrefix` (the shared rule, beside
 * `normaliseDeclaredPath`), and `fenceCoveringBroader` — the one caller that
 * already got it right — calls the same helper instead of its own regex.
 *
 * `dir/*` is read as the directory too, not as a one-level glob: over-fencing
 * is the fail-CLOSED direction for a fence, and the loose single-star spelling
 * means the same thing in a planner's prose as the double-star one.
 *
 * Offline: pure functions over (workstreams, spec, changed-set). No dispatch,
 * no git, no fs.
 */

import { findFenceContradictions } from "../src/work-driver-plan-paths.ts";
import { repairOmittedDeliverablePaths } from "../src/work-driver-plan-repair.ts";
import { fenceCoveringBroader } from "../src/work-driver-plan-unfence-notes.ts";
import { fenceDirPrefix } from "../src/work-driver-declared-path.ts";
import { runScopeFanoutGate } from "../src/work-driver-scope-fanout.ts";
import type { NormalisedSpec } from "../src/work-driver-intent.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// --------------------------------------------- the shared helper, in isolation

{
  const cases: Array<[string, string]> = [
    // The two directory spellings and the bare directory are ONE fence.
    ["extension/src/**", "extension/src"],
    ["extension/src/*", "extension/src"],
    ["extension/src/", "extension/src"],
    ["./extension/src/**", "extension/src"],
    ["**extension/src/**", "extension/src"],
    ["`extension/src/**`", "extension/src"],
    // A planner annotation comes off before the directory question is asked.
    ["extension/src/** (new)", "extension/src"],
    // A concrete fence entry is untouched by the strip.
    ["extension/src/foo.ts", "extension/src/foo.ts"],
    // A wildcard that names no directory is LEFT ALONE: turning `*` into ""
    // would silently widen a dead fence to the whole tree.
    ["*", "*"],
    ["**", "**"],
    ["src/review-ledger-*", "src/review-ledger-*"],
  ];
  for (const [raw, want] of cases) {
    assert(
      fenceDirPrefix(raw) === want,
      `fenceDirPrefix(${JSON.stringify(raw)}) -> ${JSON.stringify(want)}`,
    );
  }
}

// The witness + missing-path spec shape the repair needs: one deliverable the
// plan already covers (the evidence the plan targets THIS spec) and one whose
// path sits under the fence.
function specWith(witness: string, missing: string): NormalisedSpec {
  return {
    intent: "fence direction",
    deliverables: [
      { id: "w", description: "witness", paths: [witness] },
      { id: "d", description: "fenced", paths: [missing] },
    ],
    acceptanceCriteria: [],
    outOfScope: [],
    assumptions: [],
    openQuestions: [],
    evidence: [],
    verdict: "proceed",
    rationale: "",
  };
}

function WS(id: string, paths: string[], outOfScope: string[] = []): Workstream {
  return { id, scope: id, paths, outOfScope };
}

/** `dir/**` and `dir/*` are the fence spellings; `dir/` is the control that already worked. */
const DIR_FENCES = ["extension/src/**", "extension/src/*", "extension/src/"];
const FENCED_FILE = "extension/src/foo.ts";

// ------------------------------------- 1. the repair refuses a fenced-out path

for (const fence of DIR_FENCES) {
  const ws = { "task-1": WS("task-1", ["src/a.ts"], [fence]) };
  const spec = specWith("src/a.ts", FENCED_FILE);
  const seen: string[] = [];
  const repaired = repairOmittedDeliverablePaths(ws, spec, [], (r) => seen.push(r));
  assert(
    repaired === undefined &&
      seen.some((r) => r.includes(`${FENCED_FILE}: fenced in the workstream's outOfScope`)),
    `repair: fence ${JSON.stringify(fence)} blocks appending ${FENCED_FILE} — the fence is the plan's own word (refused: ${JSON.stringify(seen)})`,
  );
}

{
  // The control: with no fence the same repair DOES append it, so the refusal
  // above is the fence's doing and not an unrelated decline.
  const ws = { "task-1": WS("task-1", ["src/a.ts"], []) };
  const repaired = repairOmittedDeliverablePaths(ws, specWith("src/a.ts", FENCED_FILE), []);
  assert(
    repaired?.added.join(",") === FENCED_FILE,
    `repair control: with nothing fencing it, ${FENCED_FILE} IS the omitted path the repair adds (got ${JSON.stringify(repaired?.added)})`,
  );
}

{
  // The `/` boundary is what keeps the directory reading honest: a sibling that
  // merely shares the prefix is not inside the fence.
  const ws = { "task-1": WS("task-1", ["src/a.ts"], ["extension/src/**"]) };
  const repaired = repairOmittedDeliverablePaths(ws, specWith("src/a.ts", "extension/srcfoo.ts"), []);
  assert(
    repaired?.added.join(",") === "extension/srcfoo.ts",
    `the fence ${JSON.stringify("extension/src/**")} does not reach the sibling extension/srcfoo.ts (got ${JSON.stringify(repaired?.added)})`,
  );
}

// --------------------------- 2. findFenceContradictions sees the glob fence

for (const fence of DIR_FENCES) {
  const found = findFenceContradictions({
    "task-a": { paths: [FENCED_FILE], outOfScope: [fence] },
    "task-b": { paths: ["other/b.ts"], outOfScope: [] },
  });
  const row = found.find((c) => c.workstream === "task-a");
  assert(
    row !== undefined && row.path === FENCED_FILE && row.entry === fence,
    `findFenceContradictions: a workstream declaring ${FENCED_FILE} behind its own ${JSON.stringify(fence)} fence IS the #1167 self-contradiction (got ${JSON.stringify(found)})`,
  );
}

{
  // A SIBLING's directory fence is not a contradiction — that is the #572
  // cross-declaration contract, and the widened reading must not start
  // flagging it.
  const found = findFenceContradictions({
    "task-a": { paths: [FENCED_FILE], outOfScope: [] },
    "task-b": { paths: ["other/b.ts"], outOfScope: ["extension/src/**"] },
  });
  assert(
    found.length === 0,
    `a sibling's directory fence is the #572 contract, not a contradiction (got ${JSON.stringify(found)})`,
  );
}

// --------------------------------- 3. the develop scope gate's fence backstop

const FENCE_FAIL = (file: string) =>
  new RegExp(`touched out-of-scope path ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — declared fence violated`);

function runGate(ws: Record<string, Workstream>, changed: string[]) {
  const failures: string[] = [];
  const notes: string[] = [];
  runScopeFanoutGate(
    ws,
    new Map([["task-a", new Set(changed)] as [string, Set<string>]]),
    failures,
    notes,
  );
  return { failures, notes };
}

for (const fence of DIR_FENCES) {
  const { failures } = runGate(
    { "task-a": WS("task-a", ["other/a.ts"], [fence]) },
    [FENCED_FILE],
  );
  assert(
    failures.some((f) => FENCE_FAIL(FENCED_FILE).test(f)),
    `scope gate: an edit to ${FENCED_FILE} under the fence ${JSON.stringify(fence)} BLOCKS (got: ${failures.join("; ")})`,
  );
}

{
  const { failures } = runGate({ "task-a": WS("task-a", ["other/a.ts"], []) }, [FENCED_FILE]);
  assert(
    !failures.some((f) => FENCE_FAIL(FENCED_FILE).test(f)),
    `scope-gate control: with nothing fenced, ${FENCED_FILE} is undeclared prose, not a fence violation (got: ${failures.join("; ")})`,
  );
}

{
  // The self-fence demotion (#784) keeps its shape under the glob spelling:
  // the workstream declared the file itself, so the hit is a note, not a park.
  const { failures, notes } = runGate(
    { "task-a": WS("task-a", [FENCED_FILE], ["extension/src/**"]) },
    [FENCED_FILE],
  );
  assert(
    !failures.some((f) => FENCE_FAIL(FENCED_FILE).test(f)) &&
      notes.some((n) => /fence hit demoted to warning/.test(n)),
    `scope gate: a self-declared file under its own directory fence is still demoted to a note (failures: ${failures.join("; ")}; notes: ${notes.join("; ")})`,
  );
}

// -------------------------- 4. fenceCoveringBroader keeps using the ONE rule

for (const fence of ["extension/src/**", "extension/src/*", "extension/src/"]) {
  assert(
    fenceCoveringBroader([fence, "other/"], FENCED_FILE) === fence,
    `fenceCoveringBroader recognises ${JSON.stringify(fence)} as the directory covering ${FENCED_FILE}`,
  );
}

process.exit(exit);

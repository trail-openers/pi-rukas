#!/usr/bin/env bun
/**
 * #1744 — what the `outOfScope` bound LEAVES BEHIND: a record, on the workstream,
 * that says in the driver's own words what it clipped and what it dropped.
 *
 * The bound itself (clip, split, cap, the widening disclosure) is judged in
 * test-plan-outofscope-bound-1744.ts. This file judges the half that keeps the
 * bound from being a silent truncation:
 *
 *   1. the FOLD carries the clip records by ENTRY TEXT — no index to re-key —
 *      drops the records whose entry it removed, re-applies the entry-count cap
 *      to the union, and emits the SAME trace line the tool boundary emits;
 *   2. the THIRD writer of a fence list (the deferred protected append) goes
 *      through the same cap, so a full list cannot be pushed past it, and what it
 *      could not add is recorded rather than lost;
 *   3. the record is what makes the bound VISIBLE where a person reads it: the
 *      ` …[clipped]` marker and the `(+N … dropped)` disclosure render from the
 *      record alone, so a fence the driver truncated never reads exactly like a
 *      fence the planner finished writing — in the first develop prompt and in
 *      the corrective one, which read the same `FenceView` fields.
 */

import {
  boundOutOfScope,
  keepClippedRecords,
  neutraliseFenceEntry,
  quotedOutOfScope,
} from "../src/plan-fence-bound.ts";
import { FENCE_CLIP_MARKER, WORKSTREAM_LIST_MAX } from "../src/plan-workstream-schema.ts";
import { correctiveDevelopPrompt } from "../src/work-driver-corrective-prompt.ts";
import { withDeferredProtectedFence } from "../src/work-driver-plan-fence.ts";
import { workstreamFromArgs } from "../src/work-driver-plan-workstreams.ts";
import { inlineDevelopPrompt } from "../src/work-driver-prompts-early.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { foldTwo } from "../src/workstream-fold.ts";
import {
  LONG_PATH_FENCE,
  LONG_PROSE,
  VALID,
  clippedLongPath,
  fenceList,
} from "./lib/plan-outofscope-fixtures.ts";
import { captureTracesSync } from "./lib/spec-slot-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── 6 — the fold carries the records by text, re-caps, and warns ─────────────
{
  const a = workstreamFromArgs({
    ...VALID,
    id: "a",
    paths: ["src/a.ts"],
    outOfScope: [LONG_PROSE, "docs/a.md"],
  });
  const b = workstreamFromArgs({
    ...VALID,
    id: "b",
    paths: ["src/b.ts"],
    outOfScope: [LONG_PATH_FENCE],
  });
  const { value: folded, traces } = captureTracesSync(() => foldTwo(a, b));
  assert(
    folded.outOfScope.length === 3 && folded.outOfScope.includes("docs/a.md"),
    `the fold unions both halves' fences (got ${JSON.stringify(folded.outOfScope)})`,
  );
  const keptRecords = (folded.outOfScopeClipped ?? []).filter((r) => r.kind === "clipped");
  assert(
    keptRecords.length === 2,
    `both halves' clip records survive the fold (got ${JSON.stringify(folded.outOfScopeClipped)})`,
  );
  assert(
    keptRecords.every((r) => r.kind === "clipped" && folded.outOfScope.includes(r.entry)),
    "every carried record still names an entry that exists — the key IS the text, so there is no index to re-key",
  );

  // A record whose entry the fold removed (a self-fence of a merged path) goes
  // with the entry rather than becoming a claim about an entry that is gone.
  const selfFenced = foldTwo(
    workstreamFromArgs({ ...VALID, id: "x", paths: ["src/x.ts"], outOfScope: [LONG_PATH_FENCE] }),
    workstreamFromArgs({ ...VALID, id: "y", paths: [clippedLongPath()], outOfScope: [] }),
  );
  assert(
    !(selfFenced.outOfScopeClipped ?? []).some(
      (r) => r.kind === "clipped" && !selfFenced.outOfScope.includes(r.entry),
    ),
    "a clip record never outlives its entry across a fold",
  );

  // Twice the cap unions to the cap, the excess is recorded as ONE record, and
  // the re-cap says so on the SAME trace line the tool boundary uses.
  const wide = (id: string, offset: number): Workstream =>
    workstreamFromArgs({
      ...VALID,
      id,
      paths: [`src/${id}.ts`],
      outOfScope: Array.from(
        { length: WORKSTREAM_LIST_MAX },
        (_, i) => `src/${id}-${offset + i}.ts`,
      ),
    });
  const { value: big, traces: bigTraces } = captureTracesSync(() =>
    foldTwo(wide("a", 0), wide("b", 1000)),
  );
  assert(
    big.outOfScope.length === WORKSTREAM_LIST_MAX,
    `a fold of two full lists is re-capped at ${WORKSTREAM_LIST_MAX}, not twice it`,
  );
  const bigDrops = (big.outOfScopeClipped ?? []).filter((r) => r.kind === "dropped");
  assert(
    bigDrops.length === 1 &&
      bigDrops[0]?.kind === "dropped" &&
      bigDrops[0].reason === "cap" &&
      bigDrops[0].count === WORKSTREAM_LIST_MAX,
    `and every entry the fold dropped is ONE aggregated cap record (got ${JSON.stringify(bigDrops)})`,
  );
  assert(
    bigTraces.filter((t) => t.includes("outOfScope bounded")).length === 1 &&
      bigTraces.some(
        (t) => t.includes("outOfScope bounded") && t.includes("plan fold 'a' + 'b'"),
      ) === true,
    "the fold's re-cap emits the same traceWarn as workstreamFromArgs, naming the fold",
  );
}

// ── 6b — the third writer: the deferred protected append is bounded too ──────
{
  const atCap = fenceList(WORKSTREAM_LIST_MAX);
  const { value: fenced, traces } = captureTracesSync(() =>
    withDeferredProtectedFence(
      { default: { id: "default", scope: "s", paths: ["src/a.ts"], outOfScope: atCap } },
      [".pi/verify-cmd", ".github/workflows/ci.yml"],
    ),
  );
  const ws = fenced.default;
  assert(
    ws?.outOfScope.length === WORKSTREAM_LIST_MAX,
    `the deferred append cannot push a full fence list past ${WORKSTREAM_LIST_MAX} (got ${ws?.outOfScope.length})`,
  );
  assert(
    (ws?.outOfScopeClipped ?? []).some(
      (r) => r.kind === "dropped" && r.reason === "cap" && r.count === 2,
    ),
    `and what it could not add is RECORDED, not lost (got ${JSON.stringify(ws?.outOfScopeClipped)})`,
  );
  assert(
    traces.some((t) => t.includes("deferred protected fence")),
    "the third writer says out loud when the cap swallowed its paths",
  );
  const untouched = withDeferredProtectedFence(
    { default: { id: "default", scope: "s", paths: ["src/a.ts"], outOfScope: ["docs/**"] } },
    [".pi/verify-cmd"],
  );
  assert(
    untouched.default?.outOfScopeClipped === undefined &&
      untouched.default?.outOfScope.join() === "docs/**,.pi/verify-cmd",
    "a list under the ceiling still just appends, with no record and no warning",
  );
}

// ── 7 — the bound is visible where a person reads it ─────────────────────────
{
  const bounded = boundOutOfScope([LONG_PROSE, "src/gone.ts"]);
  const kept = bounded.entries[0] ?? "";
  const shown = quotedOutOfScope(bounded.entries, bounded.clipped);
  assert(
    shown.includes(`${JSON.stringify(neutraliseFenceEntry(kept))}${FENCE_CLIP_MARKER}`),
    "a clipped fence says so in the prompt, outside the quotes, keyed by the entry text",
  );
  assert(
    !quotedOutOfScope(bounded.entries, []).includes("clipped"),
    "with an empty record the fence renders exactly as it did before #1744",
  );
  assert(
    quotedOutOfScope(["the docs folder"], []).includes('"the docs folder"'),
    "an uncut entry is untouched by the marker path",
  );
  const many = fenceList(WORKSTREAM_LIST_MAX + 7);
  const capped = boundOutOfScope(many);
  assert(
    quotedOutOfScope(capped.entries, capped.clipped).includes(
      "(+7 further exclusions dropped at the 50-entry cap)",
    ),
    "entries the cap swallowed are disclosed where the fence itself is read",
  );
  assert(
    !quotedOutOfScope(capped.entries, []).includes("dropped at the"),
    "the disclosure comes from the record — a caller passing [] claims nothing",
  );

  // The unfence pass keeps records by text: a removed entry takes its own
  // record with it and shifts nothing.
  const entries = bounded.entries;
  const records = bounded.clipped;
  assert(
    JSON.stringify(keepClippedRecords(entries.slice(0, 1), records)) === JSON.stringify(records),
    "removing an UNRELATED entry changes nothing at all — no re-keying, no churn",
  );
  assert(
    keepClippedRecords(entries.slice(1), records).length === 0,
    "removing the entry a record describes takes the record with it",
  );

  // The prompts carry the record through the FenceView field.
  const devPrompt = inlineDevelopPrompt([1744], "/tmp/scratch", {
    id: "task-a",
    scope: "the fix",
    paths: ["src/a.ts"],
    outOfScope: bounded.entries,
    outOfScopeClipped: bounded.clipped,
  });
  assert(
    devPrompt.includes(`${JSON.stringify(neutraliseFenceEntry(kept))}${FENCE_CLIP_MARKER}`),
    "the first develop prompt renders the clipped marker from the workstream record",
  );
  const corrective = correctiveDevelopPrompt({
    issues: [1744],
    scratchDirAbs: "/tmp/scratch",
    workstreamId: "task-a",
    parallel: false,
    scope: "the fix",
    paths: ["src/a.ts"],
    command: "bun run test",
    lines: ["not ok 1 - a"],
    outOfScope: capped.entries,
    outOfScopeClipped: capped.clipped,
  });
  assert(
    corrective.includes("(+7 further exclusions dropped at the 50-entry cap)"),
    "the corrective prompt discloses the cap drops too — both prompts read the same FenceView",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

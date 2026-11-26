#!/usr/bin/env bun
/**
 * The OFF arm: `PI_ENSEMBLE_LEAN_REQUEST_STALL=0` puts the tree back the way it was.
 *
 * A switch is only as honest as its off arm. With the lever off, a build child that stays
 * quiet past every bound must still finish its work and return the outcome the step produced
 * BEFORE the lever existed — `ok`, its patch committed, and a record carrying no `stall` key:
 * not a `stall` verdict, not a silent `budget` verdict under another limit, and not a record
 * widened by a key the off arm never armed.
 *
 * **What byte-identity is asserted against.** An unset lever with `PI_ENSEMBLE_DISPATCH_CAPS=0`
 * is the pre-change tree by construction: no ceiling armed, no lever armed, so what that arm
 * returns is what a build returned before this switch existed — `budgetVerdictWithRows` is
 * reached only by a child a ceiling stopped, which caps-off cannot produce. Cell (b) compares
 * the two arms over the **whole outcome, key order included** (`JSON.stringify`, so a field
 * inserted mid-record is a difference, not a reordering), over the **step record's whole key
 * set** and over the **dispatch cost rows**. `kind`/`reason` alone would let a lever that armed
 * but never fired pass, or one that widened the record pass: a comparison that cannot see
 * `limit`/`value`/`used` or `dispatches` is not byte-identity, and an off arm that adds a key is
 * a host reading a field the pre-change build never wrote. It is a comparison of two runs of
 * THIS tree, so it pins that the switch takes the change out; the pre-change bytes themselves,
 * captured from a tree that never had the file, are the goldens' job
 * (`test-lean-pre-verify-share-off-arm.ts` is the model), not this one's.
 *
 * `0` is the only off value: a mangled `" 0 "`, `"false"` or `""` keeps the shipped behaviour,
 * and (c) pins that a quiet child under each of those still stops — off means off, not noise.
 */

import { defaultConfig } from "../src/lean/config.ts";
import { MINUTE_MS } from "../src/lean/deadline.ts";
import { REVIEW_DEADLINE_RESERVE_MS } from "../src/lean/review-bound.ts";
import { assertRunFile, INITIAL_COUNTERS } from "../src/lean/state.ts";
import type { Outcome } from "../src/lean/state.ts";
import { budgetTrio } from "../src/lean/step-budget.ts";
import { requestStallWindowMs } from "../src/request-stall-policy.ts";
import { withEnv } from "./lib/env-scope.ts";
import { put } from "./lib/lean-build-artifacts.ts";
import { configWithRunner } from "./lib/lean-build-asserts.ts";
import { runBuild } from "./lib/lean-build-fixture.ts";
import {
  HUNG_REQUEST_MS,
  PANEL_CELL_S,
  PANEL_START_MS,
  cellAt,
  offEnv,
  stallEnv,
} from "./lib/lean-request-stall-fixture.ts";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    failed = 1;
  }
}

type Run = Awaited<ReturnType<typeof runBuild>>;

function stallOnlyConfig() {
  return {
    ...configWithRunner(),
    budgets: { ...defaultConfig().budgets, build: { turns: 0, tokens: 0, minutes: 0 } },
  };
}

/** The child of the ON arm's cell (a): it writes its implementation and then goes quiet. */
function hungCase(issue: number) {
  return {
    issue,
    config: stallOnlyConfig(),
    clock: {
      deadlineMs: PANEL_START_MS + PANEL_CELL_S * MINUTE_MS,
      now: () => cellAt(PANEL_CELL_S - 60),
    },
    child: (wt: string) => put(wt, "src/stall.ts", "export const stall = () => 1;\n"),
    silentMs: HUNG_REQUEST_MS,
  } as const;
}

/** The WHOLE step record, key order included — `JSON.stringify`, not a hand-picked projection.
 *  `undefined` is distinguishable from `{}` for the same reason the harness keeps absent and
 *  zero apart: an absent record is not a record of nothing. */
function record(r: Run | undefined): string {
  return JSON.stringify(r?.outcome ?? null);
}

/** The record's own key set, in the order the step wrote it. The load-bearing half of the
 *  comparison: it is what notices a key the pre-change build never wrote. */
function keySet(r: Run | undefined): string {
  return JSON.stringify(Object.keys(r?.outcome ?? {}));
}

/** The cost rows the step recorded — the other surface the lever can widen without changing a
 *  verdict: an armed-but-never-fired lever that counted its own abort would show here. */
function rows(r: Run | undefined): string {
  return JSON.stringify(r?.outcome?.dispatches ?? null);
}

/**
 * The record put back through the state loader — the pre-change authority on what a build step's
 * record may hold. `assertRunFile` runs `outcomeProblem` and `buildOutcome` over every step entry,
 * and BOTH are field allowlists: a key a build step does not own is refused outright, and a key the
 * builder does not know is dropped. So a lever that armed under `0` and left any trace — an extra
 * key, or the trio beside a verdict that crossed no ceiling — cannot survive the round trip,
 * whatever this file's own two-run comparison thinks of it.
 *
 * That is the half a two-run comparison cannot supply. An `ok` record widened on BOTH arms is
 * identical to itself, and a `kind`/`reason` projection sees nothing: the only pre-change artefact
 * for this knob is the loader, which predates it and is not a mirror of the code under change.
 */
function throughLoader(r: Run | undefined): string {
  return JSON.stringify(
    assertRunFile(
      {
        schema: 1,
        issue: 2644,
        version: "off-arm",
        models: {},
        baseSha: "0000000000000000000000000000000000000000",
        branch: "lean/issue-2644",
        state: "build",
        counters: { ...INITIAL_COUNTERS },
        steps: [
          {
            key: "2644:build:0",
            state: "build",
            startedAt: PANEL_START_MS,
            outcome: r?.outcome,
          },
        ],
      },
      "off-arm",
    ).steps[0]?.outcome ?? null,
  );
}

// ── (a) off: the same child that stalled ON returns its work ─────────────────
{
  let off: Run | undefined;
  await withEnv(offEnv(), async () => {
    off = await runBuild(hungCase(2644));
  });
  assert(
    off?.threw === undefined,
    `(a) with the lever off a quiet child is still a normal dispatch: ${(off?.threw ?? { message: "clean" }).message}`,
  );
  assert(
    off?.outcome?.kind === "ok",
    `(a) the OFF arm records the outcome the step produced before the lever existed (got ${String(off?.outcome?.kind)})`,
  );
  assert(
    off?.headAfter !== off?.headBefore,
    "(a) and the quiet child's patch is committed, exactly as the ON arm's was",
  );
  assert(
    budgetTrio(off?.outcome as Outcome | undefined) === undefined,
    "(a) no budget trio reads off an off-arm outcome",
  );
  // The whole record, not a projection of it: the trio's fields and any key the lever added.
  assert(
    !/"limit"|"value"|"used"/.test(record(off)),
    `(a) no budget trio field appears anywhere in the off-arm record (${record(off)})`,
  );
  // And the record the pre-change loader accepts is the record this one wrote — nothing widened,
  // nothing dropped. This is the assertion that has an authority from before the knob existed.
  let loaded = "";
  try {
    loaded = throughLoader(off);
  } catch (err) {
    loaded = `LOADER REFUSED: ${(err as Error).message}`;
  }
  assert(
    loaded === record(off),
    `(a) the state loader round-trips the off-arm record unchanged — no key it refuses, none it drops (${loaded} vs ${record(off)})`,
  );
  // The window reader inside the same env: `0` means no number, not a zero timer.
  const offWindow = await withEnv(offEnv(), async () =>
    requestStallWindowMs(
      PANEL_START_MS + PANEL_CELL_S * MINUTE_MS,
      cellAt(PANEL_CELL_S - 60),
      REVIEW_DEADLINE_RESERVE_MS,
    ),
  );
  assert(
    offWindow === undefined,
    `(a) with the switch at 0 no window is derived at all (got ${String(offWindow)})`,
  );
}

// ── (b) the off arm is byte-identical to the pre-change inert arm ────────────
{
  // The pre-change arm: an unset switch with dispatch caps off arms no ceiling and no lever, so
  // its record is the one this step wrote before the lever existed. Same config, same deadline,
  // same silence, same child edit — the env value is the only variable between the two runs.
  let zeroed: Run | undefined;
  let inert: Run | undefined;
  await withEnv(offEnv(), async () => {
    zeroed = await runBuild(hungCase(2648));
  });
  await withEnv({ ...stallEnv(), PI_ENSEMBLE_DISPATCH_CAPS: "0" }, async () => {
    inert = await runBuild(hungCase(2649));
  });
  assert(
    record(zeroed) === record(inert),
    `(b) \`0\` and the pre-change arm write the same outcome, key order included (${record(zeroed)} vs ${record(inert)})`,
  );
  assert(
    keySet(zeroed) === keySet(inert),
    `(b) and the same KEY SET — no key the pre-change build never wrote (${keySet(zeroed)} vs ${keySet(inert)})`,
  );
  assert(
    rows(zeroed) === rows(inert),
    `(b) and the same dispatch cost rows (${rows(zeroed)} vs ${rows(inert)})`,
  );
  // Both arms through the pre-change loader: identity here is identity against an authority neither
  // arm wrote, so a key the lever leaves on a `0` run cannot hide in a two-run comparison.
  const load = (r: Run | undefined): string => {
    try {
      return throughLoader(r);
    } catch (err) {
      return `LOADER REFUSED: ${(err as Error).message}`;
    }
  };
  assert(
    load(zeroed) === load(inert),
    `(b) and the pre-change state loader reads both arms' records identically (${load(zeroed)} vs ${load(inert)})`,
  );
  // The trio read directly on both arms: `budgetTrio` returns a trio for a `budget` record whose
  // trio fields are all present, so a `0` that armed a lever which merely never fired fails here.
  assert(
    budgetTrio(zeroed?.outcome as Outcome | undefined) ===
      budgetTrio(inert?.outcome as Outcome | undefined),
    `(b) neither arm reads a budget trio (${JSON.stringify(budgetTrio(zeroed?.outcome as Outcome | undefined))} vs ${JSON.stringify(budgetTrio(inert?.outcome as Outcome | undefined))})`,
  );
}

// ── (c) noise is not an operator asking for the pre-change behaviour ──────────
// A mangled value keeps the shipped behaviour, which here means the quiet child STILL stops. The
// values are the switch suite's non-`0` rows; their reader answer is pinned there, and what this
// cell pins is that the answer means the lever is live.
for (const [i, value] of [" 0 ", "false", "00", "NO", ""].entries()) {
  let run: Run | undefined;
  await withEnv({ ...stallEnv(), PI_ENSEMBLE_LEAN_REQUEST_STALL: value }, async () => {
    run = await runBuild(hungCase(2650 + i));
  });
  assert(
    run?.outcome?.kind === "budget" && budgetTrio(run?.outcome)?.limit === "stall",
    `(c) PI_ENSEMBLE_LEAN_REQUEST_STALL=${JSON.stringify(value)} keeps the lever: the quiet child still stops at the stall (got ${String(run?.outcome?.kind)}/${String(budgetTrio(run?.outcome)?.limit)})`,
  );
}

process.exit(failed);

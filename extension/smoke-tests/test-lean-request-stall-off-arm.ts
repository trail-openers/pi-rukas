#!/usr/bin/env bun
/**
 * The OFF arm: `PI_ENSEMBLE_LEAN_REQUEST_STALL=0` puts the tree back the way it was.
 *
 * A switch is only as honest as its off arm. With the lever off, a build child that stays
 * quiet past every bound must still finish its work and return the outcome the step produced
 * BEFORE the lever existed — `ok`, its patch committed, and a step record carrying no `stall`
 * key: not a `stall` verdict, not a silent `budget` verdict under another limit, and not a
 * record widened by a key the off arm never armed. The comparison is against the shape the
 * ON arm's own cell (a) records, so the two arms differ in the env value and nothing else:
 * same config, same deadline, same silence, same child edit.
 *
 * `0` is the only off value, and the OFF arm is asserted to be byte-identical to what an
 * unset lever produces with dispatch caps on and every state ceiling off — the pre-change tree.
 */

import { budgetTrio } from "../src/lean/step-budget.ts";
import type { Outcome } from "../src/lean/state.ts";
import { requestStallWindowMs } from "../src/lean/request-stall.ts";
import { MINUTE_MS } from "../src/lean/deadline.ts";
import { withEnv } from "./lib/env-scope.ts";
import {
  HUNG_REQUEST_MS,
  PANEL_CELL_S,
  PANEL_START_MS,
  cellAt,
  offEnv,
  stallEnv,
} from "./lib/lean-request-stall-fixture.ts";
import { runBuild } from "./lib/lean-build-fixture.ts";
import { put } from "./lib/lean-build-artifacts.ts";
import { configWithRunner } from "./lib/lean-build-asserts.ts";
import { defaultConfig } from "../src/lean/config.ts";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    failed = 1;
  }
}

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
    clock: { deadlineMs: PANEL_START_MS + PANEL_CELL_S * MINUTE_MS, now: () => cellAt(PANEL_CELL_S - 60) },
    child: (wt: string) => put(wt, "src/stall.ts", "export const stall = () => 1;\n"),
    silentMs: HUNG_REQUEST_MS,
  } as const;
}

// ── (a) off: the same child that stalled ON returns its work ─────────────────
{
  let off: Awaited<ReturnType<typeof runBuild>> | undefined;
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
  // The window reader inside the same env: `0` means no number, not a zero timer.
  const offWindow = await withEnv(offEnv(), async () =>
    requestStallWindowMs(PANEL_START_MS + PANEL_CELL_S * MINUTE_MS, cellAt(PANEL_CELL_S - 60)),
  );
  assert(
    offWindow === undefined,
    `(a) with the switch at 0 no window is derived at all (got ${String(offWindow)})`,
  );
}

// ── (b) the off arm is byte-identical to an unset lever with caps off ────────
{
  // An unset switch with dispatch caps off is the pre-change tree by definition: no
  // ceiling armed, no lever armed. The off arm must match its outcome AND its record
  // shape, so `0` demonstrably means "as before" rather than "as before, plus a key".
  let zeroed: Awaited<ReturnType<typeof runBuild>> | undefined;
  let inert: Awaited<ReturnType<typeof runBuild>> | undefined;
  await withEnv(offEnv(), async () => {
    zeroed = await runBuild(hungCase(2648));
  });
  await withEnv({ ...stallEnv(), PI_ENSEMBLE_DISPATCH_CAPS: "0" }, async () => {
    inert = await runBuild(hungCase(2649));
  });
  const shape = (r: Awaited<ReturnType<typeof runBuild>> | undefined): unknown =>
    r === undefined ? "absent" : { kind: r.outcome?.kind, reason: r.outcome?.reason };
  assert(
    JSON.stringify(shape(zeroed)) === JSON.stringify(shape(inert)),
    `(b) \`0\` and the pre-change inert arm record the same outcome (got ${JSON.stringify(
      shape(zeroed),
    )} vs ${JSON.stringify(shape(inert))})`,
  );
}

process.exit(failed);

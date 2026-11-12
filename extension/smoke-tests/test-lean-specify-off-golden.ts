#!/usr/bin/env bun
/**
 * #2212 — with `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0`, a specify run is the run
 * v0.14.71 ran.
 *
 * The record it is compared against was captured ONCE from the v0.14.71 tree
 * (R3): `fixtures/lean-state/specify-off-v0.14.71.json`, written by
 * `tmp/issue-2212/capture-off-golden.ts` against a `git worktree` of the tag, and
 * produced by the SAME harness this test uses (`lib/lean-specify-off-golden.ts`),
 * so a record that agrees is a record of the step and not of two fixtures that
 * drifted apart.
 *
 * What "byte-identical" means here is R2's definition, and nothing looser: the
 * run's terminal state, its exit code, its terminal reason, and each recorded
 * step's `state`, `key` and `outcome` — kind, reason and `failedRules` included.
 * Every `startedAt`/`endedAt` is masked and the run is driven under a fixed
 * injected clock, so no wall clock can differ. The posted comment body is excluded
 * and `decline` is a spy, so neither arm contacts a forge. The base sha is masked
 * too, for the same reason R2 masks the clock: git abbreviates a sha by the
 * repository's loose-object layout, which a fixture repo built afresh does not
 * reproduce, so pinning it would pin the fixture's object store.
 *
 * The shape is R4's, not the preflight-bug recipe, for a reason the recipe itself
 * shows: a runner that fails on EVERY file is a proof that observed nothing, and
 * `assertRan` throws on that with the switch on either way — so the off arm needs
 * a child that declares a test whose run gives a non-naming exit-4 failure, which
 * is `unclear`, which the proof DROPS, which is the decline v0.14.71 reached.
 *
 *   (a) the switch-off run is the captured record, field by field;
 *   (b) it left no probe byte in the tree the step dispatched into — the record
 *       comparison alone would pass on a run that paid for the probe and happened
 *       to reach the same verdict;
 *   (c) the reset's submodule step was never reached: the run survives a sabotage
 *       planted at the seam the submodule call runs behind, which a reset that
 *       issued the call could not survive;
 *   (d) the control: the SAME repo with the switch unset ends `handed-back` at
 *       exit 10 on the preflight's own words. Without it, (a)–(c) could be about a
 *       configuration where the probe never had anything to find.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  GOLDEN_FIXTURE,
  type GoldenRun,
  driveOffArm,
} from "./lib/lean-specify-off-golden.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

/** The fixture, read once. Its absence is a failure, never a skip. */
function fixture(): { golden?: GoldenRun; problem?: string } {
  try {
    const raw = readFileSync(
      path.resolve(import.meta.dirname, GOLDEN_FIXTURE),
      "utf8",
    );
    return { golden: JSON.parse(raw) as GoldenRun };
  } catch (err) {
    return { problem: (err as Error).message };
  }
}

const { golden: captured, problem } = fixture();
assert(
  captured !== undefined,
  `(fixture) the v0.14.71 record is present at ${GOLDEN_FIXTURE} (${problem ?? "read"})`,
);

/** Every field R2 names, as one JSON text, so a mismatch prints both sides. */
const rendered = (g: GoldenRun): string => JSON.stringify(g);

// ── (a) + (b) + (c) the off arm, against the captured record
{
  const decline = { ran: 0, rules: [] as string[] };
  let ran: GoldenRun | undefined;
  let threw: Error | undefined;
  try {
    ran = await driveOffArm(2212, {
      switchOff: true,
      assertNoProbe: true,
      decline,
      // (c) The sabotage a switch-on run cannot survive: `resetWorktreeToBase`
      // calls this immediately before it asks git to populate the tree's
      // submodules, so reaching it at all means the submodule step ran. Off, the
      // step is not issued, the seam is not fired, and the run finishes.
      beforeSubmoduleInit: () => {
        throw new Error("the reset asked git to populate submodules with the switch at 0");
      },
    });
  } catch (err) {
    threw = err as Error;
  }

  assert(
    threw === undefined,
    `(c) the off run completes — no probe, and no reset asked git to populate a submodule (${
      threw?.message ?? "clean"
    })`,
  );
  if (ran !== undefined && captured !== undefined) {
    assert(
      rendered(ran) === rendered(captured),
      `(a) the switch-off run is the v0.14.71 record, field by field\n    captured: ${rendered(captured)}\n    run:     ${rendered(ran)}`,
    );
    // Named separately from the whole-record comparison, because a single diff
    // line makes "which half moved" unanswerable from the failure alone.
    assert(
      ran.state === captured.state && ran.code === captured.code,
      `(a) and the run ends ${captured.state} at exit ${String(captured.code)} (got ${ran.state} exit ${String(ran.code)})`,
    );
    const step = ran.steps.find((s) => s.state === "specify");
    const want = captured.steps.find((s) => s.state === "specify");
    assert(
      JSON.stringify(step) === JSON.stringify(want),
      `(a) and the recorded specify step agrees — kind, reason and failedRules (got ${JSON.stringify(step)})`,
    );
    assert(
      (step?.outcome as { kind?: string } | undefined)?.kind === "no-red-test",
      `(a) which is v0.14.71's DECLINE, not a hand-back (got ${String(
        (step?.outcome as { kind?: string } | undefined)?.kind,
      )})`,
    );
    assert(
      (step?.outcome as { failedRules?: string[] } | undefined)?.failedRules?.[0] ===
        "criterion AC1 has no red test",
      `(a) and the decline WORDING is the release's (got ${JSON.stringify(
        (step?.outcome as { failedRules?: string[] } | undefined)?.failedRules,
      )})`,
    );
  }
}

// ── (d) the control: the same repo with the switch unset hands back at 10
{
  const decline = { ran: 0, rules: [] as string[] };
  const on = await driveOffArm(2212, { switchOff: false, decline });
  assert(
    on.state === "handed-back" && on.code === 10,
    `(d) the same run with the switch ON hands back at exit 10 (got ${on.state} exit ${String(on.code)})`,
  );
  assert(
    on.reason.includes("the test runner could not run a test file"),
    `(d) and it is the PREFLIGHT that ended it, not the red proof (got ${on.reason})`,
  );
  assert(
    JSON.stringify(on) !== JSON.stringify(captured ?? {}),
    "(d) so the off record above is a property of the switch, not of this fixture",
  );
}

process.exit(exit);

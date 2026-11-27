#!/usr/bin/env bun
/**
 * #2660 — `PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND=0` is the pre-change arm.
 *
 * The child bound a lean step hands its spawn now reads the run's deadline, and an
 * operator who sets the switch to `0` must get the arm the release shipped — not a
 * near-miss of it. So the off arm is compared against bytes captured once from a `git
 * archive` of the base commit (`fixtures/lean-step-deadline-bound-off-arm.json`,
 * `GOLDEN_BASE_COMMIT`), never against anything re-derived from the modules under change:
 * a comparison whose expected value came from `lean-step-bound.ts` could only ever prove
 * the module equals itself.
 *
 * Two things make the comparison honest:
 *
 *   (b) **the ON arm differs where the deadline bites** — the rows with a deadline and a
 *       row larger than what the deadline leaves must NOT match the golden, or the lever
 *       would be decoration and the field's overrunners would still overrun;
 *   (c) **only `0` is off** — `""`, `"false"`, `"0 "`, `"00"`, `"0x"` and an unset
 *       variable all keep the derived arm, because a switch a shell accident could flip is
 *       a lost cell waiting to happen.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/lean/config.ts";
import { armBudget } from "../src/lean/step-budget.ts";
import { stepChildBound, stepDispatchArms } from "../src/lean-step-bound.ts";
import { childBoundGraceMs } from "../src/spawn-child-bound.ts";
import { childBoundScheduleFor } from "../src/spawn-budget-arms.ts";
import { withEnv } from "./lib/env-scope.ts";
import {
  GOLDEN_ALLOWANCE_MS,
  GOLDEN_BASE_COMMIT,
  GOLDEN_DEADLINE_MS,
  GOLDEN_GRACE_MS,
  GOLDEN_ROWS,
  GOLDEN_START_MS,
  type OffArmGolden,
  type OffArmGoldenFile,
  goldenRowKey,
} from "./lib/lean-step-deadline-bound-off-arm.ts";

let exitCode = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exitCode = 1;
  }
};

const GOLDEN_FILE = path.join(
  import.meta.dirname,
  "fixtures",
  "lean-step-deadline-bound-off-arm.json",
);
const fixture = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as OffArmGoldenFile;

assert(
  fixture.baseCommit === GOLDEN_BASE_COMMIT,
  `the golden names the base commit it was captured from (${fixture.baseCommit})`,
);
assert(
  fixture.startMs === GOLDEN_START_MS && fixture.deadlineMs === GOLDEN_DEADLINE_MS,
  "the golden was captured at the panel row's instant (978 s before a 4200 s deadline)",
);
assert(
  Object.keys(fixture.rows).length === GOLDEN_ROWS.length,
  `the golden covers every row of the table (${String(Object.keys(fixture.rows).length)} of ${String(GOLDEN_ROWS.length)})`,
);

/** The arms one row produces through the production `armBudget`, with the spawn's own schedule. */
function arm(row: { deadline: boolean; minutes: number }): {
  opts: Record<string, unknown>;
  schedule: Record<string, unknown>;
} {
  const entries = [{ key: "2660:build:0", state: "build", startedAt: GOLDEN_START_MS }];
  const ctx = {
    repoRoot: "/nowhere",
    issue: 2660,
    run: {
      schema: 1,
      issue: 2660,
      version: "t",
      models: {},
      baseSha: "0".repeat(40),
      branch: "lean/issue-2660",
      state: "build",
      counters: {
        buildAttempts: 0,
        specifyAttempts: 0,
        verifyAttempts: 0,
        reviewRounds: 0,
        ciAttempts: 0,
      },
      steps: entries,
      ...(row.deadline ? { deadlineMs: GOLDEN_DEADLINE_MS } : {}),
    },
    steps: entries,
    stepKey: "2660:build:0",
    now: () => GOLDEN_START_MS,
  } as never;
  const armed = armBudget(
    { ...defaultConfig().budgets.build, minutes: row.minutes },
    stepDispatchArms(ctx, row.minutes * 60_000, "build").stall,
    // The real arm site: the bound is asked for on every row and `leanStepBound` decides,
    // from the switch, whether the deadline shortens it. Passing `undefined` here would
    // compare the arm against the golden while bypassing the very lever this suite pins.
    stepChildBound(ctx, row.minutes * 60_000, "build"),
  );
  const s = childBoundScheduleFor(armed.opts, GOLDEN_START_MS);
  return {
    opts: {
      ...(armed.opts.childBoundMs === undefined ? {} : { childBoundMs: armed.opts.childBoundMs }),
      ...(armed.opts.childBoundGraceMs === undefined
        ? {}
        : { childBoundGraceMs: armed.opts.childBoundGraceMs }),
      ...(armed.opts.budgetTurns === undefined ? {} : { budgetTurns: armed.opts.budgetTurns }),
      ...(armed.opts.stall === undefined
        ? {}
        : {
            stall: {
              windowMinutes: armed.opts.stall.windowMinutes,
              windowMs: armed.opts.stall.windowMs,
            },
          }),
    },
    schedule: {
      wrapAtMs: s.wrapAtMs,
      ...(s.killAtMs === undefined ? {} : { killAtMs: s.killAtMs }),
      stopInMs: s.stopInMs,
    },
  };
}

const env = {
  PI_ENSEMBLE_HANDOFF_TIMEOUT_MS: String(GOLDEN_ALLOWANCE_MS),
  PI_ENSEMBLE_CHILD_BOUND_GRACE_MS: String(GOLDEN_GRACE_MS),
  PI_ENSEMBLE_DISPATCH_CAPS: "1",
};

// ── (a) at `0` the arm is the base commit's, key for key ────────────────────
{
  let bad = 0;
  const detail: string[] = [];
  await withEnv({ ...env, PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND: "0" }, async () => {
    for (const row of GOLDEN_ROWS) {
      const k = goldenRowKey(row);
      const got = arm(row);
      const want = fixture.rows[k] as OffArmGolden;
      const same =
        JSON.stringify(got.opts) === JSON.stringify(want.opts) &&
        JSON.stringify(got.schedule) === JSON.stringify(want.schedule);
      if (!same) {
        bad++;
        detail.push(`${k}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
      }
    }
  });
  assert(
    bad === 0,
    `with the switch at 0 every row matches the base-commit golden byte for byte (${String(GOLDEN_ROWS.length - bad)} of ${String(GOLDEN_ROWS.length)})${bad === 0 ? "" : `\n  ${detail.join("\n  ")}`}`,
  );
  assert(
    childBoundGraceMs() === GOLDEN_GRACE_MS,
    `the pinned grace is the shipped one the capture used (${String(childBoundGraceMs())})`,
  );
}

// ── (b) the ON arm differs from the golden where the deadline bites ─────────
{
  // The rows #2660 exists to change: a deadline on the record, and a minutes row larger
  // than what the deadline leaves (45 min and 60 min against 978 s of room). A row of 3
  // min is already inside what the deadline leaves, so the derivation stands down there
  // and the golden must still match — which is what the byte-identity above proves.
  const biting = GOLDEN_ROWS.filter((r) => r.deadline && r.minutes >= 45);
  let differed = 0;
  await withEnv({ ...env, PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND: "1" }, async () => {
    for (const row of biting) {
      const got = arm(row);
      const want = fixture.rows[goldenRowKey(row)] as OffArmGolden;
      if (JSON.stringify(got.opts) !== JSON.stringify(want.opts)) differed++;
    }
  });
  assert(
    differed === biting.length,
    `the ON arm differs from the golden on every row the deadline bites (${String(differed)} of ${String(biting.length)}) — a lever that changed none of them is decoration`,
  );
  // The rows the deadline leaves alone must still be the golden's, or the switch would be
  // a rewrite of the arm rather than a clamp of it.
  let quiet = 0;
  await withEnv({ ...env, PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND: "1" }, async () => {
    for (const row of GOLDEN_ROWS.filter((r) => !r.deadline || r.minutes < 45)) {
      const got = arm(row);
      const want = fixture.rows[goldenRowKey(row)] as OffArmGolden;
      if (JSON.stringify(got.opts) !== JSON.stringify(want.opts)) quiet++;
    }
  });
  assert(
    quiet === 0,
    `and the ON arm leaves the rows the deadline does not bite at the golden's bytes (${String(quiet)} changed)`,
  );
}

// ── (c) only the literal `0` is off ────────────────────────────────────────
{
  const offValue = (v: string | undefined): boolean => {
    const row = GOLDEN_ROWS.find(
      (r) => r.deadline && r.minutes === 45,
    ) as (typeof GOLDEN_ROWS)[number];
    const want = fixture.rows[goldenRowKey(row)] as OffArmGolden;
    let same = false;
    withEnvSync({ ...env, PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND: v }, () => {
      same = JSON.stringify(arm(row).opts) === JSON.stringify(want.opts);
    });
    return same;
  };
  for (const [v, expectOff] of [
    ["0", true],
    ["00", false],
    ["0 ", false],
    ["0x", false],
    ["false", false],
    ["", false],
    ["1", false],
    [undefined, false],
  ] as const) {
    assert(
      offValue(v) === expectOff,
      `PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND=${JSON.stringify(v)} ${expectOff ? "is the pre-change arm" : "keeps the derived arm"}`,
    );
  }
}

/** A synchronous `withEnv`: the switch is read per call, and this suite arms nothing async. */
function withEnvSync(overrides: Record<string, string | undefined>, body: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

process.exit(exitCode);

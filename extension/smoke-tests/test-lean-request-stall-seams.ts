#!/usr/bin/env bun
/**
 * lean: the #2644 lever reaches the CHILDREN whose spawn options are built elsewhere (#2644).
 *
 * Split from `test-lean-request-stall.ts` at its size cap (AGENTS §12) along the concern seam: that
 * file pins what the LEVER does to a child the step dispatches itself; this one pins what reaches a
 * child some other file's spawn options are built for. The two fail for different reasons and are
 * read by different reviewers.
 *
 * The review step arms ONE budget and hands it to seams that build their own spawn options by hand:
 * the six lens children (`runLensChild`), the adversarial reviewer (`makeRunPhase`) and the fixer
 * (`runFixer`). A spread of `budget.opts` delivers the lever to neither of the first two — those
 * files construct a literal, they do not spread — so the window travels as data and each child puts
 * `stall` on its own spawn. Asserted on what the SPAWN RECEIVED: an assertion on the arm's `opts`
 * would pass with the threading deleted, which is how it shipped for a round.
 */

import { MINUTE_MS } from "../src/lean/deadline.ts";
import { REVIEW_DEADLINE_RESERVE_MS } from "../src/lean/review-bound.ts";
import { withEnv } from "./lib/env-scope.ts";
import {
  PANEL_CELL_S,
  PANEL_START_MS,
  PINNED_ALLOWANCE_MS,
  cellAt,
  reserveMs,
  stallEnv,
} from "./lib/lean-request-stall-fixture.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installLensSkills, stubLensSpawn } from "./lib/lens-stub-spawn.ts";

let failed = 0;
/** The panel cell three-quarters through: the instant a real step would arm its lever from, so the
 *  (b3) cell derives a genuine sub-minute remainder rather than a fixture-chosen one. */
const PANEL_NOW = cellAt(PANEL_CELL_S - 60);
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    failed = 1;
  }
}

// ── (b2) the step's lever reaches the children whose spawn options are built elsewhere ──
// The review step arms ONE budget and hands it to seams that build their own spawn options by
// hand: the six lens children (`runLensChild`), the adversarial reviewer (`makeRunPhase`) and the
// fixer (`runFixer`). A spread of `budget.opts` delivers the lever to neither of the first two —
// those files construct a literal, they do not spread — so the window travels as data and each
// child puts `stall` on its own spawn. Asserted on what the SPAWN RECEIVED: an assertion on the
// arm's `opts` would pass with the threading deleted, which is how it shipped for a round.
{
  const calls = stubLensSpawn();
  const { armBudget } = await import("../src/lean/step-budget.ts");
  const { reviewDeps } = await import("../src/lean/review-deps.ts");
  const { runLensChild } = await import("../src/lens-review-child.ts");
  const { makeRunPhase } = await import("../src/adversarial-phase.ts");

  const windowMinutes = Math.ceil(reserveMs() / MINUTE_MS);
  /** The lever the step arms for a cell with room to spare — a real `armBudget`, not a fixture's.
   *  A cell begun at `PANEL_START_MS` with the deadline a full cell gives it leaves the reserve
   *  outside the handoff allowance, which is exactly when the window IS the reserve. */
  const armStall = () =>
    armBudget(
      { minutes: 0, turns: 0, tokens: 0 },
      {
        reserveMs: REVIEW_DEADLINE_RESERVE_MS,
        silence: () => ({ sinceMs: 0, toolInFlight: false }),
        deadlineMs: PANEL_START_MS + PANEL_CELL_S * MINUTE_MS,
        startedAt: PANEL_START_MS,
      },
    );

  // The seam, then the child it feeds: the seam can thread a field the child drops, and a child can
  // read an arm no seam ever sent.
  let lensOpts: Record<string, unknown> | undefined;
  await withEnv(stallEnv(), async () => {
    const deps = reviewDeps(false);
    // The seam is the LAYER BELOW `lensChildFn`: `reviewDeps().lens` builds the `runLensReview`
    // options, and `runLensReview` is what spreads them into the per-lens child's opts. Stubbing
    // `lensChildFn` would capture the engine's own reshaping and could not fail when the seam
    // dropped the field, so this drives the real engine and records what IT was handed.
    deps.lensEngine = (async (o: Record<string, unknown>) => {
      lensOpts = o;
      return { verdict: "APPROVED", findings: [], advisory: [], lenses: [], usage: undefined } as never;
    }) as never;
    await deps.lens({
      base: "0123456789abcdef0123456789abcdef01234567",
      head: "0123456789abcdef0123456789abcdef01234568",
      branch: "lean/issue-2644",
      cwd: "/tmp",
      wave: "full",
      pr: undefined,
      context: "ctx",
      evidence: undefined,
      extraFindings: [],
      headless: false,
      budget: armStall(),
    });
  });
  assert(
    lensOpts?.stallWindowMinutes === windowMinutes,
    `(b2) the lens seam hands the per-lens child the step's armed window (captured ${JSON.stringify(
      lensOpts?.stallWindowMinutes,
    )}, expected ${String(windowMinutes)})`,
  );

  calls.length = 0;
  // A real skills dir: `runLensChild` blocks a lens whose SKILL.md is missing BEFORE any spawn, so
  // a non-existent dir would make this assertion green for the wrong reason (no spawn at all).
  const skills = mkdtempSync(path.join(tmpdir(), "stall-skills-"));
  installLensSkills(skills);
  await withEnv(stallEnv(), async () => {
    await runLensChild({
      lens: { name: "SECURITY", skill: "code-review-security", precedence: 10 },
      runId: "run-2644",
      skillsDir: skills,
      context: "",
      roster: [],
      opts: { diff: "", cwd: "/tmp", stallWindowMinutes: windowMinutes },
      bumpBatch: () => {},
    });
  });
  rmSync(skills, { recursive: true, force: true });
  const lensSpawn = calls.find((c) => c.role === "code-review-specialist");
  assert(
    (lensSpawn?.stall as { windowMinutes?: number } | undefined)?.windowMinutes === windowMinutes,
    `(b2) and the lens child's own spawn carried the lever — its wall clock is not the only lever it has (captured ${JSON.stringify(
      lensSpawn?.stall,
    )})`,
  );

  // The reviewer's phase: the same rule one layer down, on the spawn `makeRunPhase` builds itself.
  calls.length = 0;
  await withEnv(stallEnv(), async () => {
    const phase = makeRunPhase({
      runId: "run-2644",
      signal: new AbortController().signal,
      orchestratorJobId: "job-2644",
      processGroup: true,
      childBoundMs: 30 * 60_000,
      stallWindowMinutes: windowMinutes,
    } as never);
    await phase("adversarial-developer", "review", "prompt", "/tmp");
  });
  const reviewerSpawn = calls.find((c) => c.role === "adversarial-developer");
  assert(
    (reviewerSpawn?.stall as { windowMinutes?: number } | undefined)?.windowMinutes ===
      windowMinutes,
    `(b2) the reviewer's spawn carries the lever too — a hung request in the gate is the #2644 shape (captured ${JSON.stringify(
      reviewerSpawn?.stall,
    )})`,
  );

  // With no lever armed nothing carries one: an absent arm stays absent rather than becoming a
  // zero-minute timer that ends the child the instant it starts.
  calls.length = 0;
  await withEnv(stallEnv(), async () => {
    const phase = makeRunPhase({
      runId: "run-2644",
      signal: new AbortController().signal,
      orchestratorJobId: "job-2644",
      processGroup: true,
    } as never);
    await phase("adversarial-developer", "review", "prompt", "/tmp");
  });
  assert(
    calls.find((c) => c.role === "adversarial-developer")?.stall === undefined,
    "(b2) with no armed lever the reviewer's spawn options are those it had before this change",
  );

  // (b3) the enforced threshold is the DERIVED window, not the minutes a verdict prints. A step
  // near its deadline derives a sub-minute window; rounding it up to a whole minute and enforcing
  // THAT would let a hung request sit past the time the deadline leaves, and the verdict would
  // print a bound that never held. Same arms, two different fields, each carrying its own job.
  const SUB_MINUTE_MS = 40_000;
  const sub = armBudget(
    { minutes: 0, turns: 0, tokens: 0 },
    {
      reserveMs: REVIEW_DEADLINE_RESERVE_MS,
      silence: () => ({ sinceMs: 0, toolInFlight: false }),
      // The deadline sits SUB_MINUTE_MS past the handoff allowance from `startedAt`, so the window
      // the step derives — the one the poll enforces — is that sub-minute remainder.
      deadlineMs: PANEL_NOW + PINNED_ALLOWANCE_MS + SUB_MINUTE_MS,
      startedAt: PANEL_NOW,
    },
  ).opts.stall;
  assert(
    sub?.windowMs === SUB_MINUTE_MS,
    `(b3) the window enforced is the one the step derived (got ${String(sub?.windowMs)} ms)`,
  );
  assert(
    sub?.windowMinutes === Math.ceil(SUB_MINUTE_MS / MINUTE_MS),
    `(b3) …while the verdict still prints whole minutes, never 0 (got ${String(sub?.windowMinutes)})`,
  );
  assert(
    sub?.windowMinutes !== undefined && sub.windowMinutes * MINUTE_MS > sub.windowMs,
    "(b3) the two disagree by construction here, so a mutant enforcing the minutes is caught",
  );

}


process.exit(failed);

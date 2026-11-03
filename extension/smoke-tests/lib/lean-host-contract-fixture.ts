/**
 * lib/lean-host-contract-fixture — the shared rig for the two files that test
 * lean's side of the host contract (#1920 items 2, 3, 6):
 * `test-lean-deadline-host-channel.ts` (the engine and its reporting steps) and
 * `test-lean-failure-cause.ts` (the projection's `failure.cause`).
 *
 * Both need the same three things and must not each keep a private copy: a clock
 * that crosses a deadline mid-drive, a handler set that RECORDS what it was asked
 * to do, and an env scope that leaves the process as it found it. A fixture that
 * drifts in one of the two files turns a real stop into an assertion about the
 * rig.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWorkLeanVerb } from "../../src/headless/work-lean.ts";
import type { LeanRunOutcome } from "../../src/headless/work-lean.ts";
import { runWorkLean } from "../../src/lean/command.ts";
import type { LeanHandlers } from "../../src/lean/engine.ts";
import type { LeanState, Outcome, Step } from "../../src/lean/state.ts";
import { fakeRun } from "./work-lean-verb-fixture.ts";
import { runVerb } from "../headless-verb-harness.ts";
import { REPO } from "./work-lean-verb-fixture.ts";

/** The clock the cases that must NOT move use, so an env deadline in `Date.now()`
 *  terms is reliably inside their handoff allowance. */
export const CLOCK = 1_700_000_000_000;

/** Far enough out that the handoff allowance never bites: a deadline that must
 *  NOT stop anything. */
export const DAY = 24 * 60 * 60_000;

/** The env keys these cases write, restored after every case. */
export const ENV_KEYS = [
  "PI_ENSEMBLE_CYCLE_DEADLINE",
  "PI_ENSEMBLE_CYCLE_BUDGET_MS",
  "PI_ENSEMBLE_HANDOFF_CHANNEL",
] as const;

const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

/** Run `body` with exactly `vars` set for the three contract keys, then restore. */
export async function withEnv(
  vars: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  for (const k of ENV_KEYS) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    await body();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Throwaway repo roots, so each case owns its own `.pi/lean-state` file. */
const dirs: string[] = [];
export function scratch(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `lean-host-${name}-`));
  dirs.push(dir);
  return dir;
}
export function cleanScratch(): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

/**
 * A clock that crosses the deadline after `steps` engine boundaries.
 *
 * The deadline cases need a run that starts INSIDE the handoff allowance and
 * arrives at its reporting step AFTER the clock has passed: an instant drive
 * never notices the difference, and a run stopped before it reached the report
 * tests the wrong rule. A duration is resolved to an epoch by the shared reader
 * at the first boundary and persisted, so what has to move is the clock it is
 * compared against — not the arm.
 *
 * A budget has to EXCEED the handoff allowance for the early steps to be allowed
 * at all: the comparison at every boundary is `arm(now) - now <= allowance`, so
 * a budget equal to the allowance stops the run before its first step.
 */
export function crossing(steps: number): { now: () => number; past: number } {
  let n = 0;
  const start = Date.now();
  const budget = 240 * 60_000;
  const past = start + budget - 60_000;
  return {
    now: () => (n++ <= steps ? start : past),
    past,
  };
}

/** Handlers that record every call and answer whatever the table needs to keep
 *  walking. A state the case did not script throws, so a run that reached a
 *  state nobody answered is loud rather than quietly `ok`. */
export function recording(
  calls: string[],
  answers: Partial<Record<LeanState, Outcome[]>>,
): LeanHandlers {
  const handlers: LeanHandlers = {};
  for (const [state, queue] of Object.entries(answers) as [LeanState, Outcome[]][]) {
    const remaining = [...queue];
    handlers[state] = async () => {
      calls.push(state);
      const next = remaining.shift();
      if (next === undefined) throw new Error(`no scripted outcome for ${state}`);
      return next;
    };
  }
  return handlers;
}

/** The outcomes a green run's walk needs, in order. */
export const WALK: Partial<Record<LeanState, Outcome[]>> = {
  ready: [{ kind: "ok" }],
  specify: [{ kind: "ok" }],
  build: [{ kind: "ok" }, { kind: "ok" }],
  challenge: [{ kind: "none" }],
  verify: [{ kind: "green" }],
  publish: [{ kind: "ok" }],
  review: [{ kind: "done" }],
  ci: [{ kind: "green" }],
  land: [{ kind: "merged" }],
  handback: [{ kind: "done" }],
  decline: [{ kind: "done" }],
};

/**
 * A verb reply `wellFormed` accepts: `fakeRun`'s record carries no terminal
 * stamp, and the stamp is part of what makes a reply a run's answer rather than
 * a shape, so the fixture adds the one the state requires.
 */
export function wellFormedHandback(): LeanRunOutcome {
  const base = fakeRun({
    code: 10,
    state: "handed-back",
    steps: [
      {
        key: "7:handback:0",
        state: "handback",
        startedAt: CLOCK,
        endedAt: CLOCK + 1,
        outcome: { kind: "done", posted: true, reason: "handback comment posted" },
      },
    ],
  });
  return { summary: "work-lean #7: handed-back (exit 10)", result: base };
}

/**
 * Drive the verb with the standard reply and report what its injected engine saw.
 *
 * `ran` is the claim the argv cases turn on: a refusal that still called the
 * engine would run a cycle on arguments the parser refused.
 */
export async function verbRun(argv: string[], reply: LeanRunOutcome): Promise<{
  code: number;
  mode?: { headless?: boolean; timeoutMs?: number };
  ran: boolean;
  violations: string[];
}> {
  let ran = false;
  let mode: { headless?: boolean; timeoutMs?: number } | undefined;
  const r = await runVerb("work-lean", argv, REPO, (a, ctx) =>
    runWorkLeanVerb(a, ctx, async (root, issue, opts) => {
      ran = true;
      mode = opts ?? {};
      // The flag's whole job is to reach `runWorkLean`'s arming call, and that
      // call is what would drop the deadline on the floor if the verb forgot it.
      // The reply is taken from the fixture, not from this call, so no case here
      // runs a cycle; `issue: 0` keeps the real engine out of any repo's state.
      void runWorkLean(root, 0, opts).catch(() => undefined);
      return reply;
    }),
  );
  return { code: r.code, mode, ran, violations: r.violations };
}

/** The step a projection reads when a run reported to the forge. */
export function postedHandback(reason = "handback comment posted"): Step {
  return {
    key: "7:handback:0",
    state: "handback",
    startedAt: CLOCK,
    endedAt: CLOCK + 1,
    outcome: { kind: "done", posted: true, reason },
  };
}

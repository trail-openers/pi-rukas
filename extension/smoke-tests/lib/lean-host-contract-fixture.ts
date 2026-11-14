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
import { MAX_BUILD_ATTEMPTS } from "../../src/lean/machine.ts";
import {
  type LeanRun,
  type LeanState,
  type Outcome,
  type Step,
  leanStateFile,
  loadRun,
} from "../../src/lean/state.ts";
import { runVerb } from "../headless-verb-harness.ts";
import { fakeRun } from "./work-lean-verb-fixture.ts";
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
  // The verified-handback rule is read at call time and the off/on arms are pinned
  // with this scope, so it belongs to the set restored after every case.
  "PI_ENSEMBLE_LEAN_VERIFIED_HANDBACK",
  // The two switches layered on that rule are read at call time too, and their
  // off/on arms are pinned with this scope: the recording switch decides whether a
  // no-head handback names the head it shipped, and the deadline switch decides
  // whether a deadline stop routes into the report at all.
  "PI_ENSEMBLE_LEAN_HANDBACK_NOHEAD_RECORD",
  "PI_ENSEMBLE_LEAN_DEADLINE_HANDBACK",
  "PI_ENSEMBLE_CYCLE_BUDGET_MS",
  "PI_ENSEMBLE_HANDOFF_CHANNEL",
  // A case may pin the forge off for its own duration: the post seam is asserted
  // to be the WHOLE post path, which is only falsifiable when no adapter can be
  // resolved underneath it.
  "PI_ENSEMBLE_FORGE",
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
 * A clock that goes late on the boundary AFTER the run's last decided step of `at`,
 * keyed on the run's own RECORD rather than on a count of the loop's clock reads.
 *
 * `crossing` derives the stop test's read from `reads % 4`, which is exact for a drive
 * whose handlers each consume the clock once and wrong for one that does not: a step
 * that reads `ctx.now()` for its own clock (the production `review` step does, twice)
 * shifts every later boundary, and the case ends up crossing at some other step or
 * never at all — quietly, since "the report ran" looks the same either way. This form
 * asks the record where the run stands instead: it arms once the log holds more than
 * `after` DECIDED steps of `at`, which is the first read of the boundary that would
 * start the step after that verdict. The position it hands back is the same
 * `budget − shortfall` late instant `crossing` uses, so the caller's allowance test
 * reads identically.
 */
export function crossingAfter(
  opts: {
    /** The state the run must STAND IN — its newest step is the one whose outcome the
     *  loop still owes, and hence the state the NEXT boundary's stop test will judge —
     *  for the clock to go late. */
    at: LeanState;
    /** How many entries of `at` the log must hold — decided or not — before the clock may
     *  go late. The engine writes a step AHEAD of running it, and the loop's later reads
     *  of the boundary see that entry on the record, so the count is of VISITS and the
     *  `standing === at` test below is what makes the newest one the undecided head of
     *  the log. `0` means "the run stands on its FIRST entry of `at`" — which is the
     *  shape a case that stops a state's first re-entry wants; `1` waits for the second.
     *  A case that arms one visit late crosses one boundary late, and its step is then
     *  half-run at the early instant, which no real drive leaves. */
    after: number;
    /** A state the run must have gotten PAST: the clock stays early until the log
     *  holds a decided step of it. A caller that wants the stop to fall on the step
     *  AFTER `at` passes `at` here too, so the run cannot be found late on its way
     *  into the very step the premise needs undecided. `undefined` imposes no floor. */
    decidedBefore?: LeanState;
    repoRoot: string;
    issue: number;
    /** How far short of its budget the late position sits (default: 60 s). See
     *  {@link crossing}'s `shortfallMs` for why a case picks one. */
    shortfallMs?: number;
  },
): { now: () => number; past: number; crossed: () => boolean } {
  const start = Date.now();
  const budget = 240 * 60_000;
  const past = start + budget - (opts.shortfallMs ?? 60_000);
  let armed = false;
  let crossed = false;
  let reads = 0;
  return {
    now: () => {
      reads++;
      if (!armed) {
        let standing: LeanState | undefined;
        let decided = -1;
        let gotPast = -1;
        try {
          const record = loadRun(opts.repoRoot, opts.issue);
          const steps = record?.steps ?? [];
          // The run's own POSITION, read off the record's `state` — not its newest
          // step. The loop takes its deadline resolution and its stop test BEFORE it
          // writes the step ahead, so at the read that decides whether a step may start
          // the record still shows the step that just finished: newest `verify:0` and
          // `state: verify` is the run standing on its SECOND visit to the gate, which
          // is exactly the boundary a case wants stopped. Newest-step keying would
          // instead arm one read later, past the decision, and the step would be
          // half-run at the early instant — a record no real drive leaves.
          standing = record?.state;
          // Entries of `at`, verdict or not — see `after`.
          decided = steps.filter((s) => s.state === opts.at).length;
          gotPast =
            opts.decidedBefore === undefined
              ? 1
              : steps.filter((s) => s.state === opts.decidedBefore && s.outcome !== undefined)
                  .length;
        } catch {
          // An unreadable record is not a crossing — the engine's own loader is the
          // one that refuses a corrupt file, and the clock must not turn that into an
          // early deadline. Same rule `crossing` applies.
          standing = undefined;
          decided = -1;
          gotPast = -1;
        }
        const armedNow = standing === opts.at && decided > opts.after && gotPast > 0;
        // The read that ARMS is the second of the four the loop takes per step
        // (`startedAt`, `endedAt`, the deadline resolution, the stop test), which for a
        // step whose handler is a scripted queue is the STOP TEST's own read. Parity is
        // not decoration: arming on the read that stamps `startedAt` hands the loop a
        // late instant at its write-ahead, so the step is half-run at `start` — a
        // record no real drive could leave, and one whose `startedAt` would disagree
        // with the arm the case asserts against. Parity is a FLOOR rather than the whole
        // condition so a case that changes `after` and breaks it fails LOUD (the clock
        // never crosses) instead of quietly crossing one boundary early.
        // NO read-parity here, deliberately. `crossing` below pins the stop test to
        // `reads % 4`, which is exact only while every handler consumes exactly one
        // read; this rig's whole point is that it does not know what the handlers
        // between the boundaries consume. The record already says which step the loop
        // is about to judge — its `state`, plus the entries it holds — so the position
        // of the read inside the boundary carries no information the record does not.
        // Arming on the first read that satisfies the condition is therefore arming on
        // the boundary's deadline resolution, one read before the stop test that acts on
        // it: the pair answer together, which is the only way the comparison can be
        // made, and the step is never half-run at one instant and finished at another.
        if (armedNow) armed = true;
      }
      if (!armed) return start;
      crossed = true;
      return past;
    },
    past,
    // Read after the drive: a case whose run never had that verdict recorded cannot
    // read as a deadline case.
    crossed: () => crossed,
    /** How many times the loop consulted this clock — for a case that has to explain
     *  a non-crossing rather than merely assert one. */
    reads: () => reads,
  };
}

/**
 * A clock that crosses the deadline while the run stands at its REPORTING step.
 *
 * The deadline cases need a run that starts INSIDE the handoff allowance and
 * arrives at its reporting step AFTER the clock has passed: an instant drive
 * never notices the difference, and a run stopped before it reached the report
 * tests the wrong rule. A duration is resolved to an epoch by the shared reader
 * at the first boundary and persisted, so what has to move is the clock it is
 * compared against — not the arm.
 *
 * The crossing is keyed on the STEP and on the read the STOP TEST sees, not on a
 * count of ticks. Each boundary of the loop consumes four reads of this clock:
 * the one that writes the step's `startedAt`, then three after the handler
 * returns (its `endedAt`, and the two the NEXT boundary takes for the deadline
 * resolution and the stop test). So a read is the stop test's exactly when the
 * reads so far are `2 mod 4` while the run stands at `at`. That is the read
 * `deadlineStopsSteps` answers — the one that decides whether a non-exempt step
 * may start — and the one a reporting exemption has to survive. A case calibrated
 * on a tick count instead can be delivered to its report while still INSIDE the
 * allowance, where "the reporting step ran" passes identically with or without
 * the rule it advertises and the claim goes unenforced.
 *
 * The position therefore comes from the run's own RECORD (the newest step's
 * `state`, which is the step whose outcome the loop still owes and hence the
 * state the next boundary will judge), and it crosses once `times` boundaries of
 * `at` have been entered. Callers pass the REPORT's predecessor as `at`, so the
 * run enters its report already past the line.
 *
 * A budget has to EXCEED the handoff allowance for the early steps to be allowed
 * at all: the comparison at every boundary is `arm(now) - now <= allowance`, so
 * a budget equal to the allowance stops the run before its first step.
 */
export function crossing(opts: {
  /** The state whose boundaries drive the crossing: the step this case must
   *  reach on its own. The state whose run must survive the clock is normally
   *  the REPORT's predecessor — the boundary the stop test governs. */
  at: LeanState;

  /** Where the run's own record lives: the case's `repoRoot` and `issue`. */
  repoRoot: string;
  issue: number;
  /** Cross after this many boundaries AT `at` (default: the first one). */
  times?: number;
  /** How far short of its budget the late position sits (default: 60 s).
   *
   * The engine resolves and persists its arm on the FIRST boundary it sees and then
   * judges every later one as `arm − now ≤ allowance`, so the late position has to
   * land inside the caller's allowance for the stop to be a deadline stop at all —
   * and outside it for the run's early steps to be allowed to start. A drive whose
   * steps are few (a scripted walk) reaches its crossing point long before a 60 s
   * shortfall would bite, and the case silently crosses nothing; naming the gap lets
   * such a drive put the line where its own boundary is.
   */
  shortfallMs?: number;
}): { now: () => number; past: number; crossed: () => boolean } {
  const start = Date.now();
  const budget = 240 * 60_000;
  const past = start + budget - (opts.shortfallMs ?? 60_000);
  let crossed = false;
  let boundariesAtState = 0;
  // Read on EVERY clock read, so the clock cannot go stale against the position
  // the loop is about to judge. No record yet (a brand-new run) means no log, and
  // nothing has crossed.
  let run: LeanRun | undefined;
  const standingOn = (): LeanState | undefined => {
    try {
      run = loadRun(opts.repoRoot, opts.issue);
      const last = run?.steps[run.steps.length - 1];
      return last?.state;
    } catch {
      run = undefined;
      // An unreadable record is not a crossing: the engine's own loader is the
      // one that refuses a corrupt file, and the clock must not turn that into
      // an early deadline.
      return undefined;
    }
  };
  // One boundary of the loop consumes FOUR reads of this clock: the read that
  // writes the step's `startedAt`, then three after the handler returns (the
  // outcome's `endedAt`, and the two the next boundary's deadline resolution and
  // stop test take). So `count % 4 === 1` is the read the STOP TEST sees, and it
  // is only counted while the run stands at `at` — which makes the crossing
  // belong to a step of that state rather than to a number of ticks nobody owns.
  let reads = 0;
  return {
    now: () => {
      const standing = standingOn();
      // The stop test's read: two reads into a boundary (index 1 of 0,4,8… and
      // index 5 of the pre-handler offset — see the header), while the loop
      // stands at a step of `at`.
      const isStopTest = standing === opts.at && reads % 4 === 1;
      if (isStopTest) boundariesAtState++;
      const gone = boundariesAtState > (opts.times ?? 0);
      const t = gone ? past : start;
      if (t === past) crossed = true;
      reads++;
      return t;
    },
    past,
    // Read after the drive: the clock was asked for `past` at least once, so a
    // case whose run never reached `at` cannot read as a deadline case. The
    // caller's own assertions decide whether that is enough for its claim.
    crossed: () => crossed,
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

/**
 * The outcomes a green run's walk needs, in order.
 *
 * The queues are the length the TABLE makes them, not the length a reader
 * expects: a build round is billed on the edge that ENTERS `build` (see
 * `machine.ts`), so a walk that wants to reach its gate holds one `ok` per
 * round it gets — `MAX_BUILD_ATTEMPTS` of them, one challenge round included.
 * Price a shorter queue and the walk runs out mid-cycle and the step throws
 * `no scripted outcome for build`, which reads as an engine defect.
 */
export const WALK: Partial<Record<LeanState, Outcome[]>> = {
  ready: [{ kind: "ok" }],
  specify: [{ kind: "ok" }],
  build: Array.from({ length: MAX_BUILD_ATTEMPTS }, () => ({ kind: "ok" }) as Outcome),
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

/** The verb's own issue number, which no case of this suite drives a record for. */
const SCRATCH_ISSUE = 9993;

/**
 * Drive the verb with the standard reply and report what its injected engine saw.
 *
 * `ran` is the claim the argv cases turn on: a refusal that still called the
 * engine would run a cycle on arguments the parser refused. `engine` is what
 * `runWorkLean` passed on to `runLean` — the arm `--timeout` becomes, and the
 * run's mode — so the flag's DESTINATION is observed rather than inferred from
 * an env var somebody else could have written.
 */
export async function verbRun(
  argv: string[],
  reply: LeanRunOutcome,
): Promise<{
  code: number;
  mode?: { headless?: boolean; timeoutMs?: number };
  engine?: { budgetMs?: number };
  ran: boolean;
  violations: string[];
}> {
  let ran = false;
  let mode: { headless?: boolean; timeoutMs?: number } | undefined;
  let engine: { budgetMs?: number } | undefined;
  const r = await runVerb("work-lean", argv, REPO, (a, ctx) =>
    runWorkLeanVerb(a, ctx, async (root, issue, opts) => {
      ran = true;
      mode = opts ?? {};
      // The flag's whole job is to reach `runLean`'s clock as a VALUE, and the
      // record the run leaves behind is the only evidence of what the engine was
      // given: `runWorkLean` threads `--timeout` into `RunLeanOpts.budgetMs` and
      // the engine persists the epoch it resolves to. `issue: 0` puts that record
      // in the fixture's own repo and keeps the real engine out of any repo a
      // later case reads; nothing here runs a cycle — the reply is the fixture's.
      // A record left from an earlier case makes `loadRun` refuse BEFORE a step
      // runs, and the caller would then see "no arm" for a defect that has
      // nothing to do with the clock — so the scratch record is removed first and
      // the arm is read back from a file this call wrote. The issue number is one
      // no case of this suite drives, so nothing later reads the record this makes.
      rmSync(leanStateFile(root, SCRATCH_ISSUE), { force: true });
      const driven = await runWorkLean(root, SCRATCH_ISSUE, opts).catch(() => undefined);
      engine =
        driven === undefined
          ? undefined
          : { budgetMs: budgetFromArm(driven.result.run, opts?.timeoutMs) };
      return reply;
    }),
  );
  return { code: r.code, mode, engine, ran, violations: r.violations };
}

/**
 * The arm `budgetMs` must have produced, measured off the record the run wrote:
 * the persisted `deadlineMs` minus the duration the flag carried is the instant
 * the engine resolved it at, so an arm that arrived is distinguishable from one
 * that was dropped on the floor — and from an env var some other case exported.
 * `undefined` when the run recorded no arm at all.
 */
function budgetFromArm(
  run: { deadlineMs?: number },
  timeoutMs: number | undefined,
): number | undefined {
  if (run.deadlineMs === undefined || timeoutMs === undefined) return undefined;
  return run.deadlineMs - timeoutMs;
}

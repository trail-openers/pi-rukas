#!/usr/bin/env bun
/**
 * #2661 + #2660 — the re-ask's bound is armed AT THE ASK INSTANT, not frozen at the last dispatch.
 *
 * The defect: `buildOutcome` first bought its child with `armsStepBudget(buildRow,
 * stepDispatchArms(ctx, …))`, and the ask read the bound off THAT object. Between the child and the
 * ask sit the no-work re-dispatch and its provider wait — `waitOutProviderFault` sleeps in real time
 * — and `stepDispatchArms` measures the deadline's room from `ctx.now()` at the instant it is asked.
 * An object frozen before the wait therefore hands the continuation a window the deadline no longer
 * has, and the continuation child (`developer-session-continuation.ts`) runs a bare timer with NO
 * grace phase: bound + no grace means the kill lands AT the bound, so a stale bound is a kill past
 * deadline + the handoff allowance — the exact overrun #2660 was filed for, one site later.
 *
 * Both directions are asserted, because a bound that always took the smaller number would pass a
 * one-sided case:
 *   (1) a retry-then-ask visit whose clock advanced so little room is left: the continuation's
 *       `boundMs` is the deadline-derived bound, well under `BUILD_REASK_BOUND_MS`;
 *   (2) the control — the same visit with a clock that never advances and a deadline far away: the
 *       ask keeps its OWN ceiling, `BUILD_REASK_BOUND_MS`, so the clamp is not a cap that always bites.
 *
 * Real git fixture, scripted clock, no model and no child process. The provider sleep is recorded,
 * never taken (`__setLeanSleepFn`) — the convention `test-lean-step-deadline-bound-retry.ts` keeps.
 */
import { defaultConfig } from "../src/lean/config.ts";
import { BUILD_REASK_BOUND_MS } from "../src/build-reask.ts";
import { __setLeanSleepFn } from "../src/lean/provider-wait.ts";
import type { DispatchResult } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";
import { configWithRunner } from "./lib/lean-build-asserts.ts";
import { ROOTS, runBuild } from "./lib/lean-build-fixture.ts";
import { CUT, WROTE, sessionFor } from "./lib/lean-build-reask-cases.ts";
import {
	type ContinuationCalls,
	answered,
	reaskDeps,
} from "./lib/lean-build-reask-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { GOLDEN_ALLOWANCE_MS } from "./lib/lean-step-deadline-bound-off-arm.ts";

const { assert, failures } = makeAssert();

const MINUTE = 60_000;
const CELL_START = 1_700_000_000_000;
/** The cell opens 65 minutes before the build step: the deadline must leave room for a bounded
 *  child AT THE DISPATCH INSTANT (room > allowance + both grace floors) or the rule declines to
 *  clamp and the whole case scores nothing. */
const STEP_START = CELL_START + 3_900_000;
const DEADLINE = STEP_START + 1_500_000;
/** Where the ask stands: after the provider wait that the no-work retry sat out, with 12 min of
 *  deadline left — under the re-ask's 15-min ceiling, which is what makes the clamp observable. */
const ASK_AT = STEP_START + 780_000;
const ALLOWANCE = GOLDEN_ALLOWANCE_MS;
/** The room the dispatch instant must leave for the lever to arm at all. */
const MIN_ARM_ROOM = ALLOWANCE + 60_000;

const env = {
	PI_ENSEMBLE_HANDOFF_TIMEOUT_MS: String(ALLOWANCE),
	PI_ENSEMBLE_DISPATCH_CAPS: "1",
	PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND: "1",
	PI_ENSEMBLE_LEAN_BUILD_REASK: "1",
	// The ladder still fires (the retry is the point of the visit) but sleeps nothing.
	PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS: "0",
	PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS: "0",
};

/** Never sleep for real: the offline convention every no-work-retry case already keeps. */
__setLeanSleepFn(async () => true);

/** A seat LOOSER than the re-ask's own ceiling, so the ONLY thing that can shorten the ask is the
 *  deadline: a bound that took the row would be 45 min, and the case would score the clamp. */
const config = {
	...configWithRunner(),
	budgets: {
		...defaultConfig().budgets,
		build: { turns: 0, tokens: 0, minutes: 45 },
	},
};

/** A child that did nothing and died: the free re-dispatch's trigger. `errorStop` is the transient
 *  shape, so the visit takes its provider wait between the first child and the ask. */
const NO_WORK_FAULT: Partial<DispatchResult> = {
	ok: false,
	exitCode: 1,
	text: "",
	toolUses: [],
	observedToolCalls: 0,
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 1,
	},
	errorStop: { reason: "error", message: "HTTP 503 model is still loading" },
};

/** The re-asked shape: the SECOND child is the wasted turn the ask is owed. */
const CUT2: Partial<DispatchResult> = {
	...CUT,
	transcriptPath: sessionFor(2661, 2),
};

// ── (1) THE DEFECT: a retry-then-ask visit must not keep the first child's window ─
{
	const calls: ContinuationCalls = [];
	let answeredCount = 0;
	let r!: Awaited<ReturnType<typeof runBuild>>;
	await withEnv(env, async () => {
		r = await runBuild({
			issue: 2700,
			config,
			buildStartedAt: STEP_START,
			clock: {
				deadlineMs: DEADLINE,
				// The clock moves when a child ANSWERS, so the ask is armed at `ASK_AT` — after the
				// provider wait — while the first dispatch read the step's own start.
				now: () => (answeredCount === 0 ? STEP_START : ASK_AT),
			},
			dispatchResults: (n) => {
				if (n === 0) answeredCount = 1;
				return n === 0
					? { ...NO_WORK_FAULT, transcriptPath: sessionFor(2700, 1) }
					: CUT2;
			},
			reask: {
				deps: reaskDeps({
					calls,
					acts: (n, wt) => void (n === -1 && WROTE(wt)),
					answers: [answered()],
				}),
			},
		});
	});
	assert(
		r.dispatched === 2,
		`(1) precondition: the no-work child took its free re-dispatch, so a wait sits before the ask (${String(r.dispatched)})`,
	);
	assert(
		calls.length === 1,
		`(1) precondition: the wasted second turn was asked (${String(calls.length)})`,
	);
	const roomAtAsk = DEADLINE - ASK_AT - ALLOWANCE;
	assert(
		DEADLINE - STEP_START - ALLOWANCE > MIN_ARM_ROOM,
		`(1) precondition: at the DISPATCH instant the deadline left room for a bounded child, so the lever armed rather than declining (${String(DEADLINE - STEP_START - ALLOWANCE)} > ${String(MIN_ARM_ROOM)})`,
	);
	const bound = calls[0]?.boundMs ?? -1;
	assert(
		roomAtAsk > 0 && roomAtAsk < BUILD_REASK_BOUND_MS,
		`(1) precondition: at the ask instant the deadline leaves LESS than the re-ask's own ceiling (${String(roomAtAsk)} < ${String(BUILD_REASK_BOUND_MS)})`,
	);
	assert(
		bound > 0 && bound <= roomAtAsk,
		`(1) the continuation's bound is the room the deadline STILL leaves at the ask instant, not the window the last child was bought with (${String(bound)} <= ${String(roomAtAsk)})`,
	);
	assert(
		ASK_AT + bound <= DEADLINE,
		`(1) so the kill lands before the deadline — the child has no grace phase, so bound + no grace is the kill (${String(ASK_AT + bound - CELL_START)} of the cell vs the ${String(DEADLINE - CELL_START)} the cell may spend)`,
	);
	assert(
		bound < BUILD_REASK_BOUND_MS,
		`(1) and it is strictly under the re-ask's own ceiling — a bound frozen at the dispatch would be ${String(BUILD_REASK_BOUND_MS)} (${String(bound)})`,
	);
	// The two size bounds the clamp is defined by: never longer than the ask's own ceiling, and never
	// longer than the seat's row. `continuationBoundMs` is the min of the two, and a mutant that took
	// either input alone has to fail one of these lines.
	assert(
		bound <= BUILD_REASK_BOUND_MS,
		`(1a) the ask never outlives its own ceiling (${String(bound)} <= ${String(BUILD_REASK_BOUND_MS)})`,
	);
	assert(
		bound <= 45 * MINUTE,
		`(1b) nor the seat's minutes row (${String(bound)} <= ${String(45 * MINUTE)})`,
	);
}

// ── (2) the control: with plenty of room the ask keeps its own ceiling ───────────
{
	const calls: ContinuationCalls = [];
	let r!: Awaited<ReturnType<typeof runBuild>>;
	await withEnv(env, async () => {
		r = await runBuild({
			issue: 2701,
			config,
			buildStartedAt: STEP_START,
			// A deadline hours away, and a clock that never advances: the clamp must NOT bite, so this
			// case is what stops (1) from being a test of a bound that is always the smaller number.
			clock: {
				deadlineMs: STEP_START + 10 * 60 * MINUTE,
				now: () => STEP_START,
			},
			dispatchResults: () => CUT2,
			reask: {
				deps: reaskDeps({
					calls,
					acts: (n, wt) => void (n === -1 && WROTE(wt)),
					answers: [answered()],
				}),
			},
		});
	});
	assert(
		calls.length === 1,
		`(2) precondition: the wasted turn was asked (${String(calls.length)}, threw ${String(r.threw?.message)})`,
	);
	assert(
		calls[0]?.boundMs === BUILD_REASK_BOUND_MS,
		`(2) with room to spare the ask is bounded by its OWN ceiling and nothing else (${String(calls[0]?.boundMs)}, wanted ${String(BUILD_REASK_BOUND_MS)})`,
	);
}

for (const root of ROOTS) {
	// The fixture's own cleanup contract: the caller removes what it made.
	void root;
}
process.exit(failures());

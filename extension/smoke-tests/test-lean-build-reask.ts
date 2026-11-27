#!/usr/bin/env bun
/**
 * #2661 (1) — the panel row: a wasted build turn gets ONE bounded session re-ask, and the work the
 * resumed child did is what the step commits.
 *
 * The field shape: in several samples of one task the first build developer spent its whole
 * completion budget on reasoning (`stopReason: "length"`, 16,384 output tokens) and made NO tool
 * call; the step ended `exhausted: the developer produced no change` after 100–183 s and the cell
 * failed. A sibling cell ended exhausted after ONE turn with no tool call and a clean stop. The
 * existing no-work retry cannot fire for either: it needs a DEAD child (`!ok || killCause ||
 * errorStop`) and a length stop is `ok: true`, exit 0.
 *
 * Every case here drives the real `buildOutcome` through the real fixture (real git, real worktree,
 * real fold) with only the model stubbed, and asserts on what the CONTINUATION LEAF WAS HANDED — the
 * session path, bound, prompt, tree and fence — not on a fixture's own bookkeeping. The answers come
 * out of a box, not a `let`, because the fixture's fake dispatch calls the case's rule from inside an
 * async function.
 *
 * The sibling files hold the other seams: `test-lean-build-reask-refusals.ts` (the arms that are
 * never continued, and the budget that already fired), `test-lean-build-reask-asked-fails.ts` (the
 * second turn also fails, and the replayed answer), `test-lean-build-reask-ceilings.ts` (the clean
 * stop, the date-rollover guard, and the step's ceilings).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import { commitPaths, subjectsAbove } from "./lib/lean-build-asserts.ts";
import { configWithRunner } from "./lib/lean-build-asserts.ts";
import { ROOTS, runBuild } from "./lib/lean-build-fixture.ts";
import {
	CUT,
	WROTE,
	assert,
	exit,
	sessionFor,
} from "./lib/lean-build-reask-cases.ts";
import {
	type ContinuationCalls,
	answered,
	reaskDeps,
} from "./lib/lean-build-reask-fixture.ts";

/** A build seat whose minutes ceiling is LOOSER than the re-ask's own ceiling, so a bound that took
 *  the seat's instead of the smaller of the two is observed: an ask that outlives the deadline its
 *  first child was bounded by is the failure this row exists to prevent. */
const LOOSE_SEAT = {
	...configWithRunner(),
	budgets: { build: { turns: 400, tokens: 60_000_000, minutes: 120 } },
};

// ── (1) the panel row: the cut child is continued, its work is kept ─────────
{
	const calls: ContinuationCalls = [];
	const r = await runBuild({
		issue: 2661,
		// A seat of its own: the bound is the SMALLER of the seat and the re-ask's ceiling, so the case
		// hands the seat a 120-minute row and asserts the ask still ran under 15.
		config: LOOSE_SEAT,
		dispatchResults: [{ ...CUT, transcriptPath: sessionFor(2661, 1) }],
		reask: {
			deps: reaskDeps({
				calls,
				acts: (n, wt) => {
					// The FIRST child acts nowhere — that is the defect. The resumed child (-1) writes.
					if (n === -1) WROTE(wt);
				},
				answers: [answered()],
			}),
		},
	});
	assert(
		r.threw === undefined && r.outcome?.kind === "ok",
		`(1) the run the field handed back now lands (got ${r.threw?.message ?? r.outcome?.kind})`,
	);
	assert(
		commitPaths(r.worktree).join() === "src/retry.ts",
		`(1) the CONTINUATION's file is what got committed (${commitPaths(r.worktree).join(", ")})`,
	);
	assert(
		subjectsAbove(r.worktree, r.headBefore).length === 1,
		`(1) and exactly one build commit sits above the head the step found (${subjectsAbove(r.worktree, r.headBefore).join(" | ")})`,
	);
	assert(
		r.dispatched === 1,
		`(1) the step still dispatched ONE child (got ${String(r.dispatched)})`,
	);
	assert(
		calls.length === 1,
		`(1) and exactly one continuation was asked for (${String(calls.length)})`,
	);
	const call = calls[0];
	assert(
		call?.transcriptPath === sessionFor(2661, 1),
		`(1) the continuation resumed the FIRST child's own session file — a fresh child is a second opinion, not a follow-up (${JSON.stringify(call?.transcriptPath)})`,
	);
	assert(
		call?.role === "developer",
		`(1) and it ran as the builder's role, so it keeps the developer's write tools (${JSON.stringify(call?.role)})`,
	);
	assert(
		call?.cwd === r.worktree,
		`(1) and it started in the RUN'S worktree, not this process's directory (${JSON.stringify(call?.cwd)})`,
	);
	assert(
		call?.writeFence?.root === r.worktree &&
			typeof call?.writeFence?.repo === "string" &&
			call.writeFence.repo.length > 0 &&
			(call.writeFence.scratch ?? "").includes("tmp/"),
		`(1) and it carries the SAME fence its parent was fenced by — root, repo and scratch (${JSON.stringify(call?.writeFence)})`,
	);
	assert(
		typeof call?.prompt === "string" &&
			call.prompt.includes("output budget") &&
			call.prompt.includes("tool calls") &&
			call.prompt.includes("reasoning short"),
		`(1) and the prompt says the previous turn ran out of output budget on reasoning and must act now (${JSON.stringify((call?.prompt ?? "").slice(0, 60))})`,
	);
	assert(
		(call?.boundMs ?? 0) > 0 && call?.boundMs <= 15 * 60_000,
		`(1) and it ran under the SMALLER of its own ceiling and the seat's 120-minute row (${String(call?.boundMs)})`,
	);
	const rows = r.outcome?.dispatches ?? [];
	assert(
		rows.length === 2 && rows[1]?.role === "developer",
		`(1) the continuation is ONE extra cost row beside the child's own (${JSON.stringify(rows.map((x) => x.role))})`,
	);
	assert(
		(r.outcome?.reason ?? "").startsWith("1 file(s) changed"),
		`(1) and the reason is an ordinary ok verdict's, not an exhausted one (${r.outcome?.reason})`,
	);
	assert(
		existsSync(path.join(r.worktree, "src/retry.ts")),
		"(1) precondition: the file is on disk after the step",
	);
}

// ── (1b) the same bound again with the seat TIGHTER than the re-ask's ceiling ─
{
	// `continuationBoundMs` is the clamp, and a call that ignored it would still pass (1)'s line above
	// (15 min sits under both), so the tighter seat is asserted on its own visit.
	const tight: ContinuationCalls = [];
	const tightRun = await runBuild({
		issue: 2661,
		config: {
			...configWithRunner(),
			budgets: { build: { turns: 400, tokens: 60_000_000, minutes: 4 } },
		},
		dispatchResults: [{ ...CUT, transcriptPath: sessionFor(2661, 1) }],
		reask: { deps: reaskDeps({ calls: tight, answers: [answered()] }) },
	});
	assert(
		tight.length === 1 &&
			(tight[0]?.boundMs ?? 0) > 0 &&
			tight[0].boundMs <= 4 * 60_000,
		`(1) and a TIGHTER seat wins: the ask is bounded by the step's armed budget, not its own ceiling
     (${String(tight[0]?.boundMs)}, ${String(tightRun.threw?.message)})`,
	);
}

for (const root of ROOTS) {
	// The fixture's own cleanup contract: the caller removes what it made.
	void root;
}
process.exit(exit);

#!/usr/bin/env bun
/**
 * #2661 (4) + (5) + (7) — the shapes around the ask that must not move the step's ceilings.
 *
 * Split out of `test-lean-build-reask.ts` for the CI per-file ceiling: each case pays for a real git
 * repo and worktree, so the seam gets its own file.
 *
 * (4) T2: a child that stopped CLEANLY after one turn, made no tool call and changed nothing. It is
 * not the length-capped shape, but the observable is the same — a whole turn bought, nothing to show
 * for it — so it earns the same one ask, and its prompt says the tree is unchanged.
 *
 * (5) The date-rollover guard: the child's `transcriptPath` is absent, so there is nothing to resume.
 * The ask is refused BEFORE a child is paid for — no row, no clause, and the reason stays today's. A
 * fresh spawn that never read the first turn is worse than today's exhaustion.
 *
 * (7) The ask is one cost row, not a round. The step's dispatch count, its single commit and its
 * refused-arm commit count are what they were before the ask existed.
 */
import { git } from "./lib/lean-build-git.ts";
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
	refused,
	silent,
} from "./lib/lean-build-reask-fixture.ts";
import { commitPaths } from "./lib/lean-build-asserts.ts";

// ── (4) T2: one clean turn, no tool call, no change ─────────────────────────
{
	const calls: ContinuationCalls = [];
	const r = await runBuild({
		issue: 2682,
		dispatchResults: [
			{
				ok: true,
				exitCode: 0,
				stopReason: "stop",
				toolUses: [],
				observedToolCalls: 0,
				usage: {
					input: 40,
					output: 200,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0.02,
					turns: 1,
				},
				transcriptPath: sessionFor(2682, 1),
			},
		],
		reask: {
			deps: reaskDeps({
				calls,
				acts: (n, wt) => void (n === -1 && WROTE(wt)),
				answers: [answered()],
			}),
		},
	});
	assert(
		calls.length === 1,
		`(4) a clean stop with no tool call and no fold change gets the same one ask (${String(calls.length)})`,
	);
	assert(
		r.outcome?.kind === "ok" &&
			commitPaths(r.worktree).join() === "src/retry.ts",
		`(4) and the change the resumed child made is kept (${r.threw?.message ?? `${String(r.outcome?.kind)}: ${commitPaths(r.worktree).join(",")}`})`,
	);
	assert(
		(calls[0]?.prompt ?? "").includes("unchanged") &&
			(calls[0]?.prompt ?? "").includes("tool call"),
		`(4) and its prompt says the tree is unchanged and names the missing tool call (${JSON.stringify((calls[0]?.prompt ?? "").slice(0, 60))})`,
	);
}

// ── (5) the date-rollover guard: no session path, so no ask and nothing billed ─
{
	const calls: ContinuationCalls = [];
	const r = await runBuild({
		issue: 2683,
		// The field's shape, but with no transcript path to resume — the ask must be refused before a
		// child is paid for, not answered by a fresh spawn that never read the first turn.
		dispatchResults: [{ ...CUT }],
		reask: {
			deps: reaskDeps({ calls, acts: (n, wt) => void (n === -1 && WROTE(wt)) }),
		},
	});
	assert(
		calls.length === 0,
		`(5) no session path means no continuation call at all (${String(calls.length)})`,
	);
	assert(
		r.outcome?.kind === "exhausted",
		`(5) and the step ends exhausted as today (${r.threw?.message ?? String(r.outcome?.kind)})`,
	);
	assert(
		r.outcome?.reason === "the developer produced no change",
		`(5) with today's reason — an ask that never happened bills no clause (${JSON.stringify(r.outcome?.reason)})`,
	);
	assert(
		(r.outcome?.dispatches ?? []).length === 1,
		`(5) and the refused ask billed no row (${String((r.outcome?.dispatches ?? []).length)})`,
	);
}

// ── (5b) a seam that refused WITHOUT spawning bills nothing and spends nothing ─
for (const reason of ["no-session", "unverified-role", "spawn-failed"] as const) {
	const calls: ContinuationCalls = [];
	const r = await runBuild({
		issue: 2687,
		dispatchResults: [{ ...CUT, transcriptPath: sessionFor(2687, 1) }],
		reask: { deps: reaskDeps({ calls, answers: [refused(reason)] }) },
	});
	assert(
		r.threw === undefined && r.outcome?.kind === "exhausted",
		`(5b) a seam that answered ${reason} still ends the visit (${r.threw?.message ?? String(r.outcome?.kind)})`,
	);
	assert(
		(r.outcome?.dispatches ?? []).length === 1,
		`(5b) and ${reason} billed no row — no child was ever bought (${String((r.outcome?.dispatches ?? []).length)})`,
	);
	assert(
		r.outcome?.reason === "the developer produced no change",
		`(5b) with today's reason: an ask that never happened earns no clause (${JSON.stringify(r.outcome?.reason)})`,
	);
}

// ── (7) the ask never extends the step's ceilings ────────────────────────────
{
	// Two runs, one env: the ask is billed as a row but the step's dispatch count, its single commit
	// and its round billing are what they were before the ask existed.
	const calls: ContinuationCalls = [];
	const asked = await runBuild({
		issue: 2685,
		dispatchResults: [{ ...CUT, transcriptPath: sessionFor(2685, 1) }],
		reask: {
			deps: reaskDeps({
				calls,
				acts: (n, wt) => void (n === -1 && WROTE(wt)),
				answers: [answered()],
			}),
		},
	});
	const unasked = await runBuild({
		issue: 2686,
		dispatchResults: [{ ...CUT, transcriptPath: sessionFor(2686, 1) }],
		reask: { deps: reaskDeps({ calls: [], answers: [silent()] }) },
	});
	assert(
		asked.dispatched === 1 && unasked.dispatched === 1,
		`(7) neither visit dispatched more than its own child (${String(asked.dispatched)}/${String(unasked.dispatched)})`,
	);
	assert(
		git(asked.worktree, "rev-list", "--count", `${asked.headBefore}..HEAD`) ===
			"1",
		"(7) the continued visit made exactly one commit",
	);
	assert(
		git(
			unasked.worktree,
			"rev-list",
			"--count",
			`${unasked.headBefore}..HEAD`,
		) === "0",
		"(7) and the refused visit made none",
	);
}

for (const root of ROOTS) {
	// The fixture's own cleanup contract: the caller removes what it made.
	void root;
}
process.exit(exit);
